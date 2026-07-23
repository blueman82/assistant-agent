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

Rachel confirms before any outward action — sending email or changing the calendar.

## How it's built

The project is deliberately small and splits into two parts:

- **`rachel.ts`** — the plumbing. A REPL wrapping the Agent SDK's `query()`: it loads the system prompt, defines one inline agent, streams output, and loops.
- **`prompts/system.md`** — the brain. All of Rachel's behaviour — tool routing, capabilities, ground rules — lives here. Change behaviour by editing this file, not the TypeScript.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture notes.

## Project layout

```
rachel.ts           # CLI entry point (the plumbing)
prompts/system.md   # system prompt (the behaviour)
bridge/             # Telegram bridge (second front-end) + notify.ts
gate/               # send-approval gate (PreToolUse hook + approval surfaces)
proactive/          # proactive layer: push.ts alert chokepoint, sweep.ts launchd tick, allowedTools.ts
scripts/            # install.sh (launchd deploy) + speech/ (local STT/TTS venv setup + transcribe/synthesize)
tasks/              # task files (YYYY-MM-DD-slug.md)
```

## Commands

```bash
npx tsx rachel.ts           # run interactively
npm start                   # alias for the above
npm run bridge              # tsx bridge/telegram-bridge.ts (Telegram front-end)
npm run typecheck           # tsc --noEmit
npm test                    # gate/bridge/proactive/scripts test suites + hook conventions test
```

### At the `You:` prompt

| Input | Effect |
|-------|--------|
| `/reset` | Start a fresh session |
| `/model [name]` | No arg: report current model + valid options. Arg: switch model, takes effect next turn |
| `/effort [level]` | No arg: report current effort + valid options. Arg: switch effort, takes effect next turn |
| `/exit` or `/quit` | Exit |
| `q` (mid-turn) | Abort the current turn |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `RACHEL_MODEL` | `claude-sonnet-5` | Model to run at boot — a `/model` command overrides it for the running process only |
| `RACHEL_MAX_TURNS` | `200` | Max agent turns per request |
| `RACHEL_ALLOWED_TOOLS` | unset (full list) | Narrow headless one-shots to a subset of the default tools (remove-only) |
