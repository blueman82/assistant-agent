import { test } from "node:test";
import assert from "node:assert/strict";

// Captures console.error lines emitted during fn — modelConfig logs a
// boot-time fallback the same way allowedTools.ts logs dropped entries
// (launchd logs are the only debugging signal for headless one-shots).
// The boot-fallback log happens synchronously during dynamic import's
// module-record evaluation, but the import() call itself must be awaited,
// so console.error must stay overridden across the await.
async function captureStderrAsync(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.error = original;
  }
}

test("boot default model is claude-sonnet-5 when RACHEL_MODEL is unset", async () => {
  const original = process.env["RACHEL_MODEL"];
  delete process.env["RACHEL_MODEL"];
  try {
    const mod = await import(`./modelConfig.ts?t=${Date.now()}-a`);
    assert.equal(mod.getModel(), "claude-sonnet-5");
  } finally {
    if (original !== undefined) process.env["RACHEL_MODEL"] = original;
  }
});

test("boot default effort is high", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-b`);
  assert.equal(mod.getEffort(), "high");
});

test("RACHEL_MODEL override is honoured at boot when on the whitelist", async () => {
  const original = process.env["RACHEL_MODEL"];
  process.env["RACHEL_MODEL"] = "claude-opus-4-8";
  try {
    const mod = await import(`./modelConfig.ts?t=${Date.now()}-c`);
    assert.equal(mod.getModel(), "claude-opus-4-8");
  } finally {
    if (original !== undefined) process.env["RACHEL_MODEL"] = original;
    else delete process.env["RACHEL_MODEL"];
  }
});

test("RACHEL_MODEL set to an off-whitelist value falls back to the default and logs", async () => {
  const original = process.env["RACHEL_MODEL"];
  process.env["RACHEL_MODEL"] = "gpt-5-turbo";
  try {
    const { lines, result: mod } = await captureStderrAsync(() => import(`./modelConfig.ts?t=${Date.now()}-d`));
    assert.equal((mod as { getModel: () => string }).getModel(), "claude-sonnet-5");
    assert.ok(
      lines.some((l) => l.includes("gpt-5-turbo")),
      `off-whitelist RACHEL_MODEL value logged to stderr: ${JSON.stringify(lines)}`,
    );
  } finally {
    if (original !== undefined) process.env["RACHEL_MODEL"] = original;
    else delete process.env["RACHEL_MODEL"];
  }
});

test("valid model switch updates current model", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-e`);
  const result = mod.setModel("claude-haiku-4-5");
  assert.deepEqual(result, { ok: true, value: "claude-haiku-4-5" });
  assert.equal(mod.getModel(), "claude-haiku-4-5");
});

test("valid effort switch updates current effort", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-f`);
  const result = mod.setEffort("low");
  assert.deepEqual(result, { ok: true, value: "low" });
  assert.equal(mod.getEffort(), "low");
});

test("invalid model is rejected and state is unchanged (not silently reset to default)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-g`);
  // Start from a non-default value: a bug that resets to default on bad
  // input would still pass an assertion pinned to the boot default, so the
  // "before" value must not be the default for this test to have teeth.
  mod.setModel("claude-haiku-4-5");
  const result = mod.setModel("gpt-5-turbo");
  assert.equal(result.ok, false);
  assert.match(result.message, /gpt-5-turbo/);
  assert.equal(mod.getModel(), "claude-haiku-4-5");
});

test("invalid effort is rejected and state is unchanged (not silently reset to default)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-h`);
  mod.setEffort("low");
  const result = mod.setEffort("ultra");
  assert.equal(result.ok, false);
  assert.match(result.message, /ultra/);
  assert.equal(mod.getEffort(), "low");
});

test("all 5 effort levels are accepted for every whitelisted model (pins the stale SDK annotation trap)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-i`);
  for (const model of mod.VALID_MODELS) {
    mod.setModel(model);
    for (const effort of mod.VALID_EFFORTS) {
      const result = mod.setEffort(effort);
      assert.deepEqual(
        result,
        { ok: true, value: effort },
        `effort ${effort} should be valid for model ${model}`,
      );
    }
  }
});

