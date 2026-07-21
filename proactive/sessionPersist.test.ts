// Env-safety header — matches memoryIndex.test.ts's header exactly and for
// the same reason: the WIRING tests below import the REAL runTurn/
// resetSession from rachel.ts, and importing rachel.ts runs its module-scope
// side effects once (loadTelegramConfig(), createQueueApprovalSurface(),
// createSendGateHook()). Without these redirects, a test run here could
// touch the operator's real queue/audit files or a live Telegram token.
// This block MUST stay ahead of every import in this file.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync as mkdtempSyncEarly } from "node:fs";
import { tmpdir as tmpdirEarly } from "node:os";
import { join as joinEarly } from "node:path";

const testQueueDir = mkdtempSyncEarly(joinEarly(tmpdirEarly(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = joinEarly(testQueueDir, "audit.jsonl");
process.env["RACHEL_MEMORY_PATH"] = joinEarly(testQueueDir, "memory", "MEMORY.md");

// Defense-in-depth, same reasoning as memoryIndex.test.ts: every WIRING test
// here injects its own fake queryFn rather than relying on global fetch.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in sessionPersist.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
  writeFileSync(path, "not valid json{{{");
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

// ---------------------------------------------------------------------------
// WIRING — rachel.ts's use of the RACHEL_SESSION_FILE seam. Unset must be a
// total no-op (byte-for-byte today's behaviour for the CLI and all 8
// headless one-shots); set must persist on every session-id capture and
// clear on /reset. These import the REAL runTurn/resetSession/
// hydratePersistedSession from rachel.ts via a fake queryFn, matching
// memoryIndex.test.ts's WIRING test harness.
// ---------------------------------------------------------------------------

// Yields a single init message reporting `sessionId`, letting these tests
// exercise runTurn's real session-capture branch without hitting the
// network — matching memoryIndex.test.ts's WIRING test harness pattern.
function initMessage(sessionId: string): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

// rachel.ts's sessionId is module-scoped and shared across every test in
// this file (ESM caches the module on first dynamic import). Reset it
// before each WIRING test so tests are order-independent — critically,
// with RACHEL_SESSION_FILE UNSET at reset time, since resetSession() itself
// unlinks the persisted file when the seam IS set; resetting after a test
// has pointed the seam at a freshly-written fixture would delete it.
beforeEach(async () => {
  delete process.env["RACHEL_SESSION_FILE"];
  const { resetSession } = await import("../rachel.ts");
  resetSession();
});

test("WIRING: RACHEL_SESSION_FILE unset — runTurn never writes a session file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "bridge-session.json");
  // Seam stays unset (beforeEach already cleared it).
  const { runTurn } = await import("../rachel.ts");
  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield initMessage("fake-session-unset");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];
  await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);
  assert.ok(!existsSync(sessionFile), "no session file must be written when the seam is unset");
});

test("WIRING: RACHEL_SESSION_FILE set — runTurn persists the captured session id to that path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "bridge-session.json");
  process.env["RACHEL_SESSION_FILE"] = sessionFile;
  const { runTurn } = await import("../rachel.ts");
  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield initMessage("fake-session-set");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];
  await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);
  assert.equal(readSession(sessionFile), "fake-session-set");
});

test("REGRESSION: RACHEL_SESSION_FILE set — resetSession clears the persisted file so a restart does not resurrect it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "bridge-session.json");
  process.env["RACHEL_SESSION_FILE"] = sessionFile;
  const { runTurn, resetSession, hydratePersistedSession, getSessionId } = await import("../rachel.ts");

  // Simulate a turn that captures and persists a session.
  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield initMessage("session-to-be-reset");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];
  await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);
  assert.equal(readSession(sessionFile), "session-to-be-reset", "sanity: session was persisted before reset");

  resetSession();
  assert.ok(!existsSync(sessionFile), "resetSession must unlink the persisted file, not just clear memory");

  // Simulate the NEXT process starting up: it re-reads the (now absent)
  // persisted file. It must come back clean, NOT the reset session id.
  hydratePersistedSession();
  assert.equal(getSessionId(), undefined, "a fresh process must not resurrect the session /reset just cleared");
});

test("WIRING: RACHEL_SESSION_FILE set — hydratePersistedSession reads a previously written session on startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "bridge-session.json");
  writeSession(sessionFile, "session-from-previous-process");
  process.env["RACHEL_SESSION_FILE"] = sessionFile;
  const { hydratePersistedSession, getSessionId } = await import("../rachel.ts");
  hydratePersistedSession();
  assert.equal(getSessionId(), "session-from-previous-process");
});

test("WIRING: RACHEL_SESSION_FILE set but file absent — hydratePersistedSession starts clean, does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "does-not-exist.json");
  process.env["RACHEL_SESSION_FILE"] = sessionFile;
  const { hydratePersistedSession, getSessionId } = await import("../rachel.ts");
  assert.doesNotThrow(() => hydratePersistedSession());
  assert.equal(getSessionId(), undefined);
});

// ---------------------------------------------------------------------------
// REGRESSION: second-writer hole. rachel.ts documents RACHEL_SESSION_FILE as
// "exactly one writer" (the bridge), but the bridge's plist sets no
// RACHEL_ALLOWED_TOOLS, so bridge turns run with unrestricted Bash. Any
// Bash-spawned child (e.g. a nested `bin/rachel "..."` one-shot, an
// established pattern per prompts/system.md) inherits RACHEL_SESSION_FILE
// via ordinary process env inheritance unless runTurn's options.env strips
// it from the SDK subprocess environment. Without a strip, that child
// captures its own session id and silently clobbers the bridge's live
// session pointer — the next bridge restart resumes the wrong session.
// ---------------------------------------------------------------------------

test("REGRESSION: RACHEL_SESSION_FILE set — runTurn strips it from the SDK subprocess env, preserving other inherited vars", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-test-session-"));
  const sessionFile = join(dir, "bridge-session.json");
  process.env["RACHEL_SESSION_FILE"] = sessionFile;
  const { runTurn } = await import("../rachel.ts");

  let capturedEnv: Record<string, string | undefined> | undefined;
  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((params) => {
    capturedEnv = params.options?.env;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield initMessage("fake-session-strip-check");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];

  await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);

  assert.ok(capturedEnv, "options.env must be set on the query() call when the seam is active");
  assert.equal(
    capturedEnv!["RACHEL_SESSION_FILE"],
    undefined,
    "RACHEL_SESSION_FILE must not reach the SDK subprocess (and anything it spawns via Bash)",
  );
  // Guards against a naive fix that nukes options.env wholesale instead of
  // stripping one key — that would pass the assertion above while breaking
  // every tool execution in production (Bash losing PATH/HOME).
  assert.equal(
    capturedEnv!["PATH"],
    process.env["PATH"],
    "other inherited env vars (PATH) must still reach the SDK subprocess",
  );
});

test("WIRING: RACHEL_SESSION_FILE unset — runTurn does not set options.env at all (byte-for-byte today's CLI/one-shot behaviour)", async () => {
  delete process.env["RACHEL_SESSION_FILE"];
  const { runTurn } = await import("../rachel.ts");

  let capturedEnv: Record<string, string | undefined> | undefined;
  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((params) => {
    capturedEnv = params.options?.env;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield initMessage("fake-session-no-seam");
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];

  await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);

  assert.equal(capturedEnv, undefined, "options.env must stay unset when the seam is inactive, so the SDK keeps managing subprocess env itself");
});
