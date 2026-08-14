# Assistant Agent

This repository is the provider-neutral Rachel rewrite. Read `AGENTS.md` for
the wiki maintenance protocol before changing the codebase.

## Commands

```bash
npm install
npm run start
npm run telegram
npm run architecture-check
npm run typecheck
npm test
```

Set `RACHEL_PROVIDER=claude` or `RACHEL_PROVIDER=codex` to select a runtime.
Authentication and session details belong to the selected host provider.

## Architecture

- `src/core/` contains transport- and provider-neutral contracts.
- `src/providers/` contains the only external runtime SDK adapters.
- `src/cli/main.ts` is the terminal composition root.
- `src/telegram/main.ts` is the Telegram composition root.
- `src/media/` and `src/speech/` contain infrastructure adapters.
- `src/supervisor/` contains liveness and delivery policy.

Keep dependencies flowing through these roots. Do not add legacy runtime roots,
bridge/gate/proactive implementations, or compatibility wrappers. Keep
production files within the limits enforced by `npm run architecture-check`.

## Deployment

`src/telegram/main.ts` runs long-lived under launchd as `com.rachel.telegram`,
defined in `scripts/deploy/com.rachel.telegram.plist`. The plist points at
`scripts/deploy/run-telegram.sh`, which reads `RACHEL_TELEGRAM_TOKEN` and
`RACHEL_TELEGRAM_CHAT_ID` from `~/.rachel/telegram.json` at launch time and
execs the runtime — secrets never live in the plist itself. Logs go to
`~/.rachel/telegram.log`.

```bash
launchctl bootstrap gui/$(id -u) /Users/harrison/Github/assistant-agent/scripts/deploy/com.rachel.telegram.plist
launchctl bootout gui/$(id -u)/com.rachel.telegram
```
