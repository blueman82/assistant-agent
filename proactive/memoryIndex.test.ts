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
// The SAFETY test below needs a real (but short) deny-timeout race rather
// than the 60s production default — same reasoning as
// bridge/telegram-bridge.test.ts's own gate-integrity test, and it must be
// set here, before rachel.ts's first import anywhere in this file, since
// rachel.ts's module-scope createSendGateHook(...) call reads it once.
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const testQueueDir = mkdtempSync(join(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
process.env["RACHEL_AUDIT_LOG_PATH"] = join(testQueueDir, "audit.jsonl");
// Same reasoning as the two overrides above: the SAFETY test below calls
// the real runTurn with RACHEL_MEMORY_PATH left at whatever the WIRING test
// restored it to (unset), and resolveMemoryPath() would otherwise fall
// back to the operator's real ~/.rachel/memory/MEMORY.md. Redirect to a
// path that doesn't exist in this tmpdir — an absent index is the normal
// no-memories-yet case, so this resolves via the ENOENT path cleanly.
process.env["RACHEL_MEMORY_PATH"] = join(testQueueDir, "memory", "MEMORY.md");

// Defense-in-depth, same reasoning as telegram-bridge.test.ts: every test
// here injects its own fake queryFn rather than relying on global fetch, so
// fetch should never fire. Throw loud if it ever does.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in memoryIndex.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { GATED_TOOL_NAMES } from "../gate/sendGate.ts";
import { composeSystemPrompt, resolveMemoryPath } from "./memoryIndex.ts";

test("absent MEMORY.md leaves the prompt unchanged and does not throw", () => {
  const missingDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const missingPath = join(missingDir, "does-not-exist", "MEMORY.md");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, missingPath);
  assert.equal(result, basePrompt);
});

test("a present MEMORY.md has its content appear in the composed prompt", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  writeFileSync(memoryPath, "- [Some fact](some-fact.md) — a hook\n");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(result.includes(basePrompt), "base prompt is preserved");
  assert.ok(result.includes("[Some fact](some-fact.md) — a hook"), "index content is present in the composed prompt");
});

test("an index under the size threshold is included unchanged, with no truncation marker", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const smallIndex = "- [Some fact](some-fact.md) — a hook\n";
  writeFileSync(memoryPath, smallIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(result.includes(smallIndex.trim()), "the full index content is present");
  assert.ok(!result.includes("truncated"), "no truncation marker for an under-threshold index");
});

test("an index over the size threshold is truncated with a visible marker, never silently dropped", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  // One line comfortably over 32 KiB total.
  const oversizedIndex = "- [fact](fact.md) — a hook filler text to pad out the line length\n".repeat(600);
  assert.ok(Buffer.byteLength(oversizedIndex, "utf8") > 32 * 1024, "fixture must exceed the 32 KiB threshold");
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(result.includes(basePrompt), "base prompt is preserved");
  assert.ok(/truncat/i.test(result), "a visible marker must tell the agent truncation happened");
  assert.ok(
    Buffer.byteLength(result, "utf8") < Buffer.byteLength(basePrompt + "\n\n" + oversizedIndex, "utf8"),
    "the composed prompt must actually be shorter than the full untruncated index",
  );
  // Not silently dropped — some head of the real content must still be there.
  assert.ok(result.includes("- [fact](fact.md)"), "a truncated head of the real content is still present");
});

test("an index over the size threshold keeps the NEWEST entries and drops the oldest", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  // MEMORY.md is append-ordered: new pointer lines are appended at the end,
  // so the oldest entries are at the head and the newest at the tail. A
  // head-keep truncation (the pre-fix behaviour) evicts the newest —
  // statistically the most relevant — entries. This pins the opposite:
  // tail-keep must preserve the newest and drop the oldest.
  const oldestLine = "- [OLDEST fact](oldest.md) — should be evicted when truncated\n";
  const newestLine = "- [NEWEST fact](newest.md) — should survive truncation\n";
  const filler = "- [fact](fact.md) — a hook filler text to pad out the line length\n".repeat(600);
  const oversizedIndex = `# Memory Index\n\n${oldestLine}${filler}${newestLine}`;
  assert.ok(Buffer.byteLength(oversizedIndex, "utf8") > 32 * 1024, "fixture must exceed the 32 KiB threshold");
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(result.includes(newestLine.trim()), "the newest entry must survive truncation");
  assert.ok(!result.includes(oldestLine.trim()), "the oldest entry must be evicted by truncation");
});

