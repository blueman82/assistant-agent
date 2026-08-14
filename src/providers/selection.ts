import { AgentError } from "../core/contracts.ts";

export type ProviderName = "claude" | "codex";

export function providerFromEnvironment(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const value = env.RACHEL_PROVIDER?.trim().toLowerCase();
  if (!value) throw new AgentError("provider_required", "RACHEL_PROVIDER must be set to claude or codex");
  if (value !== "claude" && value !== "codex") {
    throw new AgentError("provider_invalid", `Unsupported RACHEL_PROVIDER: ${value}`);
  }
  return value;
}
