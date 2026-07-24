// Negative control for E1: assert the SAME fresh file (only 5 min old) is
// NOT removed — proves the check can fail (i.e. it isn't vacuously "removed").
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e1neg-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e1neg-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });
const fresh = join(tmpDir, "fresh.wav");
writeFileSync(fresh, "x");
const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
utimesSync(fresh, fiveMinAgo, fiveMinAgo);

await sweepTick({
  homeDir: home, baseDir, repoDir: process.cwd(),
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent", flushFn: async () => "empty",
  getStateFn: () => undefined, statMtimeFn: () => new Date(),
  readFileFn: () => undefined, writeFileFn: () => {}, lintFn: () => [],
});

// If this exits 0, the "removed" assertion in E1 would be meaningless
// (everything gets removed regardless of age). We WANT this to exit non-zero
// only when the fresh file was wrongly removed — i.e. this script's job is
// to prove deletion CAN fail to happen, so on the expected (correct) outcome
// it exits non-zero to demonstrate E1's check has real discriminating power.
if (!existsSync(fresh)) {
  console.log("fresh file was removed (unexpected) — exiting 0 as the 'still there' assertion failed");
  process.exit(0);
}
console.error("fresh file survived as expected — this negative control intentionally fails to prove E1 discriminates");
process.exit(1);
