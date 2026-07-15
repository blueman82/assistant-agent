---
title: "Proactive Calendar Conflicts"
slug: proactive-calendar
status: active
---

Sweep Gary's Google Calendar for overlapping events and push each conflict to his Telegram through the proactive chokepoint. This is a headless one-shot: you run with a narrowed toolset (`RACHEL_ALLOWED_TOOLS=Read,Write,Bash,mcp__claude_ai_Google_Calendar__*`), so every step below uses only Read, Write, Bash, and the Google Calendar MCP tools — nothing else is available.

Steps:

1. Fetch the next 48 hours of events with `mcp__claude_ai_Google_Calendar__list_events`.

2. Detect conflicts deterministically — no judgement calls. Two events conflict if and only if each starts before the other ends: `startA < endB AND startB < endA` (strict comparison on the start/end timestamps; back-to-back events that merely share a boundary do NOT conflict). Skip all-day events. For each conflicting pair, sort the two event IDs lexicographically so that idA < idB — everything below (cache, hash, event-id) uses that sorted order.

3. `Write` the conflict cache to the ABSOLUTE path `$HOME/.rachel/calendar-cache.json` with `$HOME` expanded (i.e. `/Users/harrison/.rachel/calendar-cache.json` on this machine) — never a bare `~`, which the Write tool does not expand. Exact schema:

   ```json
   {
     "schema_version": 1,
     "fetched_at": "<RFC3339 timestamp of this run>",
     "conflicts": [
       {
         "idA": "<sorted-lower event id>",
         "idB": "<sorted-higher event id>",
         "startA": "<RFC3339 with offset>",
         "endA": "<RFC3339 with offset>",
         "startB": "<RFC3339 with offset>",
         "endB": "<RFC3339 with offset>",
         "title_hint": "<summaryA> / <summaryB>"
       }
     ]
   }
   ```

   Timestamps go in exactly as the calendar returned them (RFC3339 with offset). Write the cache EVEN WHEN there are no conflicts (an empty `conflicts` array) — the deterministic sweep reads this file every 30 minutes to drive its <2h urgent escalation, and a missing or stale cache blinds it. Do not skip this step.

4. For each conflict, push one message through the push.ts CLI:
   - Compute the state hash: hash16 = the first 16 hex characters of sha256 over the four timestamps joined with `|`, in sorted-id order. Exact shell line (Bash):
     ```
     printf '%s' "<startA>|<endA>|<startB>|<endB>" | shasum -a 256 | cut -c1-16
     ```
   - `Write` a one-line message file `/tmp/proactive-cal-<timestamp>.txt` reading:
     `[cal] Conflict: <summaryA> (<HH:MM>) overlaps <summaryB> (<HH:MM>) — <day>`
     The leading `[cal]` tag is mandatory — it is how Gary tells a calendar ping from everything else in his chat.
   - Run, from the repo root via Bash:
     ```
     ./node_modules/.bin/tsx proactive/push.ts calendar "cal:<idA>+<idB>" "<hash16>" normal <message-file>
     ```
     Exactly five arguments: family, event-id, state, severity, message-file. The message text always comes from the FILE, never from argv. The event-id is `cal:<idA>+<idB>` with the IDs sorted lexicographically, and severity is ALWAYS `normal` here — the event-id carries NO `:2h` suffix, because the deterministic sweep owns urgent escalation under its own `cal:<idA>+<idB>:2h` event-id. Never push `urgent` from this task.

5. Check each push result — don't assume it worked. Exit 0 with any of `[push] sent.` / `[push] deferred.` / `[push] dedup.` counts as success (deferred and dedup are the chokepoint doing its job, not failures). A nonzero exit is a delivery failure: state it plainly in your turn output, and never report a clean sweep in that case.

6. No conflicts → write the cache (step 3 still applies), push nothing, and end the turn quietly — no Telegram message.
