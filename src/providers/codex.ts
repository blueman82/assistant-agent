import { randomUUID } from "node:crypto";
import { AgentError, type AgentInput, type AgentSession, type SessionOptions, type StopReason, type TurnEvent } from "../core/contracts.ts";
import type { Codex, ThreadEvent } from "@openai/codex-sdk";
import type { ProviderRuntime, ProviderRuntimeStatus } from "./types.ts";
import { stopReasonFromAbort } from "./stop-reason.ts";
import { providerPrompt, type ProviderInput } from "./context.ts";

export interface CodexRuntimeOptions { readonly cwd?: string; readonly model?: string }
type CodexModule = typeof import("@openai/codex-sdk");

async function loadCodex(): Promise<CodexModule> {
  try { return await import("@openai/codex-sdk"); }
  catch { throw new AgentError("runtime_unavailable", "The official @openai/codex-sdk package is not installed"); }
}

function eventError(message: string): AgentError { return new AgentError("provider_error", message, /rate|timeout|temporar/i.test(message)); }

class CodexSession implements AgentSession {
  readonly id = randomUUID();
  private controller?: AbortController;
  private readonly codex: Codex;
  private readonly options: CodexRuntimeOptions;

  constructor(codex: Codex, options: CodexRuntimeOptions) { this.codex = codex; this.options = options; }

  async *run(input: ProviderInput): AsyncIterable<TurnEvent> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    yield { type: "started", sessionId: this.id, turnId };
    try {
      const thread = this.codex.startThread({ workingDirectory: this.options.cwd, model: this.options.model });
      const stream = await thread.runStreamed(providerPrompt(input), { signal: controller.signal });
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
  async stop(reason: StopReason = "user"): Promise<boolean> {
    const active = this.controller !== undefined;
    this.controller?.abort(reason);
    return active;
  }
}

export class CodexRuntime implements ProviderRuntime {
  private readonly options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions = {}) { this.options = options; }

  async checkAvailability(): Promise<ProviderRuntimeStatus> {
    try { await loadCodex(); return { provider: "codex", authenticated: true }; }
    catch (error) { return { provider: "codex", authenticated: false, message: error instanceof Error ? error.message : String(error) }; }
  }

  async startSession(_options: SessionOptions = {}): Promise<AgentSession> {
    const { Codex: CodexSdk } = await loadCodex();
    const codex: Codex = new CodexSdk();
    return new CodexSession(codex, this.options);
  }
}

export const createCodexRuntime = (options?: CodexRuntimeOptions): ProviderRuntime => new CodexRuntime(options);
