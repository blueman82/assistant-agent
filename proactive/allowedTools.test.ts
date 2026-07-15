import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAllowedTools } from "./allowedTools.ts";

// A stand-in default list for these tests. The REAL pin — that rachel.ts's
// runTurn consumes resolveAllowedTools and that unset env yields the frozen
// 17-entry list — lives in bridge/telegram-bridge.test.ts, which drives the
// real runTurn and asserts on the options object the SDK would receive.
const DEFAULTS = ["Read", "Write", "Bash", "mcp__claude_ai_Google_Calendar__*"] as const;

// Captures console.error lines emitted during fn — resolveAllowedTools logs
// dropped entries and active narrowing there (launchd logs are the only
// debugging signal for one-shots).
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("unset env value returns a copy of the defaults, not the same array reference", () => {
  const result = resolveAllowedTools(DEFAULTS, undefined);
  assert.deepEqual(result, [...DEFAULTS]);
  assert.notEqual(result, DEFAULTS as unknown, "must be a fresh array, not the defaults reference");
});

test("empty and whitespace-only env values behave as unset", () => {
  assert.deepEqual(resolveAllowedTools(DEFAULTS, ""), [...DEFAULTS]);
  assert.deepEqual(resolveAllowedTools(DEFAULTS, "  "), [...DEFAULTS]);
});

test("a comma-separated env value narrows to exactly those entries, in env order", () => {
  assert.deepEqual(
    resolveAllowedTools(DEFAULTS, "Read,Write,Bash,mcp__claude_ai_Google_Calendar__*"),
    ["Read", "Write", "Bash", "mcp__claude_ai_Google_Calendar__*"],
  );
  assert.deepEqual(resolveAllowedTools(DEFAULTS, "Read"), ["Read"]);
});

test("env order is preserved, not default-list order", () => {
  assert.deepEqual(resolveAllowedTools(DEFAULTS, "Bash,Read"), ["Bash", "Read"]);
});

test("entries are trimmed and empties dropped", () => {
  assert.deepEqual(resolveAllowedTools(DEFAULTS, " Read , Bash ,"), ["Read", "Bash"]);
});

test("an env value cannot ADD a tool absent from the default list (injection hardening)", () => {
  assert.deepEqual(
    resolveAllowedTools(DEFAULTS, "Read,mcp__evil__exfiltrate,Bash"),
    ["Read", "Bash"],
    "unknown entries are dropped — the env var narrows, never widens",
  );
});

test("every dropped unknown entry is logged to stderr with its value", () => {
  const lines = captureStderr(() => {
    resolveAllowedTools(DEFAULTS, "Read,mcp__evil__exfiltrate,Bash");
  });
  assert.ok(
    lines.some((l) => l.includes("[allowedTools] dropped unknown entry") && l.includes("mcp__evil__exfiltrate")),
    `dropped entry named on stderr: ${JSON.stringify(lines)}`,
  );
});

test("active narrowing logs one line naming the narrowed tool count", () => {
  const lines = captureStderr(() => {
    resolveAllowedTools(DEFAULTS, "Read,Bash");
  });
  assert.ok(
    lines.some((l) => l.includes("RACHEL_ALLOWED_TOOLS active") && l.includes("2")),
    `narrowing-active line with count: ${JSON.stringify(lines)}`,
  );
});

test("unset env logs nothing (the seam is silent when inert)", () => {
  const lines = captureStderr(() => {
    resolveAllowedTools(DEFAULTS, undefined);
  });
  assert.deepEqual(lines, []);
});

// A SET env var that yields zero tools is never what the operator wanted —
// a silent [] would run the one-shot tool-less with the sweep logging exit 0.
// The throw is loud in both the one-shot's exit and the bridge's drain catch.
test("a comma-only env value throws loudly instead of returning zero tools", () => {
  assert.throws(() => resolveAllowedTools(DEFAULTS, ","), /zero tools/);
  assert.throws(() => resolveAllowedTools(DEFAULTS, ",,,"), /zero tools/);
});

test("a space-separated typo (no commas, so one giant unknown entry) throws with the raw value in the message", () => {
  assert.throws(() => resolveAllowedTools(DEFAULTS, "Read Write Bash"), /Read Write Bash/);
});

test("an all-unknown env value throws with the raw value in the message", () => {
  assert.throws(() => resolveAllowedTools(DEFAULTS, "mcp__evil__a,mcp__evil__b"), /mcp__evil__a,mcp__evil__b/);
});
