// FROZEN EVAL HARNESS — PR 1 (ticker). Authored blind to the implementation,
// before any code was written. Drives the bridge's PUBLIC seam
// (createBridge + injectable fetch-shaped transport) and asserts only on what
// the fake transport RECORDED — never on internal symbols, which the eval
// author cannot know. Oracle-independent by construction: it shares no fixture,
// regex, or test file with the implementation.
//
// Usage:
//   node --experimental-strip-types .evals/harness-ticker.ts          -> real turn (must show ticker)
//   EVAL_NEGATIVE_CONTROL=1 node --experimental-strip-types .evals/harness-ticker.ts -> negative control
//
// Exit 0 = ticker behaviour observed. Exit 1 = assertion failed (content).

import { createBridge, type BridgeRunTurn } from "../bridge/telegram-bridge.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // sendMessage must return a message_id — a ticker implementation needs it
    // to issue editMessageText against.
    if (url.includes("/sendMessage")) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 9001 } }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  return { transport, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "eval-ticker-"));
  const { transport, calls } = makeTransport([
    { ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "run a long job", from: { id: 12345 } } }] },
    { ok: true, result: [] },
  ]);

  // A turn that lasts well past the spec's 3s grace window and emits live
  // tool/text events along the way. The CONTROL variant is the known-bad
  // input: a turn that finishes inside the grace window, where the spec says
  // NO ticker may ever appear — so the same assertion must fail on content.
  const runTurnStub: BridgeRunTurn = async (input, emit) => {
    if (CONTROL) {
      emit("instant answer", "text");
      return;
    }
    emit("  [Bash] npm test", "tool");
    await sleep(2600);
    emit("  [Read] bridge/api.ts", "tool");
    await sleep(2600);
    emit("Job finished.", "text");
  };

  const bridge = createBridge({
    pushBaseDir: join(dir, "proactive"),
    heartbeatPath: join(dir, "heartbeat.json"),
    nowFn: () => new Date("2026-07-15T11:00:00Z"),
    config: { token: "t", chatId: "12345", transport },
    runTurn: runTurnStub,
    getSessionId: () => undefined,
    resetSession: () => {},
    pollIntervalMs: 5,
    typingIntervalMs: 100000, // park the typing indicator out of the way
  });

  await bridge.drainOnce();
  // 7.5s over a ~5.2s turn: enough slack that the merge gate's re-run can't
  // flake, still well inside the gate's 10s per-command cap.
  await sleep(CONTROL ? 400 : 7500);
  await bridge.stop();

  const sends = calls.filter((c) => c.url.includes("/sendMessage"));
  const edits = calls.filter((c) => c.url.includes("/editMessageText"));
  const silentSends = sends.filter((c) => c.body["disable_notification"] === true);

  const problems: string[] = [];

  // Assertion 1 — a silent ticker placeholder was sent (spec: exactly one
  // sendMessage per turn for the ticker, disable_notification: true).
  if (silentSends.length !== 1) {
    problems.push(`expected exactly 1 sendMessage with disable_notification:true (the ticker placeholder), got ${silentSends.length}`);
  }

  // Assertion 2 — the ticker updated in place via editMessageText, more than
  // once (a live-updating ticker, not a one-shot "working..." message).
  // >=1 rather than >=2: at 4-8s jitter over a ~5s turn the number of
  // mid-turn edits is not deterministic, but the spec's terminal edit
  // ("done — <elapsed>") guarantees at least one. Assertions 3 and 4 carry
  // the content weight; this one pins that edit-in-place is the transport.
  if (edits.length < 1) {
    problems.push(`expected >=1 editMessageText call (a ticker that updates in place, not a one-shot message), got ${edits.length}`);
  }

  // Assertion 3 — the ticker text carries elapsed time and the latest live
  // event, per the spec's `working <elapsed> — <latest event>` content rule.
  const editTexts = edits.map((c) => String(c.body["text"] ?? ""));
  const timed = editTexts.filter((t) => /\d+m\d+s|\d+s/.test(t));
  if (timed.length === 0) {
    problems.push(`expected at least one editMessageText whose text carries an elapsed-time reading, got texts: ${JSON.stringify(editTexts.slice(0, 5))}`);
  }
  if (!editTexts.some((t) => t.includes("npm test") || t.includes("bridge/api.ts"))) {
    problems.push(`expected at least one ticker edit to carry the latest live event from runTurn, got texts: ${JSON.stringify(editTexts.slice(0, 5))}`);
  }

  // Assertion 4 — the final reply is still delivered as its own NOTIFYING
  // message. The ticker must not swallow or replace the answer.
  const finalReply = sends.find((c) => String(c.body["text"] ?? "").includes("Job finished.") && c.body["disable_notification"] !== true);
  if (!CONTROL && !finalReply) {
    problems.push(`expected the final reply "Job finished." to be sent as a normal notifying sendMessage, got sends: ${JSON.stringify(sends.map((s) => String(s.body["text"] ?? "").slice(0, 40)))}`);
  }

  if (problems.length > 0) {
    console.error(`TICKER EVAL FAIL${CONTROL ? " (control — expected)" : ""}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("TICKER EVAL PASS: silent placeholder + in-place edits carrying elapsed time and live events + notifying final reply");
  process.exit(0);
}

main().catch((err) => {
  // A harness crash is NOT a content failure — surface it loudly and exit 3
  // so it is never mistaken for a clean assertion failure.
  console.error(`HARNESS ERROR (not a content result): ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(3);
});