test("report function returns current model/effort plus valid options", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-j`);
  mod.setModel("claude-fable-5");
  mod.setEffort("medium");
  const report = mod.getReport();
  assert.equal(report.model, "claude-fable-5");
  assert.equal(report.effort, "medium");
  assert.deepEqual(report.validModels, mod.VALID_MODELS);
  assert.deepEqual(report.validEfforts, mod.VALID_EFFORTS);
});

// ---------------------------------------------------------------------------
// handleConfigCommand — the shared, surface-agnostic dispatch for /model and
// /effort. Both rachel.ts (CLI) and bridge/telegram-bridge.ts (Telegram) call
// this and render the returned string through their own sink (console.log
// vs. reply()); it never touches I/O itself, so its state is exercised here
// with plain save/restore rather than fresh dynamic imports per test.
// ---------------------------------------------------------------------------

test("handleConfigCommand: /model with no argument reports the current model and valid options", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-k`);
  const result = mod.handleConfigCommand("/model");
  assert.ok(result !== undefined);
  assert.ok(result!.includes(mod.getModel()));
  for (const m of mod.VALID_MODELS) {
    assert.ok(result!.includes(m), `expected valid model ${m} listed — got: ${result}`);
  }
});

test("handleConfigCommand: /effort with no argument reports the current effort and valid options", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-l`);
  const result = mod.handleConfigCommand("/effort");
  assert.ok(result !== undefined);
  assert.ok(result!.includes(mod.getEffort()));
  for (const e of mod.VALID_EFFORTS) {
    assert.ok(result!.includes(e), `expected valid effort ${e} listed — got: ${result}`);
  }
});

test("handleConfigCommand: /model <valid-name> switches the model and confirms it takes effect next turn", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-m`);
  const original = mod.getModel();
  try {
    const result = mod.handleConfigCommand("/model claude-opus-4-8");
    assert.equal(mod.getModel(), "claude-opus-4-8");
    assert.ok(result !== undefined);
    assert.ok(result!.includes("claude-opus-4-8"));
    assert.ok(result!.includes("takes effect on the next turn"));
  } finally {
    mod.setModel(original);
  }
});

test("handleConfigCommand: /effort <valid-level> switches the effort and confirms it takes effect next turn", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-n`);
  const original = mod.getEffort();
  try {
    const result = mod.handleConfigCommand("/effort xhigh");
    assert.equal(mod.getEffort(), "xhigh");
    assert.ok(result !== undefined);
    assert.ok(result!.includes("xhigh"));
    assert.ok(result!.includes("takes effect on the next turn"));
  } finally {
    mod.setEffort(original);
  }
});

test("handleConfigCommand: /model <invalid-name> returns the rejection message and leaves state unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-o`);
  const original = mod.getModel();
  const result = mod.handleConfigCommand("/model gpt-5-turbo");
  assert.equal(mod.getModel(), original, "invalid /model value must not change current state");
  assert.ok(result !== undefined);
  assert.ok(result!.includes("gpt-5-turbo"));
});

test("handleConfigCommand: /effort <invalid-level> returns the rejection message and leaves state unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-p`);
  const original = mod.getEffort();
  const result = mod.handleConfigCommand("/effort ultra");
  assert.equal(mod.getEffort(), original, "invalid /effort value must not change current state");
  assert.ok(result !== undefined);
  assert.ok(result!.includes("ultra"));
});

test("handleConfigCommand: /model with extra surrounding whitespace still parses the argument", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-q`);
  const original = mod.getModel();
  try {
    const result = mod.handleConfigCommand("  /model   claude-haiku-4-5  ");
    assert.equal(mod.getModel(), "claude-haiku-4-5", "whitespace around /model and its argument must not block parsing");
    assert.ok(result !== undefined);
  } finally {
    mod.setModel(original);
  }
});

test("handleConfigCommand: /modeling does not match /model (exact-match, not prefix-match)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-r`);
  const result = mod.handleConfigCommand("/modeling");
  assert.equal(result, undefined);
});

