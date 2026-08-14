import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "./architecture-check.ts";

test("architecture checker catches the high-value boundaries", () => {
  const findings = checkSource([
    'import { query } from "@anthropic-ai/claude-agent-sdk";',
    "let session = 0;",
    "export function bad(a, b, c, d, e) { return session + e; }",
  ].join("\n"), "src/core/bad.ts");
  assert.equal(findings.length, 3);
  assert.ok(findings.some((finding) => finding.includes("SDK imports")));
  assert.ok(findings.some((finding) => finding.includes("top-level")));
  assert.ok(findings.some((finding) => finding.includes("parameters")));
});

test("approved infrastructure stays clean", () => {
  assert.deepEqual(checkSource(
    'import { execFile } from "node:child_process";\nexport function run() { execFile("python", []); }',
    "src/speech/local.ts",
  ), []);
});

test("production imports respect module boundaries", () => {
  const findings = checkSource('import { send } from "../telegram/send.ts";', "src/core/policy.ts");
  assert.ok(findings.some((finding) => finding.includes("core may not import telegram")));
});

test("legacy runtime names are rejected", () => {
  assert.ok(checkSource("export const value = 1;", "src/core/bridge-policy.ts").some((finding) => finding.includes("legacy filename")));
});