test("REGRESSION: a multi-byte character straddling the HEAD truncation boundary is not cut mid-character (no replacement char)", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const MAX_INDEX_BYTES = 32 * 1024;
  // "a" x (MAX-1) fills to one byte short of the cap; the 3-byte "—" (em
  // dash, U+2014) then straddles the MAX_INDEX_BYTES boundary exactly —
  // a naive Buffer.subarray(0, MAX) cut lands inside its multi-byte
  // encoding and Buffer#toString("utf8") replaces the truncated bytes with
  // U+FFFD (�). Kept as a head-boundary regression even though the kept
  // slice is now the tail: tail-keep still computes a head-relative cut
  // point (total length minus MAX_INDEX_BYTES) that this fixture straddles.
  const oversizedIndex = "a".repeat(MAX_INDEX_BYTES - 1) + "—tail" + "b".repeat(200);
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(!result.includes("�"), "truncation must not produce a UTF-8 replacement character");
  assert.ok(/truncat/i.test(result), "the truncation marker must still be present");
});

test("REGRESSION: a multi-byte character straddling the TAIL-cut start boundary is not cut mid-character (no replacement char)", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const MAX_INDEX_BYTES = 32 * 1024;
  // Tail-keep keeps the LAST MAX_INDEX_BYTES bytes, so the cut point is at
  // byte offset (total length - MAX_INDEX_BYTES) from the start. Build a
  // fixture where a 3-byte em dash (U+2014) straddles exactly that offset:
  // prefix is sized so the cut point falls one byte INTO the em dash's
  // encoding, then padding follows so the em dash and trailing content are
  // within the kept tail window.
  const prefixLen = MAX_INDEX_BYTES + 100 - 1; // cut point lands 1 byte into the em dash below
  const oversizedIndex = "a".repeat(prefixLen) + "—tail-marker" + "b".repeat(200);
  assert.ok(Buffer.byteLength(oversizedIndex, "utf8") > MAX_INDEX_BYTES, "fixture must exceed the threshold");
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(!result.includes("�"), "truncation must not produce a UTF-8 replacement character");
  assert.ok(/truncat/i.test(result), "the truncation marker must still be present");
  assert.ok(result.includes("b".repeat(200)), "tail content after the straddling character must survive");
});

test("a tail truncation cut does not land mid-line — no half pointer-line in the output", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const MAX_INDEX_BYTES = 32 * 1024;
  // Build many fixed-width pointer lines so the raw byte cut point (total -
  // MAX_INDEX_BYTES) is very unlikely to fall exactly on a line boundary,
  // forcing the implementation to snap forward to the next newline rather
  // than emit a truncated half-line.
  const line = "- [fact](fact.md) — a hook filler text to pad out this line to a fixed width\n";
  const lineBytes = Buffer.byteLength(line, "utf8");
  const lineCount = Math.ceil((MAX_INDEX_BYTES * 2) / lineBytes);
  const oversizedIndex = "# Memory Index\n\n" + line.repeat(lineCount);
  assert.ok(Buffer.byteLength(oversizedIndex, "utf8") > MAX_INDEX_BYTES, "fixture must exceed the threshold");
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  const bodyLines = result
    .split("\n")
    .filter((l) => l.startsWith("- [") || (l.length > 0 && !l.startsWith("#") && !l.startsWith("[MEMORY.md")));
  for (const bodyLine of bodyLines) {
    assert.ok(
      bodyLine === line.trimEnd() || bodyLine.trim() === "",
      `no half pointer-line expected, got: ${JSON.stringify(bodyLine)}`,
    );
  }
});

test("the truncation marker names that OLDER entries were dropped", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const oversizedIndex = "- [fact](fact.md) — a hook filler text to pad out the line length\n".repeat(600);
  assert.ok(Buffer.byteLength(oversizedIndex, "utf8") > 32 * 1024, "fixture must exceed the 32 KiB threshold");
  writeFileSync(memoryPath, oversizedIndex);
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.ok(
    /older/i.test(result),
    "the truncation marker must explicitly say OLDER entries were dropped (tail-keep semantics), not just 'truncated'",
  );
});

test("an empty MEMORY.md (zero bytes) leaves the prompt unchanged, with no trailing whitespace appended", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  writeFileSync(memoryPath, "");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.equal(result, basePrompt);
});

test("a whitespace-only MEMORY.md leaves the prompt unchanged, with no trailing whitespace appended", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  writeFileSync(memoryPath, "   \n\n  \n");
  const basePrompt = "You are Rachel.";
  const result = composeSystemPrompt(basePrompt, memoryPath);
  assert.equal(result, basePrompt);
});

test("a non-ENOENT read failure throws loud with the file path named", () => {
  // Point the "file" path at a directory, not a file — readFileSync throws
  // EISDIR, a non-ENOENT failure that must NOT be silently swallowed the
  // way an absent file is (proactive/push.ts's readJson draws the same
  // ENOENT-only line: a corrupt/unreadable store must fail loud, never be
  // read as empty).
  const dirAsFile = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  assert.throws(
    () => composeSystemPrompt("You are Rachel.", dirAsFile),
    (err: unknown) => err instanceof Error && err.message.includes(dirAsFile),
  );
});

