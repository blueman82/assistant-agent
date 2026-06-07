# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Assistant Agent

Gary's personal AI secretary, built on the Claude Agent SDK. It runs as a single long-lived CLI agent that handles email, calendar, and tasks.

## Commands

```bash
npm install                 # install dependencies
npx tsx secretary.ts        # run interactively
npx tsx secretary.ts "..."  # run a one-shot request, then drop into interactive
npm start                   # alias for tsx secretary.ts
npm run typecheck           # tsc --noEmit (the only check — there are no tests)
```

There is no build step (run directly via `tsx`), no linter, and no test suite. `npm run typecheck` is the only verification gate.

## Architecture

The codebase is intentionally tiny and splits cleanly into **plumbing** and **brain**:

- **`secretary.ts`** — the plumbing. A ~190-line REPL that wraps the Agent SDK's `query()`. It loads the system prompt, defines a single inline agent named `secretary`, streams the agent's text/tool-use back to the terminal, and loops. It holds almost no logic about *what* the secretary does.
- **`prompts/system.md`** — the brain. All behaviour lives here: tool-routing rules, capability docs, and ground rules. **To change how the secretary behaves, edit this file, not the TypeScript.**

To understand the agent you must read both files together — `secretary.ts` tells you which tools are wired in; `system.md` tells you how they're meant to be used.

### Agent configuration (in `secretary.ts`)

The agent is defined inline via the SDK's `agents.secretary` option, with:
- `permissionMode: "auto"` and a fixed `allowedTools` list (Read/Write/Edit/Glob/Grep/Bash, Web search/fetch, ToolSearch, Skill, `mcp-exec`, `mcp__claude-in-chrome__*`, `mcp__claude_ai_Gmail__*`, and `mcp__claude_ai_Google_Calendar__*`).
- An empty `skills` list (the Adobe-specific `jira`/`slack` skills were removed when the secretary became personal-only).
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
- Model: `claude-sonnet-4-6` (override with `SECRETARY_MODEL`).
- Max turns per request: `200` (override with `SECRETARY_MAX_TURNS`).
- TypeScript: ESM, `strict` mode, target ES2022.

## CLI commands (at the `You:` prompt)

| Input | Effect |
|-------|--------|
| `/reset` | Start a new session (clears the resumed `sessionId`) |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the in-flight turn via the AbortController |
