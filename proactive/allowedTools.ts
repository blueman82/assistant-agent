// RACHEL_ALLOWED_TOOLS seam — resolves the agent's allowedTools list for a
// given invocation. Pure function so it lives under the npm-test glob
// (rachel.ts itself is not under test); rachel.ts calls it per turn.
//
// Unset / empty / whitespace-only env value => a copy of the defaults,
// verbatim — the seam is provably inert for the interactive agent.
//
// Set => comma-separated NARROWING: entries are trimmed, empties dropped,
// and — injection hardening — only entries already present in the default
// list are honoured. An environment variable can REMOVE tools from a
// headless one-shot; it can never ADD one: a hostile or misconfigured
// launchd/env line must not be able to grant a spawned run tools the
// interactive agent itself does not have.
export function resolveAllowedTools(defaults: readonly string[], envValue: string | undefined): string[] {
  if (envValue === undefined || envValue.trim() === "") {
    return [...defaults];
  }
  const known = new Set(defaults);
  return envValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && known.has(entry));
}
