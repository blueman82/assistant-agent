# Assistant Agent

Gary's personal AI assistant, Rachel, built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It runs as a single long-lived CLI agent that manages email, calendar, and tasks.

## Quick start

```bash
npm install
npx tsx rachel.ts
```

Type a request at the `You:` prompt. Or pass one as an argument for a one-shot:

```bash
npx tsx rachel.ts "check my email"
```

No API key is needed — the agent uses the local Claude Code OAuth session.

## What it does

| Area | How |
|------|-----|
| **Email** | Gmail (`gjharrison01@gmail.com`) via MCP |
| **Calendar** | Google Calendar via MCP |
| **Tasks** | Markdown files in `tasks/` (`YYYY-MM-DD-slug.md`) |

The secretary confirms before any outward action — sending email or changing the calendar.

## How it's built

The project is deliberately small and splits into two parts:

- **`secretary.ts`** — the plumbing. A REPL wrapping the Agent SDK's `query()`: it loads the system prompt, defines one inline agent, streams output, and loops.
- **`prompts/system.md`** — the brain. All of the secretary's behaviour — tool routing, capabilities, ground rules — lives here. Change behaviour by editing this file, not the TypeScript.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture notes.

## Project layout

```
secretary.ts        # CLI entry point (the plumbing)
prompts/system.md   # system prompt (the behaviour)
tasks/              # task files (YYYY-MM-DD-slug.md)
src/                # shared utilities (currently empty)
```

## Commands

```bash
npx tsx secretary.ts        # run interactively
npm start                   # alias for the above
npm run typecheck           # tsc --noEmit
```

### At the `You:` prompt

| Input | Effect |
|-------|--------|
| `/reset` | Start a fresh session |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the current turn |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECRETARY_MODEL` | `claude-sonnet-4-6` | Model to run |
| `SECRETARY_MAX_TURNS` | `200` | Max agent turns per request |
