import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { query, startup, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentError, type AgentInput, type AgentSession, type SessionOptions, type StopReason, type TurnEvent, type Usage } from "../core/contracts.ts";
import type { ProviderRuntime, ProviderRuntimeStatus } from "./types.ts";
import { stopReasonFromAbort } from "./stop-reason.ts";

export interface ClaudeRuntimeOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeSessionId?: string;
}

function errorFrom(value: unknown, code = "provider_error"): AgentError {
  const message = value instanceof Error ? value.message : String(value);
  return new AgentError(code, message, /rate|overload|timeout|temporar/i.test(message));
}

async function promptFor(input: AgentInput): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (!input.attachments?.length) return input.text;
  const content: SDKUserMessage["message"]["content"] = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments) {
    const data = (await readFile(attachment.path)).toString("base64");
    if (attachment.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: imageMime(attachment.mimeType), data } });
    else content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
  }
  return (async function* (): AsyncIterable<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  })();
}

function imageMime(value: string | undefined): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return value === "image/jpeg" || value === "image/gif" || value === "image/webp" ? value : "image/png";
}

function usage(value: SDKMessage): Usage | undefined {
  if (value.type !== "result") return undefined;
  return { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens, totalTokens: value.usage.input_tokens + value.usage.output_tokens };
}

class ClaudeSession implements AgentSession {
  readonly id = randomUUID();
  private readonly options: ClaudeRuntimeOptions;
  private active?: ReturnType<typeof query>;
  private controller?: AbortController;
  private providerSessionId?: string;

  constructor(options: ClaudeRuntimeOptions, resumeSessionId?: string) {
    this.options = options;
    this.providerSessionId = resumeSessionId;
  }

  async *run(input: AgentInput): AsyncIterable<TurnEvent> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    const options = { cwd: this.options.cwd, model: this.options.model, resume: this.providerSessionId, abortController: controller };
    yield { type: "started", sessionId: this.id, turnId };
    try {
      this.active = query({ prompt: await promptFor(input), options });
      for await (const message of this.active) {
        if (message.type === "assistant") {
          this.providerSessionId = message.session_id;
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) yield { type: "text", sessionId: this.id, turnId, text: block.text };
            if (block.type === "tool_use") yield { type: "tool_call", sessionId: this.id, turnId, request: { toolName: block.name, input: block.input } };
          }
        }
        if (message.type === "result") {
          this.providerSessionId = message.session_id;
          const currentUsage = usage(message);
          if (currentUsage) yield { type: "usage", sessionId: this.id, turnId, usage: currentUsage };
          if (message.subtype === "success") yield { type: "completed", sessionId: this.id, turnId };
          else yield { type: "error", sessionId: this.id, turnId, error: new AgentError(message.subtype, message.errors.join("; ")) };
        }
      }
    } catch (error) {
      if (controller.signal.aborted) yield { type: "stopped", sessionId: this.id, turnId, reason: stopReasonFromAbort(controller.signal.reason) };
      else yield { type: "error", sessionId: this.id, turnId, error: errorFrom(error) };
    } finally {
      this.active = undefined;
      this.controller = undefined;
    }
  }

  async reset(): Promise<void> { this.active?.close(); this.controller?.abort(); this.providerSessionId = undefined; }
  async stop(reason: StopReason = "user"): Promise<boolean> {
    const active = this.controller !== undefined;
    this.active?.close();
    this.controller?.abort(reason);
    return active;
  }
}

export class ClaudeRuntime implements ProviderRuntime {
  private readonly options: ClaudeRuntimeOptions;

  constructor(options: ClaudeRuntimeOptions = {}) { this.options = options; }

  async checkAvailability(): Promise<ProviderRuntimeStatus> {
    try {
      const warm = await startup({ options: { cwd: this.options.cwd, model: this.options.model }, initializeTimeoutMs: 10_000 });
      warm.close();
      return { provider: "claude", authenticated: true };
    } catch (error) {
      return { provider: "claude", authenticated: false, message: errorFrom(error, "authentication_unavailable").message };
    }
  }

  async startSession(options: SessionOptions = {}): Promise<AgentSession> {
    const status = await this.checkAvailability();
    if (!status.authenticated) throw new AgentError("authentication_unavailable", status.message ?? "Claude OAuth is unavailable");
    const session = new ClaudeSession(this.options, this.options.resumeSessionId);
    if (options.timeoutMs) setTimeout(() => void session.stop("deadline"), options.timeoutMs).unref();
    return session;
  }
}

export const createClaudeRuntime = (options?: ClaudeRuntimeOptions): ProviderRuntime => new ClaudeRuntime(options);
