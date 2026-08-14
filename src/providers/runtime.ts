import { createClaudeRuntime } from "./claude.ts";
import { createCodexRuntime } from "./codex.ts";
import type { ProviderRuntime } from "./types.ts";
import type { ProviderName } from "./selection.ts";

export function createProviderRuntime(provider: ProviderName, cwd = process.cwd()): ProviderRuntime {
  return provider === "claude" ? createClaudeRuntime({ cwd }) : createCodexRuntime({ cwd });
}
