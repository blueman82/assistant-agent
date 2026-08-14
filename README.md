# Rachel

Rachel is a local, provider-neutral assistant. Choose the host runtime with
`RACHEL_PROVIDER=claude` or `RACHEL_PROVIDER=codex`; provider adapters expose the
same core session and event contracts.

## Commands

```bash
npm install
RACHEL_PROVIDER=claude ./bin/rachel
RACHEL_PROVIDER=codex npm run start
npm run telegram
npm run architecture-check
npm run typecheck
npm test
```

`bin/rachel` launches `src/cli/main.ts`. Telegram launches
`src/telegram/main.ts`. Both compose a provider runtime from `src/providers/`.

## Layout

```
src/core/       provider-neutral contracts, sessions, and approvals
src/cli/        terminal composition root
src/providers/  Claude and Codex runtime adapters
src/telegram/   Telegram transport and composition root
src/media/      local storage and Telegram media adapters
src/speech/     local speech adapters and fallback
src/supervisor/ liveness, wake, alert, and delivery policy
scripts/speech/ local Python speech helpers
tasks/          local Markdown task inputs
```

The architecture check scans every production file under `src/`, enforces
module boundaries and file/function limits, and rejects legacy runtime roots.
There are no compatibility wrappers or launchd integration in this rewrite.
