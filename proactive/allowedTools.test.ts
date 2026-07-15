import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAllowedTools } from "./allowedTools.ts";

// A stand-in default list for most tests. The real 17-entry list lives in
// rachel.ts (DEFAULT_ALLOWED_TOOLS); the identity test below uses a copy of
// it to pin the unset-is-inert contract against realistic values.
const DEFAULTS = ["Read", "Write", "Bash", "mcp__claude_ai_Google_Calendar__*"] as const;

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

test("unset returns the full 17-entry default list byte-identical (frozen rachel.ts contract)", () => {
  const frozen = [
    "Read", "Write", "Edit", "Glob", "Grep", "Bash",
    "WebSearch", "WebFetch",
    "ToolSearch", "Skill",
    "mcp__mcp-exec__execute_code_with_wrappers",
    "mcp__mcp-exec__list_available_mcp_servers",
    "mcp__mcp-exec__get_mcp_tool_schema",
    "mcp__claude-in-chrome__*",
    "mcp__claude_ai_Gmail__*",
    "mcp__claude_ai_Google_Calendar__*",
    "mcp__claude_ai_Slack__*",
  ];
  assert.deepEqual(resolveAllowedTools(frozen, undefined), frozen);
});
