import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditRow } from "./auditLog.ts";

function tempAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "auditlog-test-"));
  return join(dir, "audit.jsonl");
}

test("appending two rows produces a file with exactly two parseable JSON lines", () => {
  const path = tempAuditPath();
  appendAuditRow(path, { ts: "2026-01-01T00:00:00Z", event: "attempt", toolName: "X", hash: "h1", surface: "test" });
  appendAuditRow(path, { ts: "2026-01-01T00:00:01Z", event: "decision", toolName: "X", hash: "h1", surface: "test", decision: "allow" });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("two concurrent appendAuditRow calls don't interleave/corrupt a line", () => {
  const path = tempAuditPath();
  // appendFileSync is synchronous, so "concurrent" here means back-to-back
  // synchronous calls with no interleaving opportunity — assert it holds
  // rather than assume it from the Node docs.
  for (let i = 0; i < 20; i++) {
    appendAuditRow(path, { ts: `t${i}`, event: "attempt", toolName: "X", hash: `h${i}`, surface: "test" });
  }
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 20);
  const parsed = lines.map((l) => JSON.parse(l));
  for (let i = 0; i < 20; i++) {
    assert.equal(parsed[i].hash, `h${i}`);
  }
});

test("directory is created if absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "auditlog-test-"));
  const nestedPath = join(dir, "nested", "deeper", "audit.jsonl");
  appendAuditRow(nestedPath, { ts: "t", event: "attempt", toolName: "X", hash: "h", surface: "test" });
  const lines = readFileSync(nestedPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});
