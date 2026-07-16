// Model/effort seam for the interactive agent — module-level mutable state
// so a /model or /effort command takes effect on the very next turn:
// rachel.ts's runTurn rebuilds its options object every turn and reads the
// getters below, rather than capturing a boot-time const.
//
// Mirrors proactive/allowedTools.ts's shape (validate against a known set,
// log rejects to stderr) with one deliberate divergence: allowedTools.ts
// throws on a bad value, this module never does. The distinction is not
// about which processes import which module — it's about whether a safe
// fallback exists. allowedTools.ts throws only when the operator SET the
// var and it narrowed to ZERO tools: there is no safe fallback for a
// tool-less agent, so silently running one would be worse than the throw.
// This module always has a safe fallback — a valid, working default model
// — so throwing here would turn an operator's typo into a dead assistant;
// under the Telegram bridge's KeepAlive supervision that's a crash-loop,
// not a fail-loud. Setters (driven by per-turn USER input, a Telegram or
// terminal /model or /effort command) never throw for the same reason a
// bad value must be handled, not thrown: it returns a discriminated result
// so the command handlers can render the rejection back to the user and
// leave current state untouched.
//
// SCOPE: this state is per-process, not shared across the app. The
// terminal REPL (npm start / tsx rachel.ts) and the Telegram bridge (npm
// run bridge / tsx bridge/telegram-bridge.ts) are separate OS processes;
// every launchd-run entry point that reaches this module does so
// transitively via rachel.ts, and each gets its own fresh copy at its own
// import. A /model or /effort switch made in one process is invisible to
// every other process — a Telegram switch does not change what the
// terminal REPL is running, and neither changes what a scheduled one-shot
// picks up. This is deliberate, not a gap to close: persisting the choice
// to disk so it was shared across processes would let an interactive
// switch silently change which model the unattended scheduled jobs run
// on, which is worse than the current per-process isolation.

export const VALID_MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"] as const;
export type ValidModel = (typeof VALID_MODELS)[number];

// Short names for the whitelisted models above — resolved to a full ID
// BEFORE the VALID_MODELS check below, never in place of it. Case-insensitive
// (lowercased before lookup) so "opus"/"Opus"/"OPUS" all resolve; full model
// IDs are matched byte-exact and are never lowercased, so a mixed-case full
// ID (e.g. "Claude-Sonnet-5") is still rejected exactly as before aliasing
// was added.
const MODEL_ALIASES: Record<string, ValidModel> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
};

function resolveModelAlias(value: string): string {
  return MODEL_ALIASES[value.toLowerCase()] ?? value;
}

// All 5 levels are valid for all 4 whitelisted models. (The SDK's own
// sdk.d.ts annotates 'xhigh'/'max' as restricted to specific older Opus
// versions — that comment is stale against current model docs, and the
// types don't enforce it. Do not reintroduce a per-model effort
// restriction here.)
export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ValidEffort = (typeof VALID_EFFORTS)[number];

const DEFAULT_MODEL: ValidModel = "claude-sonnet-5";
const DEFAULT_EFFORT: ValidEffort = "high";

function resolveBootModel(): ValidModel {
  const envValue = process.env["RACHEL_MODEL"];
  if (envValue === undefined) {
    return DEFAULT_MODEL;
  }
  if ((VALID_MODELS as readonly string[]).includes(envValue)) {
    return envValue as ValidModel;
  }
  console.error(
    `[modelConfig] RACHEL_MODEL=${JSON.stringify(envValue)} is not on the whitelist (${VALID_MODELS.join(", ")}) — falling back to ${DEFAULT_MODEL}`,
  );
  return DEFAULT_MODEL;
}

let currentModel: ValidModel = resolveBootModel();
let currentEffort: ValidEffort = DEFAULT_EFFORT;

export type SetResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function getModel(): ValidModel {
  return currentModel;
}

export function getEffort(): ValidEffort {
  return currentEffort;
}

export function setModel(value: string): SetResult<ValidModel> {
  if (!(VALID_MODELS as readonly string[]).includes(value)) {
    return { ok: false, message: `unknown model ${JSON.stringify(value)} — valid options: ${VALID_MODELS.join(", ")}` };
  }
  currentModel = value as ValidModel;
  return { ok: true, value: currentModel };
}

export function setEffort(value: string): SetResult<ValidEffort> {
  if (!(VALID_EFFORTS as readonly string[]).includes(value)) {
    return { ok: false, message: `unknown effort ${JSON.stringify(value)} — valid options: ${VALID_EFFORTS.join(", ")}` };
  }
  currentEffort = value as ValidEffort;
  return { ok: true, value: currentEffort };
}

export function getReport(): { model: ValidModel; effort: ValidEffort; validModels: readonly ValidModel[]; validEfforts: readonly ValidEffort[] } {
  return {
    model: currentModel,
    effort: currentEffort,
    validModels: VALID_MODELS,
    validEfforts: VALID_EFFORTS,
  };
}

// handleConfigCommand — shared /model and /effort dispatch for every surface
// (the terminal REPL and the Telegram bridge). Pure and synchronous: it
// returns the message body for the caller to render, or undefined when the
// input isn't one of these two commands, so each surface keeps its own sink
// (console.log vs. reply()) and loop control (continue vs. return) instead
// of routing through a callback. Parsing splits on whitespace and
// exact-matches parts[0] so "/modeling" does not match "/model".
export function handleConfigCommand(input: string): string | undefined {
  const parts = input.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts[0] === "/model") {
    const arg = parts[1];
    if (arg === undefined) {
      const report = getReport();
      return `model: ${report.model}\nvalid options: ${report.validModels.join(", ")}`;
    }
    const result = setModel(arg);
    return result.ok ? `model set to ${result.value} — takes effect on the next turn.` : result.message;
  }
  if (parts[0] === "/effort") {
    const arg = parts[1];
    if (arg === undefined) {
      const report = getReport();
      return `effort: ${report.effort}\nvalid options: ${report.validEfforts.join(", ")}`;
    }
    const result = setEffort(arg);
    return result.ok ? `effort set to ${result.value} — takes effect on the next turn.` : result.message;
  }
  return undefined;
}
