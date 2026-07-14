# Task: on 27 July, grade the salience-cue experiment and tell Gary the results

**From:** hook-rethink session (13b7e758), 2026-07-13. Gary asked: "ask Rachel to
check for the salience-cue experiment on 27 July and let me know the results."

**When:** on or after **2026-07-27**. Not before — the experiment's 2-week window
ends then. If you see this task earlier, leave it in place.

## Background (30 seconds)

On 2026-07-13 a loop added a 3-token cue (`| label claims`) to the `[ctx]` line
injected into every Claude Code prompt, betting that a pre-response reminder cuts
first-attempt confidence-label misses. The decision rule was **frozen in advance**
so nobody (including the grading session) can move the goalposts. The full
pre-registration lives at:

`~/.claude/projects/-Users-harrison-Github-coderails/memory/project_salience_cue_experiment.md`

## What to do

1. Read that memory file — it is the authority; if it contradicts anything here,
   the memory file wins.
2. Compute the main-agent label-miss rate from the discipline log. Mechanical:

   ```bash
   # evaluated main-agent stops since the cue went live (2026-07-13):
   awk '$1 >= "2026-07-13" && /hook=confidence_labels event=Stop/' ~/.claude/discipline.log > /tmp/cue-window.txt
   TOTAL=$(grep -c 'would_block=' /tmp/cue-window.txt)
   MISSES=$(grep -c 'would_block=1' /tmp/cue-window.txt)
   echo "rate: $MISSES / $TOTAL"
   # also compute week-1 vs week-2 split (before/after 2026-07-20) the same way
   ```

   Notes: only `event=Stop` lines count (SubagentStop is excluded by design);
   `warned=1` lines still count as misses; reference rate to beat is the
   historical 25.6% (unsegmented), keep-threshold is ≤17.6% sustained, OR week-2
   ≥8 percentage points below week-1.
3. Apply the frozen rule mechanically:
   - **KEEP** if the threshold is met → no config change needed.
   - **REVERT** if not → remove the literal ` | label claims` from the ctx printf
     command in `~/.claude/settings.json` (`hooks.UserPromptSubmit`, the printf
     entry). Nothing else in that file. Show Gary the edit before/after.
   - **Check first:** if a model change or major harness change happened during
     the window (ask Gary if unsure), the phase restarts instead — report that.
4. Record the outcome (numbers + verdict + date) in the memory file itself,
   replacing "decides ~2026-07-27" phrasing with the result, and update its line
   in that memory dir's MEMORY.md index.
5. **Tell Gary the results** — terminal or Telegram, whichever he's on. Include:
   the rates (overall + week-1/week-2), the verdict (keep/revert/restart), and
   what action was taken. Plain numbers, no ceremony.

## Caveats

- Step 3's settings.json edit is config on Gary's machine — draft-first UX
  contract applies as usual: show him the intended edit and the numbers, act on
  his confirmation.
- Do NOT re-derive or "improve" the threshold. It was frozen on 2026-07-13
  precisely so the grading is mechanical.
