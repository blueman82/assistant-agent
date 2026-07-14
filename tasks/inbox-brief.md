---
title: "Inbox Brief"
slug: inbox-brief
status: active
---

Sweep Gary's Gmail and send him a concise Inbox Brief on Telegram. This is a recommend-only capability: you NEVER send an email, NEVER unsubscribe, NEVER delete, and NEVER archive without being asked. At most you may create a draft or apply a label — everything else is a recommendation for Gary to action himself. (Belt-and-braces note: Gary's Gmail MCP connector has no send or hard-delete tool at all, only draft/label/search/read — so this rule can't be bypassed even by accident.)

Steps:

1. Search recent mail with `mcp__claude_ai_Gmail__search_threads` — unread threads and anything from the last ~24h (e.g. `is:unread newer_than:1d`).
2. For each thread, read enough (`mcp__claude_ai_Gmail__get_thread`) to classify it:
   - **needs-action** — waiting on a reply, a decision, or something time-sensitive from Gary.
   - **new** — worth knowing about but nothing to do yet.
   - **noise** — newsletters, automated notifications, promos.
3. For each thread, recommend one action: reply / archive / unsubscribe / ignore. Don't perform any of these — just name the recommendation.
4. Assemble a CONCISE brief, not a wall of text. Group by classification, needs-action first. A few words per item (sender, subject gist, recommended action) — this is read on a phone in Telegram, not a report.
5. Deliver the brief as your normal reply text (plain text, no markdown — same rule as everything else you send to Telegram). If there's nothing needing attention, say so briefly rather than padding the brief out.

Skip entirely if there's nothing new since the last sweep (no unread, nothing in the last 24h) — send nothing rather than an empty "all clear" every few hours.
