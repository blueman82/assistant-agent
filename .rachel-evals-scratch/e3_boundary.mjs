// E3 (P0): a file exactly at the 1h age boundary is NOT deleted (strictly-
// older comparison only). Independent driver, not the PR's own boundary test.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e3-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e3-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });
const boundary = join(tmpDir, "boundary.wav");
writeFileSync(boundary, "x");
const now = new Date();
const exactlyOneHourAgo = new Date(now.getTime() - 60 * 60_000);
utimesSync(boundary, exactlyOneHourAgo, exactlyOneHourAgo);

await sweepTick({
  homeDir: home, baseDir, repoDir: process.cwd(),
  now: () => now,
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent", flushFn: async () => "empty",
  getStateFn: () => undefined, statMtimeFn: () => new Date(),
  readFileFn: () => undefined, writeFileFn: () => {}, lintFn: () => [],
});

if (!existsSync(boundary)) {
  console.error("FAIL: a file exactly at the 1h boundary was deleted — comparison is not strictly-older");
  process.exit(1);
}
console.log("PASS: boundary-aged file survived");
process.exit(0);
