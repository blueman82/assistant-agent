// Env-safety header — same idiom and reason as proactive/memoryIndex.test.ts:
// the WIRING test below imports the REAL rachel.ts, and importing it runs
// its module-scope side effects once (loadTelegramConfig(),
// createQueueApprovalSurface(), createSendGateHook() writing the real audit
// log). This block MUST stay ahead of every import in this file.
process.env["RACHEL_TELEGRAM_TOKEN"] = "000000000:FAKE-TEST-TOKEN";
process.env["RACHEL_TELEGRAM_CHAT_ID"] = "1";
process.env["RACHEL_GATE_TIMEOUT_MS"] = "200";

import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join as joinPath } from "node:path";

const testQueueDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-queue-"));
process.env["RACHEL_QUEUE_DIR"] = testQueueDir;
const testAuditLogPath = joinPath(testQueueDir, "audit.jsonl");
process.env["RACHEL_AUDIT_LOG_PATH"] = testAuditLogPath;
process.env["RACHEL_MEMORY_PATH"] = joinPath(testQueueDir, "memory", "MEMORY.md");

globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(`Unexpected real fetch() call in memoryGate.test.ts — all transports must be stubbed. Called with: ${String(args[0])}`);
}) as typeof fetch;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createMemoryGateHook } from "./memoryGate.ts";
import type { PreToolUseHookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

function permissionDecisionOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision
    : undefined;
}

function reasonOf(output: HookJSONOutput): string | undefined {
  return "hookSpecificOutput" in output
    ? (output.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason
    : undefined;
}

function makeWriteInput(filePath: string, content: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd: "/tmp",
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
  } as PreToolUseHookInput;
}