test("handleConfigCommand: /efforting does not match /effort (exact-match, not prefix-match)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-s`);
  const result = mod.handleConfigCommand("/efforting");
  assert.equal(result, undefined);
});

test("handleConfigCommand: a non-command input returns undefined", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-t`);
  assert.equal(mod.handleConfigCommand("hello there"), undefined);
  assert.equal(mod.handleConfigCommand("/reset"), undefined);
  assert.equal(mod.handleConfigCommand("/status"), undefined);
});

// ---------------------------------------------------------------------------
// Model aliases — short names (opus/sonnet/haiku/fable) resolve to full IDs
// before the VALID_MODELS whitelist check, so the whitelist stays the sole
// validation gate; an alias map is never a second unvalidated path to the
// SDK's model field.
// ---------------------------------------------------------------------------

test("setModel: each alias resolves to its full whitelisted model ID", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-u`);
  const cases: Array<[string, string]> = [
    ["opus", "claude-opus-4-8"],
    ["sonnet", "claude-sonnet-5"],
    ["haiku", "claude-haiku-4-5"],
    ["fable", "claude-fable-5"],
  ];
  for (const [alias, fullId] of cases) {
    const result = mod.setModel(alias);
    assert.deepEqual(result, { ok: true, value: fullId }, `alias ${alias} should resolve to ${fullId}`);
    assert.equal(mod.getModel(), fullId);
  }
});

test("setModel: full model IDs still work exactly as before (unaffected by alias resolution)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-v`);
  for (const fullId of mod.VALID_MODELS) {
    const result = mod.setModel(fullId);
    assert.deepEqual(result, { ok: true, value: fullId });
  }
});

test("setModel: a mixed-case full ID is still rejected (proves aliasing did not widen the full-ID path by lowercasing)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-w`);
  const original = mod.getModel();
  const result = mod.setModel("Claude-Sonnet-5");
  assert.equal(result.ok, false, "a mixed-case full ID must not be silently accepted");
  assert.equal(mod.getModel(), original);
});

test("setModel: aliases are case-insensitive (OPUS, Opus, opus all resolve)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-x`);
  for (const spelling of ["OPUS", "Opus", "opus"]) {
    const result = mod.setModel(spelling);
    assert.deepEqual(result, { ok: true, value: "claude-opus-4-8" }, `${spelling} should resolve`);
  }
});

test("setModel: an unknown alias falls through to the existing rejection, state unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-y`);
  mod.setModel("claude-haiku-4-5");
  const result = mod.setModel("gpt5");
  assert.equal(result.ok, false);
  assert.match(result.message, /gpt5/);
  assert.equal(mod.getModel(), "claude-haiku-4-5");
});

test("setModel rejection message surfaces the aliases so they're discoverable", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-z`);
  const result = mod.setModel("not-a-real-model");
  assert.equal(result.ok, false);
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
    assert.ok(result.message.includes(alias), `expected alias ${alias} in rejection message: ${result.message}`);
  }
});

test("getReport / no-arg /model surfaces the aliases so a user can discover them", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-aa`);
  const result = mod.handleConfigCommand("/model");
  assert.ok(result !== undefined);
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
    assert.ok(result!.includes(alias), `expected alias ${alias} in /model report: ${result}`);
  }
});

test("RACHEL_MODEL env var also accepts an alias at boot (consistent surface with /model)", async () => {
  const original = process.env["RACHEL_MODEL"];
  process.env["RACHEL_MODEL"] = "opus";
  try {
    const mod = await import(`./modelConfig.ts?t=${Date.now()}-ab`);
    assert.equal(mod.getModel(), "claude-opus-4-8");
  } finally {
    if (original !== undefined) process.env["RACHEL_MODEL"] = original;
    else delete process.env["RACHEL_MODEL"];
  }
});

