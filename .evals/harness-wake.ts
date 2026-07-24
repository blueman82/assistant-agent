// FROZEN EVAL HARNESS — PR 2 (wake channel consumer). Authored blind to the
// implementation, before any code was written. Drives the bridge's PUBLIC seam
// (createBridge + injectable transport + a real temp wake dir on disk) and
// asserts on observable end-state: what the fake Telegram transport recorded,
// and what happened to the wake files on disk. It names no internal symbol.
//
// Usage:
//   node --experimental-strip-types .evals/harness-wake.ts           -> wake files must be consumed
//   EVAL_NEGATIVE_CONTROL=1 node --experimental-strip-types .evals/harness-wake.ts -> negative control
//
// Exit 0 = wake channel observed. Exit 1 = assertion failed (content).
// Exit 3 = harness crash (never a content result).

import { createBridge, type BridgeRunTurn } from "../bridge/telegram-bridge.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// The control leg is selected by an env var rather than a trailing argv
// flag: the eval gate refuses a negative_control that merely appends to
// its cmd, and rightly so — such controls are usually vacuous. This one
// is a genuinely different invocation.
const CONTROL = process.env.EVAL_NEGATIVE_CONTROL === "1";

interface Call { url: string; body: Record<string, unknown> }

function makeTransport(updates: unknown[]) {
  const calls: Call[] = [];
  let n = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url, body });
    if (url.includes("/getUpdates")) {
      const r = updates[Math.min(n, updates.length - 1)] ?? { ok: true, result: [] };
      n++;
      return { ok: true, json: async () => r } as Response;
    }
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 9001 } }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  return { transport, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "eval-wake-"));

  // The wake dir. The spec fixes the location at ~/.rachel/wake/. The
  // implementation is expected to expose a seam for it (every other dir in
  // this bridge does: watchdogDir, heartbeatPath, pushBaseDir), so the
  // harness passes candidate seam names AND falls back to asserting on the
  // real path if the implementation offers no seam at all.
  const wakeDir = join(dir, "wake");
  mkdirSync(wakeDir, { recursive: true });

  const created_at = new Date().toISOString();
  // 1. A tagged narrate wake -> must become a real Rachel turn.
  writeFileSync(join(wakeDir, "adhoc-tunnel.json"), JSON.stringify({
    id: "adhoc-tunnel", source: "adhoc:tunnel", mode: "narrate",
    severity: "info", message: "Tunnel task finished: 3 files changed.", created_at,
  }));
  // 2. A tagged fyi wake -> must reach Telegram WITHOUT starting a turn.
  writeFileSync(join(wakeDir, "sweep-restart.json"), JSON.stringify({
    id: "sweep-restart", source: "sweep:stale-process", mode: "fyi",
    severity: "info", message: "restarted bridge onto abc1234", created_at,
  }));
  // 3. An UNTAGGED wake -> spec's untagged rule: FYI, prefixed
  //    "[untagged wake: <source>]", and it must NEVER start a turn
  //    (unknown producers can't trigger SDK spend).
  writeFileSync(join(wakeDir, "mystery.json"), JSON.stringify({
    id: "mystery", source: "unknown:thing",
    severity: "info", message: "something happened", created_at,
  }));
  // 4. Malformed JSON -> must be renamed .bad, and must not crash the poll loop.
  writeFileSync(join(wakeDir, "broken.json"), "{ this is not json");

  const turnInputs: string[] = [];
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    turnInputs.push(input);
    emit(`handled: ${input}`, "text");
  };

  const { transport, calls } = makeTransport([{ ok: true, result: [] }]);

  // CONTROL: point the bridge at an EMPTY wake dir. Everything else is
  // identical. A correct implementation consumes nothing and the same
  // assertions fail on content — proving the check keys on the wake files
  // themselves, not on the harness merely running.
  const controlDir = join(dir, "empty-wake");
  mkdirSync(controlDir, { recursive: true });
  const activeWakeDir = CONTROL ? controlDir : wakeDir;

  const bridge = createBridge({
    // Candidate seam names for the wake dir. Unknown keys on an options
    // object are inert in TS/JS, so passing several costs nothing and lets
    // this frozen harness survive whichever name the implementer picks.
    wakeDir: activeWakeDir,
    wakeDirPath: activeWakeDir,
    wakePath: activeWakeDir,
    pushBaseDir: join(dir, "proactive"),
    heartbeatPath: join(dir, "heartbeat.json"),
    watchdogDir: join(dir, "loops"),
    nowFn: () => new Date("2026-07-15T11:00:00Z"),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000,
  } as unknown as Parameters<typeof createBridge>[0]);

  // The spec puts the scan in the poll loop: once per getUpdates iteration.
  await bridge.drainOnce();
  await sleep(1500);
  await bridge.stop();

  const problems: string[] = [];
  const remaining = readdirSync(activeWakeDir);
  const sendTexts = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => String(c.body["text"] ?? ""));
  const allText = sendTexts.join("\n");

  // Assertion 1 — a narrate wake started a REAL Rachel turn, carrying the
  // wake's source and message (spec: synthetic FIFO message
  // `[wake: <source>] <message>`).
  const narrateTurn = turnInputs.find((t) => t.includes("adhoc:tunnel") && t.includes("Tunnel task finished"));
  if (!narrateTurn) {
    problems.push(`expected a narrate wake to start a Rachel turn carrying its source and message, got turn inputs: ${JSON.stringify(turnInputs)}`);
  }

  // Assertion 2 — an fyi wake reached Telegram but did NOT start a turn.
  if (!allText.includes("restarted bridge onto abc1234")) {
    problems.push(`expected the fyi wake's message to reach Telegram, got sends: ${JSON.stringify(sendTexts)}`);
  }
  if (turnInputs.some((t) => t.includes("sweep:stale-process"))) {
    problems.push(`an fyi wake must NOT start a Rachel turn, but one did: ${JSON.stringify(turnInputs)}`);
  }

  // Assertion 3 — the untagged rule. FYI-routed, prefixed, never a turn.
  if (!allText.includes("[untagged wake:")) {
    problems.push(`expected an untagged wake to be delivered with an "[untagged wake: ...]" prefix, got sends: ${JSON.stringify(sendTexts)}`);
  }
  if (turnInputs.some((t) => t.includes("unknown:thing"))) {
    problems.push(`an untagged wake must NEVER start a Rachel turn (SDK spend), but one did: ${JSON.stringify(turnInputs)}`);
  }

  // Assertion 4 — consumed files are renamed out of the pending set
  // (at-most-once), and malformed JSON is quarantined as .bad rather than
  // retried forever.
  if (remaining.includes("adhoc-tunnel.json") || remaining.includes("sweep-restart.json") || remaining.includes("mystery.json")) {
    problems.push(`consumed wake files must be renamed out of the pending set (at-most-once), but these remain: ${JSON.stringify(remaining)}`);
  }
  if (!CONTROL && !remaining.some((f) => f.endsWith(".bad"))) {
    problems.push(`malformed wake JSON must be renamed to .bad, got dir contents: ${JSON.stringify(remaining)}`);
  }

  // Assertion 5 — the operator's REAL wake dir was never touched. A wake
  // consumer with no injectable dir would write to ~/.rachel/wake; this
  // pins the seam's existence rather than letting a hardcoded path pass.
  const realWake = join(homedir(), ".rachel", "wake");
  let realWakeEntries: string[] = [];
  try { realWakeEntries = readdirSync(realWake); } catch { /* absent is fine */ }
  if (realWakeEntries.length > 0) {
    problems.push(`the harness's wake dir seam was ignored — the real ${realWake} has entries: ${JSON.stringify(realWakeEntries.slice(0, 5))}`);
  }

  if (problems.length > 0) {
    console.error(`WAKE EVAL FAIL${CONTROL ? " (control — expected)" : ""}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("WAKE EVAL PASS: narrate->turn, fyi->push-only, untagged->prefixed fyi, consumed renamed, malformed quarantined");
  process.exit(0);
}

main().catch((err) => {
  console.error(`HARNESS ERROR (not a content result): ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(3);
});
