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

test("invalid model is rejected and state is unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-g`);
  const before = mod.getModel();
  const result = mod.setModel("gpt-5-turbo");
  assert.equal(result.ok, false);
  assert.match(result.message, /gpt-5-turbo/);
  assert.equal(mod.getModel(), before);
});

test("invalid effort is rejected and state is unchanged", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-h`);
  const before = mod.getEffort();
  const result = mod.setEffort("ultra");
  assert.equal(result.ok, false);
  assert.match(result.message, /ultra/);
  assert.equal(mod.getEffort(), before);
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

test("VALID_MODELS contains exactly the four whitelisted models", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-k`);
  assert.deepEqual(
    [...mod.VALID_MODELS].sort(),
    ["claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"].sort(),
  );
});

test("VALID_EFFORTS contains exactly the five effort levels", async () => {
  const mod = await import(`./modelConfig.ts?t=${Date.now()}-l`);
  assert.deepEqual([...mod.VALID_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
});
