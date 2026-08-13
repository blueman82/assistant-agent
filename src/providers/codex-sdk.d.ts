declare module "@openai/codex-sdk" {
  export interface ThreadOptions { model?: string; workingDirectory?: string; modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"; }
  export interface TurnOptions { signal?: AbortSignal }
  export interface Usage { input_tokens: number; output_tokens: number }
  export interface ThreadItem { type: string; [key: string]: unknown }
  export type ThreadEvent =
    | { type: "thread.started"; thread_id: string }
    | { type: "item.started" | "item.updated" | "item.completed"; item: ThreadItem }
    | { type: "turn.completed"; usage: Usage }
    | { type: "turn.failed"; error: { message: string } }
    | { type: "error"; message: string }
    | { type: "turn.started" };
  export class Thread {
    readonly id: string | null;
    runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
  }
  export class Codex {
    constructor(options?: { codexPathOverride?: string; baseUrl?: string; config?: Record<string, unknown> });
    startThread(options?: ThreadOptions): Thread;
    resumeThread(id: string, options?: ThreadOptions): Thread;
  }
}