function withUntrustedFlag(fn: () => Promise<void>): Promise<void> {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  // Literal value from tasks/inbox-brief-launchd.plist (SO-17: reproduce the
  // real shape, not a simplified stand-in).
  process.env["RACHEL_UNTRUSTED_CONTENT"] = "1";
  return fn().finally(() => {
    if (original === undefined) {
      delete process.env["RACHEL_UNTRUSTED_CONTENT"];
    } else {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  });
}

test("RACHEL_UNTRUSTED_CONTENT set + Write into memory dir -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\n---\n");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT unset + Write into memory dir -> pass-through (not this check's concern)", async () => {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  delete process.env["RACHEL_UNTRUSTED_CONTENT"];
  try {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\ndescription: x\ntype: preference\n---\nbody");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  } finally {
    if (original !== undefined) {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  }
});

test("RACHEL_UNTRUSTED_CONTENT set + Write OUTSIDE memory dir -> pass-through", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = makeWriteInput("/Users/harrison/Github/assistant-agent/tasks/2026-07-23-something.md", "content");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

// --- Path-normalisation bypasses (security review finding) ---
// gate/memoryGate.ts used a raw `filePath.includes(MEMORY_DIR)` substring
// test, which a model-supplied path can defeat with forms that
// path.resolve() collapses to the exact protected file, or that a
// case-insensitive filesystem (confirmed on this machine) resolves to the
// same inode despite differing case. Each test below targets one bypass
// form and must FAIL against the unfixed includes() implementation before
// the fix — that is the acceptance criterion (SO-15).

test("RACHEL_UNTRUSTED_CONTENT set + Write via dot-segment path (~/.rachel/./memory/x.md) -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    // Built as a raw template string, NOT via path.join/joinPath — join()
    // normalises the "." segment away during construction, which would
    // make this fixture already-canonical and never exercise the bypass
    // (the exact vacuous-test trap this suite must avoid).
    const dotSegmentPath = `${homedir()}/.rachel/./memory/attacker.md`;
    const input = makeWriteInput(dotSegmentPath, "attacker text");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny", "a dot-segment path resolving into the memory dir must still be denied");
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via doubled-slash path (~/.rachel//memory/x.md) -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const doubledSlashPath = `${homedir()}/.rachel//memory/attacker.md`;
    const input = makeWriteInput(doubledSlashPath, "attacker text");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny", "a doubled-slash path resolving into the memory dir must still be denied");
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via case-variant path (~/.Rachel/Memory/x.md) -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const caseVariantPath = `${homedir()}/.Rachel/Memory/attacker.md`;
    const input = makeWriteInput(caseVariantPath, "attacker text");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny", "a case-variant path resolving into the memory dir on a case-insensitive filesystem must still be denied");
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via canonical path (control) -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const canonicalPath = joinPath(homedir(), ".rachel", "memory", "attacker.md");
    const input = makeWriteInput(canonicalPath, "attacker text");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny", "the canonical form must still be denied — sanity control for the bypass tests above");
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via a genuinely different sibling dir (~/.rachel/memory-notes/x.md) -> pass-through", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    // A prefix match without a separator boundary would wrongly treat this
    // sibling directory as inside the memory dir. Must NOT deny.
    const siblingPath = joinPath(homedir(), ".rachel", "memory-notes", "unrelated.md");
    const input = makeWriteInput(siblingPath, "unrelated content");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {}, "a sibling directory sharing the memory dir's name as a prefix must not be denied");
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via a symlink pointing at the memory dir -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    // Symlink lives in an isolated mkdtempSync scratch dir, never inside the
    // repo or the real ~/.rachel/ — cleaned up in finally.
    const scratchDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-symlink-"));
    mkdirSync(joinPath(homedir(), ".rachel", "memory"), { recursive: true });
    const linkPath = joinPath(scratchDir, "shortcut");
    symlinkSync(joinPath(homedir(), ".rachel", "memory"), linkPath);
    try {
      // path.resolve() alone does NOT follow symlinks — it only collapses
      // "." / ".." / doubled separators lexically. A write through this
      // symlink lexically resolves to a path under scratchDir, which is
      // outside MEMORY_DIR by pure string comparison, but the filesystem
      // target is the real memory directory. This is the bypass a
      // realpathSync-based check must close.
      const symlinkTargetPath = joinPath(linkPath, "attacker.md");
      const input = makeWriteInput(symlinkTargetPath, "attacker text");
      const result = await hook(input, undefined, { signal: new AbortController().signal });
      assert.equal(permissionDecisionOf(result), "deny", "a write through a symlink resolving into the memory dir must still be denied");
    } finally {
      unlinkSync(linkPath);
    }
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via symlink into memory dir, behind an UNREADABLE ancestor -> deny (fail-closed on EACCES)", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    // Discriminating fixture (security review, 2026-07-24): an unreadable
    // ancestor alone proves nothing — a path outside the memory dir with an
    // unresolvable ancestor is correctly ALLOWED regardless (see the control
    // test below). The bug only shows when the unresolvable ancestor is
    // HIDING a symlink into the memory dir: realpathSync throws EACCES (not
    // ENOENT) on the way down to it, and resolveReal()'s original
    // catch-everything fallback silently returned the lexical (wrong,
    // outside-memory-dir) path instead of propagating the failure, letting
    // the write through even though the real target is inside the memory
    // dir.
    const scratchDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-eacces-"));
    mkdirSync(joinPath(homedir(), ".rachel", "memory"), { recursive: true });
    const blockedDir = joinPath(scratchDir, "blocked");
    mkdirSync(blockedDir);
    const innerLink = joinPath(blockedDir, "inner");
    symlinkSync(joinPath(homedir(), ".rachel", "memory"), innerLink);
    chmodSync(blockedDir, 0o000);
    try {
      const writeTarget = joinPath(innerLink, "attacker.md");
      const input = makeWriteInput(writeTarget, "attacker text");
      const result = await hook(input, undefined, { signal: new AbortController().signal });
      assert.equal(permissionDecisionOf(result), "deny", "an unresolvable ancestor hiding a memory-dir symlink must fail CLOSED, not silently allow");
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Write via a symlink CYCLE (ELOOP) -> deny (fail-closed, same error class as EACCES)", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    // Same underlying fix as the EACCES test above (resolveReal's
    // ENOENT-vs-other-errno distinction), a different errno hitting the
    // same code path: a symlink cycle makes realpathSync throw ELOOP, not
    // ENOENT. This target does not point into the memory dir at all — it
    // can't, a cycle resolves to nothing — but per the fail-closed policy,
    // an unresolvable path under RACHEL_UNTRUSTED_CONTENT denies regardless
    // of what it would have resolved to, since resolution failing means the
    // real target is unknowable. Pins the whole non-ENOENT error class
    // rather than only the one errno (EACCES) the discriminating fixture
    // happened to construct.
    const scratchDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-eloop-"));
    const loopA = joinPath(scratchDir, "loopA");
    const loopB = joinPath(scratchDir, "loopB");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    const writeTarget = joinPath(loopA, "attacker.md");
    const input = makeWriteInput(writeTarget, "attacker text");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny", "a symlink cycle (ELOOP) must fail CLOSED under RACHEL_UNTRUSTED_CONTENT, same as EACCES");
  });
});

