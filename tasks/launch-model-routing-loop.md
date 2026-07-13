# Task: launch the model-routing loop for Gary

**From:** dashboard-rethink session (0767967d), 2026-07-13. Gary asked for this to be launched by Rachel instead of him opening a new Claude Code session.

## What to do

Launch a detached headless Claude Code session in the coderails repo that runs an
agentic loop. One bash command:

```bash
cd /Users/harrison/Github/coderails && nohup claude -p "Read memory file project_model_routing_skill_handoff.md for full context. We're encoding the model-per-task routing practice (haiku/sonnet/opus per task, decided by Claude at plan time) as a standing step in the agentic-loop and writing-plans skills. The tiering rationale is already decided and inlined in the memory — don't re-derive it. Next: run the collision check (PR #156 file scope, session 1cf76302's frozen SKILL.md items, and the parked finishing-out-wiring loop which also targets skills/agentic-loop/), then brainstorm placement/wording, then loop with full PR gates. Crack on as an agentic loop — register progress.json first. Work from a worktree — other sessions share this checkout." \
  --permission-mode bypassPermissions \
  --output-format stream-json --include-partial-messages --verbose \
  > ~/.claude/coderails-dashboard/runs/model-routing-loop-manual.log 2>&1 &
echo "launched pid $!"
```

## After launching

Report back to Gary: the pid, the log path, and that loop lifecycle events will be
spoken aloud by the voice_announce hook (complete / waiting-on-human / stalled).
Progress is also visible on the dashboard (127.0.0.1:4173) once the loop registers
its progress.json.

## Caveats Gary has accepted

- `bypassPermissions` is the same trust envelope as the existing
  loop-retro-promotion routine button. The coderails PR gates still run INSIDE the
  session — nothing merges unreviewed.
- If the loop hits an approval-gate it will stall and say so in the log; tell Gary
  rather than retrying.
- Do NOT run this while another process holds the primary coderails checkout in a
  conflicting way — the prompt already tells the session to use a worktree.