// ---------------------------------------------------------------------------
// --help / -h — pure, testable arg-parsing and help-text rendering. rachel.ts
// intercepts before the initialPrompt join so a real "--help" argv never
// reaches the agent as a prompt. isHelpFlag/renderHelp live here (not inline
// in rachel.ts) because rachel.ts is outside the npm test glob.
// ---------------------------------------------------------------------------

test("isHelpFlag: --help is intercepted", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ac`);
  assert.equal(mod.isHelpFlag(["--help"]), true);
});

test("isHelpFlag: -h is intercepted", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ad`);
  assert.equal(mod.isHelpFlag(["-h"]), true);
});

test("isHelpFlag: a normal quoted prompt is NOT intercepted", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ae`);
  assert.equal(mod.isHelpFlag(["check my email"]), false);
});

test("isHelpFlag: empty argv is NOT intercepted (interactive mode)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-af`);
  assert.equal(mod.isHelpFlag([]), false);
});

test("renderHelp: covers /model, /effort, /reset, /exit, /quit, and q-to-abort", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ag`);
  const help = mod.renderHelp(200);
  for (const token of ["/model", "/effort", "/reset", "/exit", "/quit", "q"]) {
    assert.ok(help.includes(token), `expected ${token} in help text`);
  }
});

test("renderHelp: covers the env vars RACHEL_MODEL, RACHEL_MAX_TURNS, RACHEL_ALLOWED_TOOLS", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ah`);
  const help = mod.renderHelp(200);
  for (const envVar of ["RACHEL_MODEL", "RACHEL_MAX_TURNS", "RACHEL_ALLOWED_TOOLS"]) {
    assert.ok(help.includes(envVar), `expected ${envVar} in help text`);
  }
});

test("renderHelp: renders model/effort lists and default from modelConfig's own exports, not retyped literals", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ai`);
  const help = mod.renderHelp(200);
  for (const m of mod.VALID_MODELS) {
    assert.ok(help.includes(m), `expected model ${m} listed in help`);
  }
  for (const e of mod.VALID_EFFORTS) {
    assert.ok(help.includes(e), `expected effort ${e} listed in help`);
  }
});

test("renderHelp: renders the passed-in default, not a hardcoded 200", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-aj`);
  const help = mod.renderHelp(42);
  assert.ok(help.includes("42"), "expected the passed-in default value in help text");
});

test("renderHelp: labels whatever value it's given as the default verbatim — the caller (rachel.ts) is responsible for passing the STATIC default, not an env-overridden effective value", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ak`);
  const help = mod.renderHelp(200);
  assert.ok(help.includes("default: 200"), "expected the given value labelled as the default");
});

// ---------------------------------------------------------------------------
// parseArgvConfig — rachel.ts's argv path (`rachel /model opus`) never
// consulted handleConfigCommand before this: process.argv was joined
// straight into a prompt and sent to the agent, burning a real turn on
// Rachel explaining "/model isn't available". This walks argv token-by-token,
// applying every /model or /effort command it finds via handleConfigCommand
// (so validation/rendering stays single-sourced there) and returns whatever
// argv is left over as the one-shot prompt — so `rachel /model opus "check
// my email"` applies the switch AND still runs the prompt (apply-then-run),
// rather than rejecting the mix as ambiguous. This composes: it's what a
// user typing that line would expect, and it costs nothing extra since
// config application is independent of prompt dispatch.
// ---------------------------------------------------------------------------

test("parseArgvConfig: a single config command applies and reports, with no remaining prompt", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-al`);
  const original = mod.getModel();
  try {
    const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model", "opus"]);
    assert.equal(mod.getModel(), "claude-opus-4-8");
    assert.equal(configReplies.length, 1);
    assert.ok(configReplies[0].includes("claude-opus-4-8"));
    assert.equal(remainingPrompt, "");
  } finally {
    mod.setModel(original);
  }
});

test("parseArgvConfig: multiple config commands in one argv all apply (Gary's exact case: /model opus /effort xhigh)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-am`);
  const originalModel = mod.getModel();
  const originalEffort = mod.getEffort();
  try {
    const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model", "opus", "/effort", "xhigh"]);
    assert.equal(mod.getModel(), "claude-opus-4-8");
    assert.equal(mod.getEffort(), "xhigh");
    assert.equal(configReplies.length, 2);
    assert.ok(configReplies[0].includes("claude-opus-4-8"));
    assert.ok(configReplies[1].includes("xhigh"));
    assert.equal(remainingPrompt, "");
  } finally {
    mod.setModel(originalModel);
    mod.setEffort(originalEffort);
  }
});

