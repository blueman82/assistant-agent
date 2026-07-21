// Env-safety header — matches bridge/telegram-bridge.test.ts's header
// exactly and for the same reason: tests 5 and 6 below import the REAL
// runTurn from rachel.ts, and importing rachel.ts runs its module-scope
// side effects once (loadTelegramConfig() reading ~/.rachel/telegram.json,
// createQueueApprovalSurface() defaulting to
// ~/.claude/coderails-dashboard/approvals, createSendGateHook() writing
// ~/.rachel/send-gate-audit.jsonl). Without these redirects, a test run
// here could touch the operator's real queue/audit files or a live
// Telegram token. This block MUST stay ahead of every import in this file.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testQueueDir = mkdtempSync(join(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = join(testQueueDir, "audit.jsonl");

// Defense-in-depth, same reasoning as telegram-bridge.test.ts: every test
// here injects its own fake queryFn rather than relying on global fetch, so
// fetch should never fire. Throw loud if it ever does.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in memoryIndex.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "./memoryIndex.ts";

test("absent MEMORY.md leaves the prompt unchanged and does not throw", () => {
  const missingDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const missingPath = join(missingDir, "does-not-exist", "MEMORY.md");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, missingPath);
  assert.equal(result, basePrompt);
});
