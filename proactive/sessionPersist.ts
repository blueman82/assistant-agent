// Bridge-only session persistence. Schema v2 records both the live SDK
// session and the last assistant message that completed cleanly. If a process
// exits while a turn is being cancelled, the tainted marker gives startup
// enough information to fork the transcript back to that checkpoint before
// accepting more work.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type SessionAbortReason = "deadline" | "stop" | "shutdown";

export type PersistedSession = {
  sessionId: string;
  lastCompletedAssistantMessageId?: string;
} & (
  | { state: "active"; abortReason?: never }
  | { state: "tainted"; abortReason: SessionAbortReason }
);

interface SessionFileV1 {
  schema_version: 1;
  session_id: string;
}

interface SessionFileV2 {
  schema_version: 2;
  session_id: string;
  last_completed_assistant_message_id: string | null;
  state: "active" | "tainted";
  abort_reason: SessionAbortReason | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string, detail: string): never {
  throw new Error(`corrupt session file ${path}: ${detail}`);
}

// Only ENOENT means "no persisted session yet". Corrupt, unreadable, or
// schema-invalid state fails loudly because silently starting fresh would
// hide loss of the bridge's conversation pointer.
export function readSession(path: string): PersistedSession | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`corrupt session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) invalid(path, "expected an object");

  if (parsed["schema_version"] === 1) {
    const v1 = parsed as unknown as SessionFileV1;
    if (typeof v1.session_id !== "string" || !v1.session_id) invalid(path, "schema v1 session_id must be a non-empty string");
    // Compatibility is intentionally in-memory only. The next successful
    // turn writes schema v2 with its first clean checkpoint.
    return { sessionId: v1.session_id, state: "active" };
  }

  if (parsed["schema_version"] !== 2) invalid(path, `unsupported schema_version ${String(parsed["schema_version"])}`);
  const v2 = parsed as unknown as SessionFileV2;
  if (typeof v2.session_id !== "string" || !v2.session_id) invalid(path, "schema v2 session_id must be a non-empty string");
  if (
    v2.last_completed_assistant_message_id !== null &&
    (typeof v2.last_completed_assistant_message_id !== "string" || !v2.last_completed_assistant_message_id)
  ) {
    invalid(path, "last_completed_assistant_message_id must be a non-empty string or null");
  }
  if (v2.state !== "active" && v2.state !== "tainted") invalid(path, "state must be active or tainted");
  if (v2.state === "active" && v2.abort_reason !== null) invalid(path, "active state must have a null abort_reason");
  if (v2.state === "tainted" && !["deadline", "stop", "shutdown"].includes(String(v2.abort_reason))) {
    invalid(path, "tainted state must have a valid abort_reason");
  }

  const checkpoint = v2.last_completed_assistant_message_id ?? undefined;
  return v2.state === "active"
    ? { sessionId: v2.session_id, lastCompletedAssistantMessageId: checkpoint, state: "active" }
    : {
        sessionId: v2.session_id,
        lastCompletedAssistantMessageId: checkpoint,
        state: "tainted",
        abortReason: v2.abort_reason as SessionAbortReason,
      };
}

// Temp-file + same-directory rename makes session id, checkpoint, and taint
// state one atomic ownership record. A restarting bridge never sees a new
// session pointer paired with an old checkpoint.
export function writeSession(path: string, session: PersistedSession): void {
  mkdirSync(dirname(path), { recursive: true });
  const data: SessionFileV2 = {
    schema_version: 2,
    session_id: session.sessionId,
    last_completed_assistant_message_id: session.lastCompletedAssistantMessageId ?? null,
    state: session.state,
    abort_reason: session.state === "tainted" ? session.abortReason : null,
  };
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, path);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

export function clearSession(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot clear session file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
