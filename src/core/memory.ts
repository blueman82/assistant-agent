import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type MemoryKind = "fact" | "preference" | "decision" | "procedure";
export type ConversationRole = "user" | "assistant" | "system" | "tool";

export interface ConversationEventInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly metadata?: unknown;
}

export interface ConversationEvent extends ConversationEventInput {
  readonly id: number;
  readonly createdAt: string;
}

export interface MemoryInput {
  readonly namespace?: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly source?: string;
  readonly sourceEventId?: number;
  readonly confidence?: number;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface DurableMemory extends MemoryInput {
  readonly id: string;
  readonly namespace: string;
  readonly confidence: number;
  readonly version: number;
  readonly supersededBy?: string;
  readonly deletedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnLease {
  readonly conversationId: string;
  readonly ownerId: string;
  readonly token: string;
  readonly expiresAt: number;
}

type Row = Record<string, unknown>;

const migrations = [
  `CREATE TABLE conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX conversation_events_conversation_created
    ON conversation_events (conversation_id, id)`,
  `CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'procedure')),
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    source_event_id INTEGER REFERENCES conversation_events(id),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from TEXT,
    valid_to TEXT,
    superseded_by TEXT REFERENCES memories(id),
    deleted_at TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX memories_active_search
    ON memories (namespace, deleted_at, superseded_by, updated_at)`,
  `CREATE TABLE turn_leases (
    conversation_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE conversation_state (
    conversation_id TEXT PRIMARY KEY,
    reset_event_id INTEGER NOT NULL DEFAULT 0
  )`,
];

function now(): string {
  return new Date().toISOString();
}

function rowToEvent(row: Row): ConversationEvent {
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    role: String(row.role) as ConversationRole,
    content: String(row.content),
    ...(row.metadata_json === null ? {} : { metadata: JSON.parse(String(row.metadata_json)) }),
    createdAt: String(row.created_at),
  };
}

function rowToMemory(row: Row): DurableMemory {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    kind: String(row.kind) as MemoryKind,
    content: String(row.content),
    source: String(row.source),
    ...(row.source_event_id === null ? {} : { sourceEventId: Number(row.source_event_id) }),
    confidence: Number(row.confidence),
    ...(row.valid_from === null ? {} : { validFrom: String(row.valid_from) }),
    ...(row.valid_to === null ? {} : { validTo: String(row.valid_to) }),
    ...(row.superseded_by === null ? {} : { supersededBy: String(row.superseded_by) }),
    ...(row.deleted_at === null ? {} : { deletedAt: String(row.deleted_at) }),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class MemoryStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  appendConversationEvent(input: ConversationEventInput, lease?: TurnLease): ConversationEvent {
    if (lease) this.#assertLease(lease);
    const createdAt = now();
    const result = this.#db.prepare(
      `INSERT INTO conversation_events
       (conversation_id, turn_id, role, content, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.conversationId, input.turnId, input.role, input.content,
      input.metadata === undefined ? null : JSON.stringify(input.metadata), createdAt);
    return { id: Number(result.lastInsertRowid), ...input, createdAt };
  }

  listConversationEvents(conversationId: string, limit?: number): ConversationEvent[] {
    const rows = (limit === undefined
      ? this.#db.prepare("SELECT * FROM conversation_events WHERE conversation_id = ? AND id > COALESCE((SELECT reset_event_id FROM conversation_state WHERE conversation_id = ?), 0) ORDER BY id")
      : this.#db.prepare("SELECT * FROM conversation_events WHERE conversation_id = ? AND id > COALESCE((SELECT reset_event_id FROM conversation_state WHERE conversation_id = ?), 0) ORDER BY id DESC LIMIT ?"))
      .all(conversationId, conversationId, ...(limit === undefined ? [] : [limit])) as Row[];
    return (limit === undefined ? rows : rows.reverse()).map(rowToEvent);
  }

  clearConversation(conversationId: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM conversation_events WHERE conversation_id = ?").get(conversationId) as Row;
      this.#db.prepare(
        `INSERT INTO conversation_state (conversation_id, reset_event_id) VALUES (?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET reset_event_id = excluded.reset_event_id`,
      ).run(conversationId, Number(row.id));
      this.#db.prepare("DELETE FROM turn_leases WHERE conversation_id = ?").run(conversationId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  remember(input: MemoryInput): DurableMemory {
    return this.#remember(input, 1);
  }

  #remember(input: MemoryInput, version: number): DurableMemory {
    if (!input.content.trim()) throw new Error("memory content must not be empty");
    const confidence = input.confidence ?? 1;
    if (confidence < 0 || confidence > 1) throw new Error("memory confidence must be between 0 and 1");
    const timestamp = now();
    const memory: DurableMemory = {
      id: randomUUID(), namespace: input.namespace ?? "default", kind: input.kind,
      content: input.content, source: input.source ?? "explicit", confidence,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      version, createdAt: timestamp, updatedAt: timestamp,
    };
    this.#db.prepare(
      `INSERT INTO memories
       (id, namespace, kind, content, source, source_event_id, confidence, valid_from, valid_to,
        superseded_by, deleted_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(memory.id, memory.namespace, memory.kind, memory.content, input.source ?? "explicit",
      input.sourceEventId ?? null, memory.confidence, input.validFrom ?? null, input.validTo ?? null,
      memory.version, memory.createdAt, memory.updatedAt);
    return memory;
  }

  reviseMemory(id: string, input: MemoryInput): DurableMemory {
    const current = this.getMemory(id);
    if (!current || current.deletedAt || current.supersededBy) throw new Error("memory is not active");
    const replacement = this.#remember({ ...input, namespace: input.namespace ?? current.namespace }, current.version + 1);
    this.#db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(replacement.id, replacement.updatedAt, id);
    return replacement;
  }

  forgetMemory(id: string): boolean {
    const result = this.#db.prepare(
      "UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL",
    ).run(now(), now(), id);
    return result.changes === 1;
  }

  getMemory(id: string): DurableMemory | undefined {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row && rowToMemory(row);
  }

  searchMemories(query: string, namespace = "default"): DurableMemory[] {
    // ponytail: indexed LIKE search is enough for one local owner; add FTS/semantic retrieval when memory volume makes recall measurably poor.
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return (this.#db.prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND deleted_at IS NULL AND superseded_by IS NULL
       AND content LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`,
    ).all(namespace, pattern) as Row[]).map(rowToMemory);
  }

  acquireTurnLease(conversationId: string, ownerId: string, ttlMs = 30_000): TurnLease | undefined {
    if (ttlMs <= 0) throw new Error("lease ttl must be positive");
    const acquiredAt = Date.now();
    const lease: TurnLease = { conversationId, ownerId, token: randomUUID(), expiresAt: acquiredAt + ttlMs };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM turn_leases WHERE expires_at <= ?").run(acquiredAt);
      const existing = this.#db.prepare("SELECT 1 FROM turn_leases WHERE conversation_id = ?").get(conversationId);
      if (existing) {
        this.#db.exec("ROLLBACK");
        return undefined;
      }
      this.#db.prepare(
        "INSERT INTO turn_leases (conversation_id, owner_id, token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(lease.conversationId, lease.ownerId, lease.token, acquiredAt, lease.expiresAt);
      this.#db.exec("COMMIT");
      return lease;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  renewTurnLease(lease: TurnLease, ttlMs = 30_000): TurnLease | undefined {
    this.#assertLease(lease);
    const expiresAt = Date.now() + ttlMs;
    const result = this.#db.prepare(
      "UPDATE turn_leases SET expires_at = ? WHERE conversation_id = ? AND owner_id = ? AND token = ? AND expires_at > ?",
    ).run(expiresAt, lease.conversationId, lease.ownerId, lease.token, Date.now());
    return result.changes === 1 ? { ...lease, expiresAt } : undefined;
  }

  releaseTurnLease(lease: TurnLease): boolean {
    return this.#db.prepare("DELETE FROM turn_leases WHERE conversation_id = ? AND owner_id = ? AND token = ?")
      .run(lease.conversationId, lease.ownerId, lease.token).changes === 1;
  }

  #assertLease(lease: TurnLease): void {
    const row = this.#db.prepare(
      "SELECT 1 FROM turn_leases WHERE conversation_id = ? AND owner_id = ? AND token = ? AND expires_at > ?",
    ).get(lease.conversationId, lease.ownerId, lease.token, Date.now());
    if (!row) throw new Error("turn lease is missing or expired");
  }

  #migrate(): void {
    this.#db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set((this.#db.prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Row[]).map((row) => Number(row.version)));
    for (let index = 0; index < migrations.length; index += 1) {
      const version = index + 1;
      if (applied.has(version)) continue;
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(migrations[index]);
        this.#db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now());
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
