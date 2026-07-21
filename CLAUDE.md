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

To deploy Rachel's four launchd services (the Telegram bridge plus the three scheduled jobs below), run `./scripts/install.sh` — it stamps `__REPO_PATH__` into all four plist templates, installs them to `~/Library/LaunchAgents`, bootstraps `~/.rachel/proactive/config.json` with the documented defaults if absent, bootout-then-bootstraps each service, and verifies the deployed surface (services loaded, bridge running, heartbeat fresh), failing loud if Telegram credentials aren't configured. `--dry-run` prints the full plan without changing anything. Bridge logs land at `.rachel/telegram-bridge.log`, redacted of the bot token before they're ever written.

The Inbox Brief sweep (`tasks/inbox-brief.md`) runs as `com.rachel.inbox-brief` from the `tasks/inbox-brief-launchd.plist` template. It fires `bin/rachel "Read tasks/inbox-brief.md and follow it." < /dev/null` four times a day (08:05/11/14/17 — the first run sits at 08:05 to clear the proactive sweep's 08:00 digest flush); each run is a headless one-shot that exits on its own (closed stdin → EOF → clean exit), not a long-lived process, so no `KeepAlive` is needed. The plist sets `RACHEL_ALLOWED_TOOLS` to narrow the one-shot to the minimum toolset the task needs.

The proactive layer adds two more launchd services (also deployed by the installer): `tasks/proactive-sweep-launchd.plist` → `com.rachel.proactive-sweep` runs `proactive/sweep.ts` as a deterministic tick every 30 minutes during waking hours, and `tasks/proactive-calendar-launchd.plist` → `com.rachel.proactive-calendar` runs the calendar-conflicts one-shot (`tasks/proactive-calendar.md`) 4x/day, narrowed via `RACHEL_ALLOWED_TOOLS` to Read/Write/Bash + the Calendar MCP tools.

## Architecture

The codebase is intentionally tiny and splits cleanly into **plumbing** and **brain**:

- **`rachel.ts`** — the plumbing. A REPL that wraps the Agent SDK's `query()`. It loads the system prompt, defines a single inline agent named `rachel`, wires the send-approval gate (`gate/sendGate.ts`) as a `PreToolUse` hook, streams the agent's text/tool-use back to the terminal, and loops. It also exports `runTurn`/`getSessionId`/`resetSession`/`telegramSurface` so the Telegram bridge can drive the same turn loop and approval surface without a second entry point. It holds almost no logic about *what* Rachel does.
- **`bridge/telegram-bridge.ts`** — a second front-end onto the same Rachel. Owns the single Telegram `getUpdates` long-poll loop (Telegram allows exactly one consumer per bot token), routes ordinary chat messages into a FIFO queue drained through `rachel.ts`'s `runTurn`, and routes `callback_query` taps (Approve/Deny) immediately into the imported `telegramSurface` from `rachel.ts` rather than constructing its own — a callback must resolve the same surface instance the send gate is waiting on. Also handles inbound photo and image-document messages: selects the largest photo variant, downloads the file to `~/.rachel/tmp/` via `bridge/api.ts`'s `downloadFile`, and queues a `[image: /path]\n<caption>` string to `runTurn` so Rachel can read the image. Non-image documents get a user-facing reply; Rachel's system prompt documents the `[image: ...]` protocol. `bridge/api.ts` is the plain-fetch Telegram client (markdown stripping, chunked replies, typing indicator, token redaction in logs, file download). See `bridge/launchd.plist` to run it as a background service. The bridge also writes a heartbeat (`~/.rachel/bridge-heartbeat.json`, atomic temp-file + rename, once per successful poll — deliberately not during 409 backoff) that the proactive sweep reads for wedge detection, and routes its own alerts (startup notice, loop-watchdog exit/stall pings, health transitions) through `proactive/push.ts`'s chokepoint so they pick up quiet-hours deferral, dedup, and the budget — with a direct-send fallback if `push()` itself throws. The one exception is the FATAL 5x409 exit alert, which keeps its direct awaited send because the process is dying. The bridge is also the sole consumer of `proactive/sessionPersist.ts`: it calls `rachel.ts`'s exported `hydratePersistedSession()` from its CLI guard on startup, so a bridge restart resumes the same Telegram conversation instead of starting fresh — see `RACHEL_SESSION_FILE` below.
- **`proactive/`** — the proactive layer. `push.ts` is the single alert chokepoint: it owns the state store at `~/.rachel/proactive/` (dedup, quiet hours, daily interrupt budget — all deterministic code, config from `~/.rachel/proactive/config.json` with sane defaults when absent) and is the only code that reads/writes it. It's a library for the sweep and bridge, and a CLI for LLM one-shots (exactly five arguments — family, event-id, state, severity, message-file — message text always comes from a file, never argv; a sixth argument is rejected, and `bridge/notify.ts` pins the same one-argument rule). `sweep.ts` is the deterministic 30-minute launchd tick (`com.rachel.proactive-sweep`) — five families in fixed order, each in its own try/catch: deferred-digest flush, bridge-liveness (launchd death, stale heartbeat, stalled drain, heartbeat never observed), PR-red, calendar escalation (the <2h urgent escalation, plus the silent-calendar-producer alert), and calendar one-shot spawning. `allowedTools.ts` is the `RACHEL_ALLOWED_TOOLS` seam: comma-separated narrowing of the agent's tool list for headless one-shots — it can only remove tools from the default list, never add one (injection hardening), and a set-but-zero-tools value throws rather than running tool-less. `memoryIndex.ts` composes Rachel's persistent memory index (`~/.rachel/memory/MEMORY.md`) into the system prompt on every turn via `composeSystemPrompt`/`resolveMemoryPath`, capping the injected index at 32 KiB with a UTF-8-safe truncation marker. `sessionPersist.ts` is bridge-only session persistence (`readSession`/`writeSession`/`clearSession`) — see the Telegram bridge entry below. The behavioural side (families, tags, severities, one-shot duties, the memory write/recall contract) lives in `system.md`'s Proactive layer and Memory sections.
- **`prompts/system.md`** — the brain. All behaviour lives here: tool-routing rules, capability docs, and ground rules. **To change how Rachel behaves, edit this file, not the TypeScript.**

To understand the agent you must read both files together — `rachel.ts` tells you which tools are wired in; `system.md` tells you how they're meant to be used. `bridge/telegram-bridge.ts` is a transport layer on top of both — it handles message routing (text → FIFO, callbacks → gate surface), image reception (photo/document download and `[image: path]` queuing), and reply formatting (text-only emit filter, markdown stripping).

### Agent configuration (in `rachel.ts`)

The agent is defined inline via the SDK's `agents.rachel` option, with:
- `permissionMode: "auto"` and an `allowedTools` list resolved per turn from the exported `DEFAULT_ALLOWED_TOOLS` constant (Read/Write/Edit/Glob/Grep/Bash, Web search/fetch, ToolSearch, Skill, `mcp-exec`, `mcp__claude-in-chrome__*`, `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, and `mcp__claude_ai_Slack__*`) via `proactive/allowedTools.ts`'s `resolveAllowedTools` — the `RACHEL_ALLOWED_TOOLS` env var narrows headless one-shots to a subset of that list (remove-only; unset means the full list, so the seam is inert for the interactive agent).
- An empty `skills` list (the Adobe-specific `jira`/`slack` skills were removed when Rachel became personal-only).
- `extraArgs: { chrome: null }` to enable the Chrome extension MCP.
- No spawned MCP servers (`mcpServers = {}`) — Chrome tools come from the browser extension, not a spawned server.

Model and reasoning effort are not part of that inline agent definition — they're read fresh on every call from `proactive/modelConfig.ts`'s `getModel()`/`getEffort()` and set as `model`/`effort` fields on the `options` object passed to the SDK's `query()` call, so a `/model` or `/effort` switch takes effect on the next turn rather than requiring a restart.

Session continuity: `sessionId` is captured from the SDK `init` message and passed as `resume` on subsequent turns. `/reset` clears it. For the Telegram bridge only, `sessionId` is additionally persisted to `<repo>/.rachel/bridge-session.json` behind the `RACHEL_SESSION_FILE` seam (set only in `bridge/launchd.plist`), so a bridge process restart resumes the same session rather than starting fresh; `/reset` also unlinks the persisted file. When that seam is active, `options.env` is set to a spread of `process.env` with `RACHEL_SESSION_FILE` deleted before being passed to the SDK's `query()` call — otherwise a Bash-spawned child one-shot would inherit the var and clobber the bridge's live session pointer (the SDK replaces the subprocess env entirely rather than merging, so spreading `process.env` first is mandatory). The CLI and all headless one-shots leave `options.env` untouched.

### Tool routing (defined in `system.md`)

This is the most important behavioural contract:
- **email** → Gmail (`gjharrison01@gmail.com`) via the `mcp__claude_ai_Gmail__*` tools, by default.
- **calendar** → Google Calendar via the `mcp__claude_ai_Google_Calendar__*` tools, by default.
- **Tasks** → flat markdown files in `tasks/`, named `YYYY-MM-DD-slug.md` with frontmatter (title, status, due, priority).

## Config / environment

- No API key — uses the local Claude Code OAuth session.
- Model: `claude-sonnet-5` (override with `RACHEL_MODEL`); reasoning effort: `high` by default. Both can be switched at runtime with `/model` and `/effort` — per-process, not persisted.
- Max turns per request: `200` (override with `RACHEL_MAX_TURNS`).
- Tool narrowing for headless one-shots: `RACHEL_ALLOWED_TOOLS` (comma-separated; remove-only subset of `DEFAULT_ALLOWED_TOOLS`, unset = full list).
- Proactive tuning: `~/.rachel/proactive/config.json` — timezone, quiet hours (default 22:30–08:00 Europe/Dublin), daily interrupt budget (default 10), PR watch repos, calendar one-shot hours. An absent file means the defaults, not an error.
- Persistent memory: `~/.rachel/memory/` — one fact per markdown file plus a pointer-only `MEMORY.md` index, composed into the system prompt every turn (see `proactive/memoryIndex.ts` and `system.md`'s Memory section). Override the index path with `RACHEL_MEMORY_PATH` (mirrors the `RACHEL_AUDIT_LOG_PATH` idiom; unset = the real path above).
- Bridge session persistence: `RACHEL_SESSION_FILE` (unset by default; set only in `bridge/launchd.plist`) — persists/restores the Telegram bridge's `sessionId` across a process restart via `proactive/sessionPersist.ts`. Inert for the CLI and all headless one-shots.
- TypeScript: ESM, `strict` mode, target ES2022.

## CLI commands (at the `You:` prompt)

| Input | Effect |
|-------|--------|
| `/reset` | Start a new session (clears the resumed `sessionId`) |
| `/model [name]` | No arg: report current model + valid options. Arg: switch model, takes effect next turn |
| `/effort [level]` | No arg: report current effort + valid options. Arg: switch effort, takes effect next turn |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the in-flight turn via the AbortController |
