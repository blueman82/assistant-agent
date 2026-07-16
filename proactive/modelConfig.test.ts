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

