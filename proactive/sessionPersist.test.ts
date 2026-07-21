import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, writeSession, clearSession } from "./sessionPersist.ts";

test("readSession returns undefined when the file does not exist (ENOENT)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "does-not-exist.json");
  assert.equal(readSession(path), undefined);
});

test("writeSession writes the session id atomically (readable back via readSession)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "bridge-session.json");
  writeSession(path, "session-abc-123");
  assert.equal(readSession(path), "session-abc-123");
  // No leftover temp file from the atomic write.
  assert.ok(!existsSync(`${path}.tmp-${process.pid}`));
});

test("writeSession creates parent directories that do not yet exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "nested", "sub", "bridge-session.json");
  writeSession(path, "session-xyz");
  assert.equal(readSession(path), "session-xyz");
});

test("clearSession removes an existing session file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "bridge-session.json");
  writeSession(path, "session-to-clear");
  assert.ok(existsSync(path));
  clearSession(path);
  assert.ok(!existsSync(path));
  assert.equal(readSession(path), undefined);
});

test("clearSession on an absent file is a clean no-op, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "does-not-exist.json");
  assert.doesNotThrow(() => clearSession(path));
});

test("readSession throws loud, naming the path, on a non-ENOENT read failure", () => {
  // Point the "file" path at a directory, not a file — readFileSync throws
  // EISDIR, matching proactive/push.ts's readJson and memoryIndex.ts's
  // composeSystemPrompt: only ENOENT is the absent-is-clean-start case.
  const dirAsFile = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  assert.throws(
    () => readSession(dirAsFile),
    (err: unknown) => err instanceof Error && err.message.includes(dirAsFile),
  );
});

test("readSession throws loud on corrupt JSON, naming the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "bridge-session.json");
  require("node:fs").writeFileSync(path, "not valid json{{{");
  assert.throws(
    () => readSession(path),
    (err: unknown) => err instanceof Error && err.message.includes(path),
  );
});

test("writeSession stores JSON with a schema_version, matching the repo's store-file idiom", () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const path = join(dir, "bridge-session.json");
  writeSession(path, "session-shape-check");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.session_id, "session-shape-check");
});