test("RACHEL_UNTRUSTED_CONTENT UNSET + Write via an UNREADABLE ancestor pointing at a NON-memory target -> pass-through (trusted-path control)", async () => {
  // Deliberately NOT wrapped in withUntrustedFlag: this is the OTHER half
  // of the fix's fail-closed/fail-open split. Under RACHEL_UNTRUSTED_CONTENT
  // ANY resolution failure denies (see the test above — you cannot know
  // whether an unresolvable ancestor is hiding a memory-dir target, so
  // ambiguity always denies there). But the schema-validation branch runs
  // UNCONDITIONALLY, not just when untrusted — so in the normal trusted
  // CLI/bridge path, an unresolvable ancestor must NOT start denying
  // Rachel's ordinary writes just because realpathSync hit a permission
  // quirk. isInsideMemoryDirPermissive() is the trusted-path variant: it
  // catches a resolution failure and falls back to the pre-symlink-fix
  // lexical comparison rather than newly blocking.
  const hook = createMemoryGateHook(testAuditLogPath);
  const scratchDir = mkdtempSync(joinPath(tmpdir(), "rachel-test-eacces-control-"));
  const blockedDir = joinPath(scratchDir, "blocked");
  mkdirSync(blockedDir);
  const innerDir = joinPath(blockedDir, "unrelated");
  mkdirSync(innerDir);
  chmodSync(blockedDir, 0o000);
  try {
    const writeTarget = joinPath(innerDir, "notes.md");
    const input = makeWriteInput(writeTarget, "unrelated content, no frontmatter");
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {}, "an unresolvable ancestor must not start denying ordinary trusted-path writes");
  } finally {
    chmodSync(blockedDir, 0o755);
  }
});

test("RACHEL_UNTRUSTED_CONTENT set + Edit into memory dir -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/harrison/.rachel/memory/some-fact.md",
        old_string: "a",
        new_string: "attacker-controlled text",
      },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Bash command string-matching the memory path -> deny", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "echo 'attacker text' >> ~/.rachel/memory/some-fact.md" },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.equal(permissionDecisionOf(result), "deny");
    assert.match(reasonOf(result) ?? "", /untrusted/i);
  });
});

test("RACHEL_UNTRUSTED_CONTENT set + Bash command NOT touching memory path -> pass-through", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = {
      hook_event_name: "PreToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls -la /tmp" },
    } as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

test("non-PreToolUse hook event -> pass-through with empty object even when untrusted", async () => {
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(testAuditLogPath);
    const input = {
      hook_event_name: "PostToolUse",
      session_id: "test-session",
      transcript_path: "/dev/null",
      cwd: "/tmp",
      tool_name: "Write",
      tool_input: { file_path: "/Users/harrison/.rachel/memory/some-fact.md", content: "x" },
    } as unknown as PreToolUseHookInput;
    const result = await hook(input, undefined, { signal: new AbortController().signal });
    assert.deepEqual(result, {});
  });
});

