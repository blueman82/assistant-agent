# Rachel

Rachel is a local, provider-neutral personal assistant. The host chooses the
runtime explicitly with `RACHEL_PROVIDER=claude` or `RACHEL_PROVIDER=codex`.
The host runtimes own OAuth login and session handling; Rachel does not read
API keys. Claude and Codex adapters translate each host runtime into the same
turn, tool, approval, and reply contracts.

## Architecture

- The CLI composition root is [`rachel.ts`](./rachel.ts). [`bin/rachel`](./bin/rachel)
  is its location-independent launcher.
- The Telegram composition root is [`bridge/telegram-bridge.ts`](./bridge/telegram-bridge.ts).
  It is an independent front end and shares contracts with the CLI; it does
  not run the CLI REPL.
- The supervisor is separate from request handling. It observes runtime,
  watchdog, wake, and alert events, then applies deduplication, quiet hours,
  and interrupt-budget policy before delivery.
- Telegram media and speech are adapters: media is downloaded to local
  storage; local speech provides transcription and synthesis; failed voice
  synthesis falls back to text.

The current checkout's executable roots remain `rachel.ts` and
`bridge/telegram-bridge.ts`; the provider/core adapter boundary is the
composition contract for the provider-neutral implementation. The checked-in
root still contains the legacy Claude runtime, so `RACHEL_PROVIDER=codex` is
documented as the new contract but is not a verified Codex run in this
checkout.

## Security and approvals

Host authentication is OAuth-only. Credentials stay in the host runtime or
local configuration and are not committed here. Outward actions are protected
by the send gate: the canonical tool input is hash-bound to a one-shot
approval, approvals are consumed, denials fail closed, and attempts are
audited. Terminal, Telegram, and queue approval surfaces resolve the same gate.
Browser-driven sends remain an audit-only residual and must not be treated as
equivalent to a gated MCP send.

## Setup and commands

```bash
npm install
RACHEL_PROVIDER=claude ./bin/rachel
RACHEL_PROVIDER=codex ./bin/rachel "check my tasks"
```

Interactive commands:

| Command | Effect |
|---|---|
| `/reset` | Start a fresh session |
| `/model [name]` | Show or change the model |
| `/effort [level]` | Show or change reasoning effort |
| `/exit`, `/quit` | Exit |
| `q` | Abort the current turn |

Other entrypoints:

```bash
npm start                         # CLI composition root
npm run bridge                    # Telegram composition root
npm run architecture-check       # verify the rewrite layout and import boundaries
RACHEL_PROVIDER=claude ./bin/rachel --help
```

Launchd templates are under [`bridge/launchd.plist`](./bridge/launchd.plist)
and [`launchd/`](./launchd/). Replace `__REPO_PATH__`, set the provider in the
job environment, and validate before loading:

```bash
for f in bridge/launchd.plist launchd/*.plist; do plutil -lint "$f"; done
RACHEL_PROVIDER=claude ./bin/rachel --help
git diff --check
```

For the full test and type checks:

```bash
npm run typecheck
npm test
```

## Layout

```
rachel.ts             CLI composition root
bridge/               Telegram composition root and transport adapters
gate/                 approval, audit, and memory enforcement
src/media/            media storage and Telegram media adapters
src/speech/           local speech adapters and text fallback
src/supervisor/       events, liveness, watchdog, and delivery policy
src/core/             transport-free contracts and policy
src/providers/        external-service adapters
proactive/            scheduled work and notification chokepoint
launchd/              launchd templates for local scheduled jobs
prompts/system.md     behavioural policy
tasks/                Markdown task inputs
```

The architecture checker is repository-owned and fail-closed: it requires all
six rewrite modules, explicit `.ts` relative imports, and the dependency
direction. It scans production files only; tests are intentionally free to
compose modules across boundaries.
