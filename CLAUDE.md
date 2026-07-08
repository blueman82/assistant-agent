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
npm test                    # gate/**/*.test.ts + bridge/**/*.test.ts + hooks/scripts/tests/probe_conventions.test.sh
```

There is no build step (run directly via `tsx`) and no linter. `.claude/test_command` runs `npm run typecheck && npm test`, which the coderails `test_gate` hook enforces before commits. (Known quirk: run `npm run typecheck` and `npm test` as separate commands — the combined `&&` invocation can hang.)

To run the Telegram bridge persistently (survives reboots/crashes), copy `bridge/launchd.plist` to `~/Library/LaunchAgents/com.rachel.telegram-bridge.plist`, replace `__REPO_PATH__` with the absolute path to this checkout, then `launchctl load ~/Library/LaunchAgents/com.rachel.telegram-bridge.plist`. Logs land at `.rachel/telegram-bridge.log`, redacted of the bot token before they're ever written.

## Architecture

The codebase is intentionally tiny and splits cleanly into **plumbing** and **brain**:

- **`rachel.ts`** — the plumbing. A REPL that wraps the Agent SDK's `query()`. It loads the system prompt, defines a single inline agent named `rachel`, wires the send-approval gate (`gate/sendGate.ts`) as a `PreToolUse` hook, streams the agent's text/tool-use back to the terminal, and loops. It also exports `runTurn`/`getSessionId`/`resetSession`/`telegramSurface` so the Telegram bridge can drive the same turn loop and approval surface without a second entry point. It holds almost no logic about *what* Rachel does.
- **`bridge/telegram-bridge.ts`** — a second front-end onto the same Rachel. Owns the single Telegram `getUpdates` long-poll loop (Telegram allows exactly one consumer per bot token), routes ordinary chat messages into a FIFO queue drained through `rachel.ts`'s `runTurn`, and routes `callback_query` taps (Approve/Deny) immediately into the imported `telegramSurface` from `rachel.ts` rather than constructing its own — a callback must resolve the same surface instance the send gate is waiting on. Also handles inbound photo and image-document messages: selects the largest photo variant, downloads the file to `~/.rachel/tmp/` via `bridge/api.ts`'s `downloadFile`, and queues a `[image: /path]\n<caption>` string to `runTurn` so Rachel can read the image. Non-image documents get a user-facing reply; Rachel's system prompt documents the `[image: ...]` protocol. `bridge/api.ts` is the plain-fetch Telegram client (markdown stripping, chunked replies, typing indicator, token redaction in logs, file download). See `bridge/launchd.plist` to run it as a background service.
- **`prompts/system.md`** — the brain. All behaviour lives here: tool-routing rules, capability docs, and ground rules. **To change how Rachel behaves, edit this file, not the TypeScript.**

To understand the agent you must read both files together — `rachel.ts` tells you which tools are wired in; `system.md` tells you how they're meant to be used. `bridge/telegram-bridge.ts` is a transport layer on top of both — it handles message routing (text → FIFO, callbacks → gate surface), image reception (photo/document download and `[image: path]` queuing), and reply formatting (text-only emit filter, markdown stripping).

### Agent configuration (in `rachel.ts`)

The agent is defined inline via the SDK's `agents.rachel` option, with:
- `permissionMode: "auto"` and a fixed `allowedTools` list (Read/Write/Edit/Glob/Grep/Bash, Web search/fetch, ToolSearch, Skill, `mcp-exec`, `mcp__claude-in-chrome__*`, `mcp__claude_ai_Gmail__*`, and `mcp__claude_ai_Google_Calendar__*`).
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
- TypeScript: ESM, `strict` mode, target ES2022.

## CLI commands (at the `You:` prompt)

| Input | Effect |
|-------|--------|
| `/reset` | Start a new session (clears the resumed `sessionId`) |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the in-flight turn via the AbortController |