test("hook throws exception -> deny with 'Internal hook error' reason (fail-closed)", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const input = new Proxy({} as PreToolUseHookInput, {
    get: () => {
      throw new Error("input threw");
    },
  });
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /Internal hook error/);
});

// --- Audit logging (security review finding, 2026-07-24): every deny path
// must leave a durable record, not just return a decision to the SDK. ---

test("RACHEL_UNTRUSTED_CONTENT set + Write into memory dir -> deny is audit-logged", async () => {
  const auditPath = joinPath(mkdtempSync(joinPath(tmpdir(), "memorygate-audit-")), "audit.jsonl");
  await withUntrustedFlag(async () => {
    const hook = createMemoryGateHook(auditPath);
    const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\n---\n");
    await hook(input, undefined, { signal: new AbortController().signal });
  });
  const rows = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "decision");
  assert.equal(rows[0].decision, "deny");
  assert.equal(rows[0].surface, "untrusted-lockout");
  assert.equal(rows[0].toolName, "Write");
});

test("Write of a memory fact file with bad frontmatter -> deny is audit-logged", async () => {
  const auditPath = joinPath(mkdtempSync(joinPath(tmpdir(), "memorygate-audit-")), "audit.jsonl");
  const hook = createMemoryGateHook(auditPath);
  const badContent = "---\nname: some-fact\ndescription: a one-line fact\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", badContent);
  await hook(input, undefined, { signal: new AbortController().signal });
  const rows = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "deny");
  assert.equal(rows[0].surface, "frontmatter-schema");
});

test("hook throws exception -> the actual error is audit-logged, not just a generic deny", async () => {
  const auditPath = joinPath(mkdtempSync(joinPath(tmpdir(), "memorygate-audit-")), "audit.jsonl");
  const hook = createMemoryGateHook(auditPath);
  const input = new Proxy({} as PreToolUseHookInput, {
    get: (_target, prop) => {
      if (prop === "hook_event_name") {
        return "PreToolUse";
      }
      if (prop === "tool_name") {
        return "Write";
      }
      throw new Error("boom: simulated internal failure");
    },
  });
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  const rows = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, "internal-error");
  assert.equal(rows[0].decision, "deny");
  assert.match(rows[0].errorMessage, /boom: simulated internal failure/);
});

test("a call that produces no deny writes no audit row (pass-through is not logged as an event)", async () => {
  const auditPath = joinPath(mkdtempSync(joinPath(tmpdir(), "memorygate-audit-")), "audit.jsonl");
  const hook = createMemoryGateHook(auditPath);
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", "---\nname: some-fact\n---\n");
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
  assert.throws(() => readFileSync(auditPath));
});

// --- (b) Frontmatter schema validation on memory writes (all contexts) ---

test("Write of a memory fact file with valid frontmatter -> pass-through", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const validContent = "---\nname: some-fact\ndescription: a one-line fact\ntype: preference\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", validContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a memory fact file MISSING only the optional date field -> pass-through (warning-level finding must not block)", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  // name/description/type all present and valid; date is absent, which
  // validateFrontmatter reports as a warning-level missing-date finding.
  // Gary's live store has pre-existing files without a date field, so this
  // must never block — only error-level findings may deny.
  const contentMissingDateOnly = "---\nname: some-fact\ndescription: a one-line fact\ntype: preference\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", contentMissingDateOnly);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {}, "a warning-level-only finding set must pass through, not deny");
});

test("Write of a memory fact file MISSING a required frontmatter field -> deny naming the missing field", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  // Missing "type" entirely.
  const badContent = "---\nname: some-fact\ndescription: a one-line fact\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", badContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /type/);
});

