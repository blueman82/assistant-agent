import { randomUUID } from "node:crypto";
import { AgentError, type AgentInput, type AgentSession, type SessionOptions, type StopReason, type TurnEvent } from "../core/contracts.ts";
import type { Codex, Thread, ThreadEvent } from "@openai/codex-sdk";
import type { ProviderRuntime, ProviderRuntimeStatus } from "./types.ts";
import { stopReasonFromAbort } from "./stop-reason.ts";

export interface CodexRuntimeOptions { readonly cwd?: string; readonly model?: string; readonly resumeThreadId?: string }
type CodexModule = typeof import("@openai/codex-sdk");

async function loadCodex(): Promise<CodexModule> {
  try { return await import("@openai/codex-sdk"); }
  catch { throw new AgentError("runtime_unavailable", "The official @openai/codex-sdk package is not installed"); }
}

function eventError(message: string): AgentError { return new AgentError("provider_error", message, /rate|timeout|temporar/i.test(message)); }

class CodexSession implements AgentSession {
  readonly id = randomUUID();
  private controller?: AbortController;
  private thread: Thread;

  constructor(thread: Thread) { this.thread = thread; }

  async *run(input: AgentInput): AsyncIterable<TurnEvent> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    yield { type: "started", sessionId: this.id, turnId };
    try {
      const stream = await this.thread.runStreamed(input.text, { signal: controller.signal });
      for await (const event of stream.events) yield* this.normalize(event, turnId);
    } catch (error) {
      if (controller.signal.aborted) yield { type: "stopped", sessionId: this.id, turnId, reason: stopReasonFromAbort(controller.signal.reason) };
      else yield { type: "error", sessionId: this.id, turnId, error: error instanceof AgentError ? error : eventError(error instanceof Error ? error.message : String(error)) };
    } finally { this.controller = undefined; }
  }

  private *normalize(event: ThreadEvent, turnId: string): Iterable<TurnEvent> {
    const base = { sessionId: this.id, turnId };
    if (event.type === "item.completed" && event.item.type === "agent_message") yield { type: "text", ...base, text: String(event.item.text ?? "") };
    if (event.type === "item.started" && event.item.type === "command_execution") yield { type: "tool_call", ...base, request: { toolName: "command_execution", input: event.item.command } };
    if (event.type === "turn.completed") yield { type: "usage", ...base, usage: { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, totalTokens: event.usage.input_tokens + event.usage.output_tokens } }, { type: "completed", ...base };
    if (event.type === "turn.failed") yield { type: "error", ...base, error: eventError(event.error.message) };
    if (event.type === "error") yield { type: "error", ...base, error: eventError(event.message) };
  }

  async reset(): Promise<void> { this.controller?.abort("reset"); }
  async stop(reason: StopReason = "user"): Promise<void> { this.controller?.abort(reason); }
}

export class CodexRuntime implements ProviderRuntime {
  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  async checkAvailability(): Promise<ProviderRuntimeStatus> {
    try { await loadCodex(); return { provider: "codex", authenticated: true }; }
    catch (error) { return { provider: "codex", authenticated: false, message: error instanceof Error ? error.message : String(error) }; }
  }

  async startSession(_options: SessionOptions = {}): Promise<AgentSession> {
    const { Codex: CodexSdk } = await loadCodex();
    const codex: Codex = new CodexSdk();
    const thread = this.options.resumeThreadId
      ? codex.resumeThread(this.options.resumeThreadId, { workingDirectory: this.options.cwd, model: this.options.model })
      : codex.startThread({ workingDirectory: this.options.cwd, model: this.options.model });
    return new CodexSession(thread);
  }
}

export const createCodexRuntime = (options?: CodexRuntimeOptions): ProviderRuntime => new CodexRuntime(options);
