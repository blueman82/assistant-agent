import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentError, type AgentInput, type AgentSession, type TurnEvent } from "./contracts.ts";
import { MemoryStore, type TurnLease } from "./memory.ts";

export interface MemoryContextTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt?: string;
}

export interface MemoryContextItem {
  readonly text: string;
  readonly source?: string;
  readonly updatedAt?: string;
}

export interface MemoryContext {
  readonly conversation: readonly MemoryContextTurn[];
  readonly memories: readonly MemoryContextItem[];
}

export interface RachelMemoryService {
  remember(text: string): Promise<void>;
  forget(query: string): Promise<void>;
  resetConversation(): Promise<void>;
  run(session: AgentSession, input: AgentInput): AsyncIterable<TurnEvent>;
}

function automaticMemories(text: string): Array<{ kind: "fact" | "preference"; content: string }> {
  // ponytail: bounded regex extraction stays local and deterministic; add a validated background model job when recall misses justify it.
  const match = /^(?:i prefer|i like|my preference is)\s+(.+)$/iu.exec(text.trim());
  if (match?.[1]) return [{ kind: "preference", content: match[1].trim() }];
  const fact = /^my\s+(.+?)\s+is\s+(.+)$/iu.exec(text.trim());
  return fact ? [{ kind: "fact", content: `${fact[1]!.trim()} is ${fact[2]!.trim()}` }] : [];
}

class LocalRachelMemory implements RachelMemoryService {
  readonly #store: MemoryStore;
  readonly #conversationId: string;

  constructor(store: MemoryStore, conversationId = "default") {
    this.#store = store;
    this.#conversationId = conversationId;
  }

  async remember(text: string): Promise<void> {
    this.#store.remember({ kind: "fact", content: text, source: "explicit" });
  }

  async forget(query: string): Promise<void> {
    for (const memory of this.#store.searchMemories(query)) this.#store.forgetMemory(memory.id);
  }

  async resetConversation(): Promise<void> {
    this.#store.clearConversation(this.#conversationId);
  }

  async *run(session: AgentSession, input: AgentInput): AsyncIterable<TurnEvent> {
    const ownerId = randomUUID();
    const lease = this.#store.acquireTurnLease(this.#conversationId, ownerId);
    if (!lease) throw new AgentError("conversation_busy", "Rachel is busy in another runtime");
    const turnId = randomUUID();
    let currentLease: TurnLease = lease;
    const renewal = setInterval(() => {
      const renewed = this.#store.renewTurnLease(currentLease);
      if (renewed) currentLease = renewed;
    }, 10_000);
    renewal.unref();
    const context = this.#contextFor(input.text);
    const userEvent = this.#store.appendConversationEvent({ conversationId: this.#conversationId, turnId, role: "user", content: input.text }, currentLease);
    let response = "";
    try {
      const contextual = session as AgentSession & { run(value: AgentInput & { context: MemoryContext }): AsyncIterable<TurnEvent> };
      for await (const event of contextual.run({ ...input, context })) {
        if (event.type === "text") response += event.text;
        if (event.type === "completed") {
          this.#store.appendConversationEvent({ conversationId: this.#conversationId, turnId, role: "assistant", content: response }, currentLease);
          for (const memory of automaticMemories(input.text)) this.#store.remember({ ...memory, source: "automatic", sourceEventId: userEvent.id });
        }
        yield event;
      }
    } finally {
      clearInterval(renewal);
      this.#store.releaseTurnLease(currentLease);
    }
  }

  #contextFor(query: string): MemoryContext {
    const words = query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    const memories = new Map<string, MemoryContextItem>();
    for (const word of words) for (const memory of this.#store.searchMemories(word)) {
      memories.set(memory.id, { text: memory.content, source: memory.source, updatedAt: memory.updatedAt });
    }
    return {
      conversation: this.#store.listConversationEvents(this.#conversationId, 20)
        .filter((event) => event.role === "user" || event.role === "assistant")
        .map((event) => ({ role: event.role as "user" | "assistant", text: event.content, createdAt: event.createdAt })),
      memories: [...memories.values()].slice(0, 12),
    };
  }
}

export function createRachelMemory(store: MemoryStore, conversationId?: string): RachelMemoryService {
  return new LocalRachelMemory(store, conversationId);
}

export async function openRachelMemory(env: NodeJS.ProcessEnv = process.env): Promise<{ store: MemoryStore; memory: RachelMemoryService }> {
  const directory = env.RACHEL_DATA_DIR ?? join(homedir(), ".rachel");
  await mkdir(directory, { recursive: true });
  const store = new MemoryStore(join(directory, "rachel.db"));
  return { store, memory: createRachelMemory(store, env.RACHEL_CONVERSATION_ID) };
}
