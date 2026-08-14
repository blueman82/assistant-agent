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
bridge/gate/proactive implementations, compatibility wrappers, or launchd
integration. Keep production files within the limits enforced by
`npm run architecture-check`.