test("RACHEL_MEMORY_PATH overrides the default ~/.rachel/memory/MEMORY.md path", () => {
  const original = process.env["RACHEL_MEMORY_PATH"];
  try {
    process.env["RACHEL_MEMORY_PATH"] = "/tmp/some/override/MEMORY.md";
    assert.equal(resolveMemoryPath(), "/tmp/some/override/MEMORY.md");
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

test("unset RACHEL_MEMORY_PATH resolves to ~/.rachel/memory/MEMORY.md", () => {
  const original = process.env["RACHEL_MEMORY_PATH"];
  try {
    delete process.env["RACHEL_MEMORY_PATH"];
    assert.equal(resolveMemoryPath(), join(homedir(), ".rachel", "memory", "MEMORY.md"));
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

test("WIRING: runTurn passes a system prompt containing the memory index to queryFn's options", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "rachel-test-memory-"));
  const memoryPath = join(memoryDir, "MEMORY.md");
  const sentinel = "- [Sentinel fact](sentinel.md) — unique marker for this test";
  writeFileSync(memoryPath, `${sentinel}\n`);

  const original = process.env["RACHEL_MEMORY_PATH"];
  process.env["RACHEL_MEMORY_PATH"] = memoryPath;
  try {
    const { runTurn } = await import("../rachel.ts");

    let capturedOptions: Record<string, unknown> | undefined;
    // Captures the `options` object queryFn receives from runTurn, so this
    // test can assert on it without hitting the network. Yields a minimal
    // init message so runTurn's stream-consuming loop completes normally.
    const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
      capturedOptions = _params.options as Record<string, unknown>;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
      }
      return generate();
    }) as Parameters<typeof runTurn>[3];

    await runTurn("hello", () => {}, new AbortController().signal, fakeQueryFn);

    assert.ok(capturedOptions, "queryFn was invoked with options");
    const agents = capturedOptions!["agents"] as { rachel?: { prompt?: string } } | undefined;
    assert.ok(agents?.rachel?.prompt, "options.agents.rachel.prompt is set");
    assert.ok(
      agents!.rachel!.prompt!.includes(sentinel),
      "the composed prompt passed to the SDK includes the memory index content",
    );
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_MEMORY_PATH"];
    } else {
      process.env["RACHEL_MEMORY_PATH"] = original;
    }
  }
});

// MANDATORY safety-critical assertion: this PR touches the same `options`
// object where the send-approval gate is wired as a PreToolUse hook
// (rachel.ts's hooks.PreToolUse). A silent detach of that wiring would not
// crash anything — the first symptom would be an unapproved Slack or
// Calendar send going out. bridge/telegram-bridge.test.ts protects this
// only incidentally (its own comment says so); this test names the
// invariant explicitly for this PR's change.
test("SAFETY: the send-approval gate hook is still wired into runTurn's options after this change, and denies a gated tool call", async () => {
  const { runTurn } = await import("../rachel.ts");

  type FakeHookCallback = (
    input: unknown,
    toolUseID: string | undefined,
    options: { signal: AbortSignal },
  ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

  // Captured synchronously as soon as queryFn is invoked, BEFORE the
  // generator yields anything — not asserted on here. This removes any
  // dependency on how node:test's `for await` drives the generator relative
  // to the test's own completion detection (the prior shape asserted
  // inside the generator and, per review, was observed to flake once in
  // ~26 runs on exactly that ordering). All assertions happen after
  // `await runTurn(...)` resolves, below.
  let capturedOptions: { hooks?: Record<string, { hooks: unknown[] }[]> } | undefined;

  const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
    capturedOptions = _params.options as { hooks?: Record<string, { hooks: unknown[] }[]> } | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
    }
    return generate();
  }) as Parameters<typeof runTurn>[3];

  await runTurn("send a slack message", () => {}, new AbortController().signal, fakeQueryFn);

  const preToolUseHooks = capturedOptions?.hooks?.["PreToolUse"];
  assert.ok(
    preToolUseHooks && preToolUseHooks.length > 0,
    "options.hooks.PreToolUse must be present — the send gate must stay wired after this change",
  );
  const hook = preToolUseHooks![0]!.hooks[0] as FakeHookCallback;

  const result = await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: GATED_TOOL_NAMES[0]!,
      tool_input: { channel: "#general", text: "unauthorised send" },
    },
    undefined,
    { signal: new AbortController().signal },
  );
  const hookDecision = result.hookSpecificOutput?.permissionDecision;

  assert.equal(hookDecision, "deny", "a gated tool call with no approval surface resolving must be denied, not allowed");
});
