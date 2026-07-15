---
title: "Inbox Brief"
slug: inbox-brief
status: active
---

Sweep Gary's Gmail and send him a concise Inbox Brief on Telegram. This is a recommend-only capability: you NEVER send an email, NEVER unsubscribe, NEVER delete, and NEVER archive without being asked. At most you may create a draft or apply a label — everything else is a recommendation for Gary to action himself. (Belt-and-braces note: Gary's Gmail MCP connector has no send or hard-delete tool at all — but it does have `unlabel_thread`/`unlabel_message`, and removing the INBOX label is effectively archiving, so this rule is not literally unbypassable by the connector's shape. Follow the recommend-only instruction; don't rely on tool absence alone.)

Steps:

1. Search recent mail with `mcp__claude_ai_Gmail__search_threads` — unread threads and anything from the last ~24h (e.g. `is:unread newer_than:1d`).
2. For each thread, read enough (`mcp__claude_ai_Gmail__get_thread`) to classify it by content:
   - **Urgent** — security alerts (failed logins, suspicious activity, account compromise) or anything requiring same-day action from Gary.
   - **Action required** — a real person waiting on a reply or decision; not same-day but needs a response soon.
   - **FYI** — confirmations, receipts, shipping notices, account/service notifications Gary didn't ask to act on. Read once, done.
   - **Appointment** — calendar-related emails only. Always state explicitly: "upcoming: [date time]" or "passed: [date time]". Never leave the timing ambiguous.
   - **Noise** — newsletters, marketing, promos, automated system emails Gary didn't request.
   - **Unsubscribe** — recurring noise from the same sender appearing repeatedly; Gary should kill it at source.

   Classification is based on email content and what action (if any) is needed — not on read/unread status.
3. For each thread, recommend one action: reply / archive / unsubscribe / ignore. Don't perform any of these — just name the recommendation.
4. Push Urgent and Action required threads individually through the proactive chokepoint (push.ts), one push per thread:
   - **Urgent** threads are pushed individually via the push.ts CLI at severity `urgent`: `Write` a one-line message file (e.g. `/tmp/inbox-push-<timestamp>.txt`) reading `[urgent · mail] <sender>: <subject gist> — <one-line why>`, then run from the repo root via Bash:
     ```
     ./node_modules/.bin/tsx proactive/push.ts mail "mail:<threadId>" "urgent:<latest-message-id>" urgent <message-file>
     ```
   - **Action required** threads are pushed the same way at severity `normal`, with the leading tag `[mail]` and state `"action-required:<latest-message-id>"`:
     ```
     ./node_modules/.bin/tsx proactive/push.ts mail "mail:<threadId>" "action-required:<latest-message-id>" normal <message-file>
     ```
   - The event-id is exactly `mail:<threadId>`, where `<threadId>` is the thread's id from the `get_thread` response — the thread id, NOT a message id. The state is exactly `<tier>:<latest-message-id>`, where `<latest-message-id>` is the id of the newest message in the thread — this is what re-arms the ping when an already-pinged thread gets a new reply (a tier-only state would suppress it forever).
   - Exactly five CLI arguments always — family, event-id, state, severity, message-file — and the message text always comes from the FILE, never from argv.
   - Check each result: exit 0 with any of `[push] sent.` / `[push] deferred.` / `[push] dedup.` counts as success (deferred and dedup are the chokepoint's dedup/quiet/budget judgement working, not failures). A nonzero exit is a delivery failure — state it plainly in your turn output, never report a clean sweep in that case.
5. Assemble a CONCISE brief, not a wall of text. Threads already routed through push.ts this run — whatever the result (sent, deferred, or dedup) — are EXCLUDED from the batch brief below. The brief covers only FYI, Appointment, Noise, and Unsubscribe threads. (A dedup'd thread was pushed on an earlier run; re-surfacing it in the brief is the same double delivery.) Start the brief's first line with the `[digest]` tag. Group by classification, **Urgent first** — the Urgent/Action required groups are non-empty only when a thread fell back into the brief because its individual push FAILED (nonzero exit, which is none of the three results above); threads push.ts accepted never re-appear here. A few words per item (sender, subject gist, recommended action) — this is read on a phone in Telegram, not a report. Keep it well under 4096 characters (Telegram's single-message limit) — if the sweep turns up so much mail that a full brief would run longer, trim detail rather than let it split across multiple messages; a one-item-per-line summary always fits.
6. Deliver the brief to Telegram — this step matters: when you're run headlessly (no bridge in front of you, e.g. from launchd or a dashboard button), your ordinary reply text only reaches stdout/a log file, not Gary's phone. So deliver it explicitly instead:
   - `Write` the assembled brief (plain text, no markdown) to a scratch file, e.g. `/tmp/inbox-brief-<timestamp>.txt`.
   - Run `./node_modules/.bin/tsx bridge/notify.ts <path-to-that-file>` via Bash (from the repo root) to actually send it. Do NOT construct a raw `curl`/HTTP call to the Telegram API yourself — always use this script, which reuses the same sender the Telegram bridge itself uses.
   - **Check the result, don't assume it worked**: confirm the command exited 0 and printed `[notify] sent.`. If it did NOT — nonzero exit, or no `[notify] sent.` line — the brief did NOT reach Gary. Do not report the sweep as a success in that case; say plainly in your turn output that delivery failed (the dashboard-button run route captures and streams this turn output, so a stated failure is visible even without Telegram).
   - If there's nothing needing attention but there IS new mail since the last sweep (all of it noise), still write and send a brief one-liner saying so — don't skip the send step just because nothing needs action, or Gary never learns the sweep ran clean.

Skip entirely — no write, no send — only when there's nothing new since the last sweep at all (no unread, nothing in the last 24h). That's the one case where sending nothing is correct; every other case (even an all-noise sweep) still sends a brief per the step above.
