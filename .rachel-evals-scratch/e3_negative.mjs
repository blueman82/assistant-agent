// Negative control for E3: a file 1 second OLDER than the boundary (60min 1s)
// IS deleted — proves the boundary check has real discriminating power at
// the threshold rather than treating everything as exempt.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e3neg-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e3neg-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });
const justOver = join(tmpDir, "just-over.wav");
writeFileSync(justOver, "x");
const now = new Date();
const overBoundary = new Date(now.getTime() - (60 * 60_000 + 1000));
utimesSync(justOver, overBoundary, overBoundary);

await sweepTick({
  homeDir: home, baseDir, repoDir: process.cwd(),
  now: () => now,
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent", flushFn: async () => "empty",
  getStateFn: () => undefined, statMtimeFn: () => new Date(),
  readFileFn: () => undefined, writeFileFn: () => {}, lintFn: () => [],
});

if (existsSync(justOver)) {
  console.error("a file 1s past the boundary survived (unexpectedly) — exiting 0 as the 'gone' assertion failed");
  process.exit(0);
}
console.error("file just past the boundary was correctly removed — this negative control intentionally fails to prove E3 discriminates");
process.exit(1);
