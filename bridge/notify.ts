#!/usr/bin/env -S npx tsx
// Standalone proactive-send helper for one-shot Rachel invocations (a
// headless `bin/rachel "..." < /dev/null` run, e.g. from launchd or a
// dashboard button) that need to push a message to Gary's Telegram without
// going through the long-lived bridge's inbound reply loop — that loop only
// runs inside bridge/telegram-bridge.ts, which a one-shot process never
// starts, so its normal assistant-text-reply path has nowhere to go but
// stdout otherwise (this is the gap PR review caught: a scheduled/button
// sweep silently printed to a log instead of reaching Telegram).
//
// Operator-only by design, not a general send tool: it reads the message
// text and sends to whatever chatId loadTelegramConfig() resolves (Gary's
// own configured chat) — there is no destination argument, so this can't be
// used to message a third party. That's what keeps it out of the send-gate's
// threat model (gate/sendGate.ts guards sends to others — Slack channels,
// Calendar invitees — not a notification to the operator's own chat, the same
// trust class as the bridge's own reply/alert messages and the approval
// surface's own sends, both already ungated).
//
// Takes a FILE PATH, not the message as a CLI argument — argv text hits
// shell quoting limits on multi-line briefs, and more importantly a swept
// email whose body happens to contain a string like
// "api.telegram.org/.../sendMessage" would land in the Bash tool_use command
// and trip gate/bashPatterns.ts's send-pattern block on Rachel's own call to
// this script. Reading the text from a file sidesteps both.
import { readFileSync } from "node:fs";
import { sendChunked } from "./api.ts";
import { loadTelegramConfig } from "../gate/surfaces/telegram.ts";

// configFn is injectable so tests can supply fabricated creds + a stub
// transport without touching the operator's real ~/.rachel/telegram.json —
// same seam idiom as rachel.ts's queryFn parameter on runTurn.
export async function notify(
  filePath: string,
  configFn: typeof loadTelegramConfig = loadTelegramConfig,
): Promise<void> {
  const text = readFileSync(filePath, "utf8");
  const config = configFn();
  if (!config) {
    throw new Error("no Telegram config (RACHEL_TELEGRAM_TOKEN/RACHEL_TELEGRAM_CHAT_ID or ~/.rachel/telegram.json) — cannot send.");
  }
  await sendChunked(config, text);
}

// Argv pin: EXACTLY one CLI argument (the message-file path). Extra argv —
// whatever it is — is rejected rather than silently ignored: a stray second
// argument is most plausibly a destination-shaped mistake (or injection
// attempt), and the no-destination contract above only holds if the CLI
// refuses to run rather than quietly dropping it (same pinned invariant as
// proactive/push.ts's five-argument rule).
export function parseNotifyArgv(argv: string[]): string | null {
  return argv.length === 3 ? (argv[2] ?? null) : null;
}

// Only run as a CLI when executed directly (tsx bridge/notify.ts <file>),
// not when imported by a test — same guard rachel.ts uses for its own main().
if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = parseNotifyArgv(process.argv);
  if (!filePath) {
    // The count is diagnostic; argument CONTENT is never echoed (it could be
    // a message body or a destination-shaped injection attempt).
    console.error(`[notify] usage: notify.ts <path-to-message-file> (exactly one argument; received ${process.argv.length - 2})`);
    process.exit(2);
  }
  try {
    await notify(filePath);
    console.log("[notify] sent.");
  } catch (err) {
    console.error(`[notify] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
