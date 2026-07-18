---
title: "Short imperative description of the task"
status: todo
due: 2026-01-31
priority: normal
---

The body is plain prose telling Rachel what to do and what she needs to know
to do it. Write it as if briefing someone who has the repo but not the
conversation it came from — state the goal, the constraints that are already
decided, and what "done" looks like.

Point at any context that lives elsewhere rather than restating it, e.g. a
memory file, a PR number, or a wiki page. If a decision has already been
made, say so plainly so it doesn't get re-litigated.

End with the next concrete action.

---

## Notes on this directory

Task files are **not** date-triggered. Nothing scans this directory on a
schedule — a file sitting here does nothing until Rachel is pointed at it.
Anything time-based needs a separate trigger (a launchd job, or a routine
Rachel schedules herself).

Personal task files are gitignored — they're local to each machine. Only
this example and the runtime-dependency files are tracked.

### Frontmatter

`title` is the only field that always appears. The rest are used where they
carry meaning:

| Field | Used for |
|-------|----------|
| `status` | `todo` / `launched` / `done` |
| `due` | Absolute date, `YYYY-MM-DD`. Never "next Tuesday". |
| `priority` | `low` / `normal` / `high` |

Agentic-loop task files carry extra fields — `slug`, `repo` (absolute path
to the target checkout), and `permission_mode` — since the loop launcher
reads them to know where and how to run.

### Tracked files in here

These are infrastructure, not personal tasks, and stay in git:

- `*-launchd.plist` — service templates. `scripts/install.sh` stamps
  `__REPO_PATH__` into these and installs them to `~/Library/LaunchAgents`.
- `inbox-brief.md` — read at runtime by `com.rachel.inbox-brief`, the
  coderails dashboard button, and the routing rules in `prompts/system.md`.
- `proactive-calendar.md` — spawned by `proactive/sweep.ts` and asserted in
  `proactive/sweep.test.ts`.