test("parseArgvConfig: /model with no argument produces the report form, same as the REPL", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-an`);
  const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model"]);
  assert.equal(configReplies.length, 1);
  assert.ok(configReplies[0].includes(mod.getModel()));
  assert.ok(configReplies[0].includes("valid options"));
  assert.equal(remainingPrompt, "");
});

test("parseArgvConfig: an invalid value is rejected, reported, and leaves state unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ao`);
  const original = mod.getModel();
  const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model", "nonsense"]);
  assert.equal(mod.getModel(), original, "invalid value must not change state");
  assert.equal(configReplies.length, 1);
  assert.ok(configReplies[0].includes("nonsense"));
  assert.equal(remainingPrompt, "");
});

test("parseArgvConfig: a config command immediately followed by another config command does not swallow it as an argument", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ap`);
  const originalModel = mod.getModel();
  const originalEffort = mod.getEffort();
  try {
    const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model", "/effort", "xhigh"]);
    // "/model" with no argument (the next token is itself a command) reports
    // rather than trying to setModel("/effort").
    assert.equal(mod.getModel(), originalModel, "/model must not have consumed /effort as its argument");
    assert.equal(mod.getEffort(), "xhigh");
    assert.equal(configReplies.length, 2);
    assert.ok(configReplies[0].includes("valid options"), "expected the no-arg report form for /model");
    assert.ok(configReplies[1].includes("xhigh"));
    assert.equal(remainingPrompt, "");
  } finally {
    mod.setModel(originalModel);
    mod.setEffort(originalEffort);
  }
});

test("parseArgvConfig: a plain prompt with no config commands is returned untouched as remainingPrompt", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-aq`);
  const { configReplies, remainingPrompt } = mod.parseArgvConfig(["check", "my", "email"]);
  assert.deepEqual(configReplies, []);
  assert.equal(remainingPrompt, "check my email");
});

test("parseArgvConfig: empty argv produces no replies and an empty prompt", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-ar`);
  const { configReplies, remainingPrompt } = mod.parseArgvConfig([]);
  assert.deepEqual(configReplies, []);
  assert.equal(remainingPrompt, "");
});

test("parseArgvConfig: mixed invocation applies config THEN returns the rest as the prompt (apply-then-run, not rejected as ambiguous)", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-as`);
  const original = mod.getModel();
  try {
    const { configReplies, remainingPrompt } = mod.parseArgvConfig(["/model", "opus", "check", "my", "email"]);
    assert.equal(mod.getModel(), "claude-opus-4-8");
    assert.equal(configReplies.length, 1);
    assert.equal(remainingPrompt, "check my email");
  } finally {
    mod.setModel(original);
  }
});

test("parseArgvConfig: a mixed invocation with config commands interleaved after the prompt still applies them and strips them from the prompt", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-at`);
  const original = mod.getModel();
  try {
    const { configReplies, remainingPrompt } = mod.parseArgvConfig(["check", "my", "email", "/model", "opus"]);
    assert.equal(mod.getModel(), "claude-opus-4-8");
    assert.equal(configReplies.length, 1);
    assert.equal(remainingPrompt, "check my email");
  } finally {
    mod.setModel(original);
  }
});

