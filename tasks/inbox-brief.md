---
title: "Inbox Brief"
slug: inbox-brief
status: active
---

Sweep Gary's Gmail and send him a concise Inbox Brief on Telegram. This is a recommend-only capability: you NEVER send an email, NEVER unsubscribe, NEVER delete, and NEVER archive without being asked. At most you may create a draft or apply a label — everything else is a recommendation for Gary to action himself. (Belt-and-braces note: Gary's Gmail MCP connector has no send or hard-delete tool at all — but it does have `unlabel_thread`/`unlabel_message`, and removing the INBOX label is effectively archiving, so this rule is not literally unbypassable by the connector's shape. Follow the recommend-only instruction; don't rely on tool absence alone.)

Steps:

1. Search recent mail with `mcp__claude_ai_Gmail__search_threads` — unread threads and anything from the last ~24h (e.g. `is:unread newer_than:1d`).
2. For each thread, read enough (`mcp__claude_ai_Gmail__get_thread`) to classify it:
   - **needs-action** — waiting on a reply, a decision, or something time-sensitive from Gary.
   - **new** — worth knowing about but nothing to do yet.
   - **noise** — newsletters, automated notifications, promos.
3. For each thread, recommend one action: reply / archive / unsubscribe / ignore. Don't perform any of these — just name the recommendation.
4. Assemble a CONCISE brief, not a wall of text. Group by classification, needs-action first. A few words per item (sender, subject gist, recommended action) — this is read on a phone in Telegram, not a report. Keep it well under 4096 characters (Telegram's single-message limit) — if the sweep turns up so much mail that a full brief would run longer, trim detail rather than let it split across multiple messages; a one-item-per-line summary always fits.
5. Deliver the brief to Telegram — this step matters: when you're run headlessly (no bridge in front of you, e.g. from launchd or a dashboard button), your ordinary reply text only reaches stdout/a log file, not Gary's phone. So deliver it explicitly instead:
   - `Write` the assembled brief (plain text, no markdown) to a scratch file, e.g. `/tmp/inbox-brief-<timestamp>.txt`.
   - Run `./node_modules/.bin/tsx bridge/notify.ts <path-to-that-file>` via Bash (from the repo root) to actually send it. Do NOT construct a raw `curl`/HTTP call to the Telegram API yourself — always use this script, which reuses the same sender the Telegram bridge itself uses.
   - **Check the result, don't assume it worked**: confirm the command exited 0 and printed `[notify] sent.`. If it did NOT — nonzero exit, or no `[notify] sent.` line — the brief did NOT reach Gary. Do not report the sweep as a success in that case; say plainly in your turn output that delivery failed (the dashboard-button run route captures and streams this turn output, so a stated failure is visible even without Telegram).
   - If there's nothing needing attention but there IS new mail since the last sweep (all of it noise), still write and send a brief one-liner saying so — don't skip the send step just because nothing needs action, or Gary never learns the sweep ran clean.
   - Once delivery is confirmed (exit 0 and `[notify] sent.`), end your turn with a single, final, machine-findable line naming the scratch file you wrote and sent, exactly: `BRIEF FILE: <the absolute path to the scratch file, e.g. /tmp/inbox-brief-<ts>.txt>`. This must be the LAST line of your turn output, on its own line, with that literal `BRIEF FILE: ` prefix. On a delivery failure, or in the skipped-sweep case below, do NOT print a BRIEF FILE line — state the failure/skip plainly instead, so a stale file is never advertised.

Skip entirely — no write, no send — only when there's nothing NEW since the last sweep at all (no unread, nothing in the last 24h). That's the one case where sending nothing is correct; every other case (even an all-noise sweep) still sends a brief per the step above.
