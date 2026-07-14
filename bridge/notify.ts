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

const filePath = process.argv[2];
if (!filePath) {
  console.error("[notify] usage: notify.ts <path-to-message-file>");
  process.exit(2);
}

const text = readFileSync(filePath, "utf8");

const config = loadTelegramConfig();
if (!config) {
  console.error("[notify] no Telegram config (RACHEL_TELEGRAM_TOKEN/RACHEL_TELEGRAM_CHAT_ID or ~/.rachel/telegram.json) — cannot send.");
  process.exit(1);
}

await sendChunked(config, text);
console.log("[notify] sent.");
