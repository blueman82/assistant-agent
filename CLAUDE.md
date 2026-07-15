# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Wiki Knowledge Base

**At the start of every conversation**, read `AGENTS.md` in this directory for wiki maintenance protocols. The assistant-agent wiki is a persistent, compounding knowledge base maintained by Claude and browsed by Gary in Obsidian. The wiki vault lives at `/Users/harrison/Github/assistant-agent-wiki/`.

# Assistant Agent

Gary's personal AI assistant, Rachel, built on the Claude Agent SDK. It runs as a single long-lived CLI agent that handles email, calendar, and tasks.

## Commands

```bash
npm install                 # install dependencies
npx tsx rachel.ts           # run interactively
npx tsx rachel.ts "..."     # run a one-shot request, then drop into interactive
npm start                   # alias for tsx rachel.ts
npm run bridge              # tsx bridge/telegram-bridge.ts (Telegram front-end)
npm run typecheck           # tsc --noEmit
npm test                    # gate/**/*.test.ts + bridge/**/*.test.ts + proactive/**/*.test.ts + hooks/scripts/tests/probe_conventions.test.sh
```

There is no build step (run directly via `tsx`) and no linter. `.claude/test_command` runs `npm run typecheck && npm test`, which the coderails `test_gate` hook enforces before commits. (Known quirk: run `npm run typecheck` and `npm test` as separate commands — the combined `&&` invocation can hang.)

To run the Telegram bridge persistently (survives reboots/crashes), copy `bridge/launchd.plist` to `~/Library/LaunchAgents/com.rachel.telegram-bridge.plist`, replace `__REPO_PATH__` with the absolute path to this checkout, then `launchctl load ~/Library/LaunchAgents/com.rachel.telegram-bridge.plist`. Logs land at `.rachel/telegram-bridge.log`, redacted of the bot token before they're ever written.

