// Model/effort seam for the interactive agent — module-level mutable state
// so a /model or /effort switch (wu2) takes effect on the very next turn:
// rachel.ts's runTurn rebuilds its options object every turn and reads the
// getters below, rather than capturing a boot-time const.
//
// Mirrors proactive/allowedTools.ts's shape (validate against a known set,
// log rejects to stderr) with one deliberate divergence: allowedTools.ts
// throws on a bad value because its input is operator env config read once
// at boot — a throw there fails loud before any turn runs. This module's
// setters are driven by per-turn USER input (a Telegram/terminal /model or
// /effort command), so a bad value must be handled, not thrown: throwing
// here would take down the whole bridge turn (and the launchd one-shot
// process) over a user's typo. Setters instead return a discriminated
// result so the two call sites (wu2) can render the rejection back to the
// user and leave current state untouched.
//
// The boot-time RACHEL_MODEL read is the one path that still behaves like
// allowedTools.ts's env-seam: an operator-set env var. But even there we
// don't throw — this module is imported at the top of 4 launchd one-shot
// entry points, and a throw at import time would wedge all of them. An
// off-whitelist RACHEL_MODEL logs to stderr and falls back to the default
// instead.

export const VALID_MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"] as const;
export type ValidModel = (typeof VALID_MODELS)[number];

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
