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
// A SET value that filters down to ZERO tools throws instead of returning
// []: an operator who set the variable wanted narrowing, and a tool-less
// agent is never it — a silent [] would run the one-shot tool-less while the
// sweep logs exit 0. The throw is loud at both call sites (the one-shot's
// nonzero exit, and the bridge's drain catch which converts it to a Telegram
// error reply). Dropped entries and active narrowing are logged to stderr —
// launchd logs are the only debugging signal for headless runs.
export function resolveAllowedTools(defaults: readonly string[], envValue: string | undefined): string[] {
  if (envValue === undefined || envValue.trim() === "") {
    return [...defaults];
  }
  const known = new Set(defaults);
  const result: string[] = [];
  for (const entry of envValue.split(",").map((e) => e.trim())) {
    if (entry === "") {
      continue;
    }
    if (known.has(entry)) {
      result.push(entry);
    } else {
      console.error(`[allowedTools] dropped unknown entry ${JSON.stringify(entry)} — not in the default tool list`);
    }
  }
  if (result.length === 0) {
    throw new Error(
      `RACHEL_ALLOWED_TOOLS is set but yields zero tools (value: ${JSON.stringify(envValue)}) — refusing to run tool-less; use comma-separated entries from the default tool list, or unset it`,
    );
  }
  console.error(`[rachel] RACHEL_ALLOWED_TOOLS active — narrowed to ${result.length} tools`);
  return result;
}