To run the Inbox Brief sweep (`tasks/inbox-brief.md`) on a schedule, copy `tasks/inbox-brief-launchd.plist` to `~/Library/LaunchAgents/com.rachel.inbox-brief.plist`, replace `__REPO_PATH__`, then `launchctl load` it. It fires `bin/rachel "Read tasks/inbox-brief.md and follow it." < /dev/null` four times a day (08:05/11/14/17 — the first run sits at 08:05 to clear the proactive sweep's 08:00 digest flush); each run is a headless one-shot that exits on its own (closed stdin → EOF → clean exit), not a long-lived process, so no `KeepAlive` is needed. The plist sets `RACHEL_ALLOWED_TOOLS` to narrow the one-shot to the minimum toolset the task needs.

The proactive layer adds two more launchd services, same install pattern (copy the plist, replace `__REPO_PATH__`, `launchctl load`): `tasks/proactive-sweep-launchd.plist` → `com.rachel.proactive-sweep` runs `proactive/sweep.ts` as a deterministic tick every 30 minutes during waking hours, and `tasks/proactive-calendar-launchd.plist` → `com.rachel.proactive-calendar` runs the calendar-conflicts one-shot (`tasks/proactive-calendar.md`) 4x/day, narrowed via `RACHEL_ALLOWED_TOOLS` to Read/Write/Bash + the Calendar MCP tools.

## Architecture

The codebase is intentionally tiny and splits cleanly into **plumbing** and **brain**:

- **`rachel.ts`** — the plumbing. A REPL that wraps the Agent SDK's `query()`. It loads the system prompt, defines a single inline agent named `rachel`, wires the send-approval gate (`gate/sendGate.ts`) as a `PreToolUse` hook, streams the agent's text/tool-use back to the terminal, and loops. It also exports `runTurn`/`getSessionId`/`resetSession`/`telegramSurface` so the Telegram bridge can drive the same turn loop and approval surface without a second entry point. It holds almost no logic about *what* Rachel does.
- **`bridge/telegram-bridge.ts`** — a second front-end onto the same Rachel. Owns the single Telegram `getUpdates` long-poll loop (Telegram allows exactly one consumer per bot token), routes ordinary chat messages into a FIFO queue drained through `rachel.ts`'s `runTurn`, and routes `callback_query` taps (Approve/Deny) immediately into the imported `telegramSurface` from `rachel.ts` rather than constructing its own — a callback must resolve the same surface instance the send gate is waiting on. Also handles inbound photo and image-document messages: selects the largest photo variant, downloads the file to `~/.rachel/tmp/` via `bridge/api.ts`'s `downloadFile`, and queues a `[image: /path]\n<caption>` string to `runTurn` so Rachel can read the image. Non-image documents get a user-facing reply; Rachel's system prompt documents the `[image: ...]` protocol. `bridge/api.ts` is the plain-fetch Telegram client (markdown stripping, chunked replies, typing indicator, token redaction in logs, file download). See `bridge/launchd.plist` to run it as a background service. The bridge also writes a heartbeat (`~/.rachel/bridge-heartbeat.json`, atomic temp-file + rename, once per successful poll — deliberately not during 409 backoff) that the proactive sweep reads for wedge detection, and routes its own alerts (startup notice, loop-watchdog exit/stall pings, health transitions) through `proactive/push.ts`'s chokepoint so they pick up quiet-hours deferral, dedup, and the budget — with a direct-send fallback if `push()` itself throws. The one exception is the FATAL 5x409 exit alert, which keeps its direct awaited send because the process is dying.
- **`proactive/`** — the proactive layer. `push.ts` is the single alert chokepoint: it owns the state store at `~/.rachel/proactive/` (dedup, quiet hours, daily interrupt budget — all deterministic code, config from `~/.rachel/proactive/config.json` with sane defaults when absent) and is the only code that reads/writes it. It's a library for the sweep and bridge, and a CLI for LLM one-shots (exactly five arguments — family, event-id, state, severity, message-file — message text always comes from a file, never argv; a sixth argument is rejected, and `bridge/notify.ts` pins the same one-argument rule). `sweep.ts` is the deterministic 30-minute launchd tick (`com.rachel.proactive-sweep`): deferred-digest flush first, then bridge-liveness (launchd death, stale heartbeat, stalled drain, silent calendar producer), PR-red, and calendar escalation — each family in its own try/catch. `allowedTools.ts` is the `RACHEL_ALLOWED_TOOLS` seam: comma-separated narrowing of the agent's tool list for headless one-shots — it can only remove tools from the default list, never add one (injection hardening), and a set-but-zero-tools value throws rather than running tool-less. The behavioural side (families, tags, severities, one-shot duties) lives in `system.md`'s Proactive layer section.
- **`prompts/system.md`** — the brain. All behaviour lives here: tool-routing rules, capability docs, and ground rules. **To change how Rachel behaves, edit this file, not the TypeScript.**

To understand the agent you must read both files together — `rachel.ts` tells you which tools are wired in; `system.md` tells you how they're meant to be used. `bridge/telegram-bridge.ts` is a transport layer on top of both — it handles message routing (text → FIFO, callbacks → gate surface), image reception (photo/document download and `[image: path]` queuing), and reply formatting (text-only emit filter, markdown stripping).

### Agent configuration (in `rachel.ts`)

The agent is defined inline via the SDK's `agents.rachel` option, with:
- `permissionMode: "auto"` and an `allowedTools` list resolved per turn from the exported `DEFAULT_ALLOWED_TOOLS` constant (Read/Write/Edit/Glob/Grep/Bash, Web search/fetch, ToolSearch, Skill, `mcp-exec`, `mcp__claude-in-chrome__*`, `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, and `mcp__claude_ai_Slack__*`) via `proactive/allowedTools.ts`'s `resolveAllowedTools` — the `RACHEL_ALLOWED_TOOLS` env var narrows headless one-shots to a subset of that list (remove-only; unset means the full list, so the seam is inert for the interactive agent).
- An empty `skills` list (the Adobe-specific `jira`/`slack` skills were removed when Rachel became personal-only).
- `extraArgs: { chrome: null }` to enable the Chrome extension MCP.
- No spawned MCP servers (`mcpServers = {}`) — Chrome tools come from the browser extension, not a spawned server.

Session continuity: `sessionId` is captured from the SDK `init` message and passed as `resume` on subsequent turns. `/reset` clears it.

### Tool routing (defined in `system.md`)

This is the most important behavioural contract:
- **email** → Gmail (`gjharrison01@gmail.com`) via the `mcp__claude_ai_Gmail__*` tools, by default.
- **calendar** → Google Calendar via the `mcp__claude_ai_Google_Calendar__*` tools, by default.
- **Tasks** → flat markdown files in `tasks/`, named `YYYY-MM-DD-slug.md` with frontmatter (title, status, due, priority).

## Config / environment

- No API key — uses the local Claude Code OAuth session.
- Model: `claude-sonnet-4-6` (override with `RACHEL_MODEL`).
- Max turns per request: `200` (override with `RACHEL_MAX_TURNS`).
- Tool narrowing for headless one-shots: `RACHEL_ALLOWED_TOOLS` (comma-separated; remove-only subset of `DEFAULT_ALLOWED_TOOLS`, unset = full list).
- Proactive tuning: `~/.rachel/proactive/config.json` — timezone, quiet hours (default 22:30–08:00 Europe/Dublin), daily interrupt budget (default 10), PR watch repos, calendar one-shot hours. An absent file means the defaults, not an error.
- TypeScript: ESM, `strict` mode, target ES2022.

## CLI commands (at the `You:` prompt)

| Input | Effect |
|-------|--------|
| `/reset` | Start a new session (clears the resumed `sessionId`) |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the in-flight turn via the AbortController |
