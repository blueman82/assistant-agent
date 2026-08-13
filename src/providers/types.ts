import type { AgentRuntime } from "../core/contracts.ts";

export interface ProviderRuntimeStatus {
  readonly provider: "claude" | "codex";
  readonly authenticated: boolean;
  readonly message?: string;
}

export interface ProviderRuntime extends AgentRuntime {
  checkAvailability(): Promise<ProviderRuntimeStatus>;
}