test("Write of a memory fact file with an INVALID type value -> deny naming the bad value", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const badContent = "---\nname: some-fact\ndescription: a one-line fact\ntype: user\n---\n\nBody text.\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/some-fact.md", badContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.equal(permissionDecisionOf(result), "deny");
  assert.match(reasonOf(result) ?? "", /type/);
});

test("Write to MEMORY.md (the index, not a fact file) -> schema check does not apply", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const indexContent = "- [Some fact](some-fact.md) — a hook\n";
  const input = makeWriteInput("/Users/harrison/.rachel/memory/MEMORY.md", indexContent);
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a non-.md file inside the memory dir -> schema check does not apply", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const input = makeWriteInput("/Users/harrison/.rachel/memory/notes.txt", "arbitrary content");
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

test("Write of a .md file OUTSIDE the memory dir with bad frontmatter -> schema check does not apply", async () => {
  const hook = createMemoryGateHook(testAuditLogPath);
  const input = makeWriteInput("/Users/harrison/Github/assistant-agent/tasks/2026-07-23-something.md", "no frontmatter at all");
  const result = await hook(input, undefined, { signal: new AbortController().signal });
  assert.deepEqual(result, {});
});

// --- SO-8: drive the real FEATURE end to end, not just the callback in
// isolation. This proves memoryGateHook is actually wired into runTurn's
// options.hooks.PreToolUse array (3rd position) and that setting
// RACHEL_UNTRUSTED_CONTENT on a real turn actually denies a memory write —
// not just that the standalone callback returns the right shape.
test("WIRING+SAFETY: a real turn with RACHEL_UNTRUSTED_CONTENT set denies a memory-dir Write via the wired hook", async () => {
  const original = process.env["RACHEL_UNTRUSTED_CONTENT"];
  process.env["RACHEL_UNTRUSTED_CONTENT"] = "1";
  try {
    const { runTurn } = await import("../rachel.ts");

    type FakeHookCallback = (
      input: unknown,
      toolUseID: string | undefined,
      options: { signal: AbortSignal },
    ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;

    let capturedOptions: { hooks?: Record<string, { hooks: FakeHookCallback[] }[]> } | undefined;

    const fakeQueryFn: Parameters<typeof runTurn>[3] = ((_params) => {
      capturedOptions = _params.options as typeof capturedOptions;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield { type: "system", subtype: "init", session_id: "fake-session" } as unknown as SDKMessage;
      }
      return generate();
    }) as Parameters<typeof runTurn>[3];

    await runTurn("remember something", () => {}, new AbortController().signal, fakeQueryFn);

    const preToolUseHooks = capturedOptions?.hooks?.["PreToolUse"];
    assert.ok(preToolUseHooks && preToolUseHooks.length > 0, "options.hooks.PreToolUse must be present");
    const wiredHooks = preToolUseHooks![0]!.hooks;
    assert.equal(wiredHooks.length, 3, "expected 3 PreToolUse hooks after this PR's addition (sendGate, askUserQuestion, memoryGate)");
    const memoryHook = wiredHooks[2]!;

    const result = await memoryHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "test-session",
        transcript_path: "/dev/null",
        cwd: "/tmp",
        tool_name: "Write",
        tool_input: { file_path: "/Users/harrison/.rachel/memory/attacker-planted.md", content: "attacker text" },
      },
      undefined,
      { signal: new AbortController().signal },
    );

    assert.equal(result.hookSpecificOutput?.permissionDecision, "deny", "the wired 3rd hook must deny a memory write when RACHEL_UNTRUSTED_CONTENT is set");
    assert.match(result.hookSpecificOutput?.permissionDecisionReason ?? "", /untrusted/i);
  } finally {
    if (original === undefined) {
      delete process.env["RACHEL_UNTRUSTED_CONTENT"];
    } else {
      process.env["RACHEL_UNTRUSTED_CONTENT"] = original;
    }
  }
});
