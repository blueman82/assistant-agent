// E1 (P0): a stale (>1h old) regular file under ~/.rachel/tmp is removed by
// sweepTick's tmp-sweep family, against the MERGED exported sweepTick — a
// fresh driver script, not a reuse of the PR's own test harness or fixtures.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e1-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e1-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });
const stale = join(tmpDir, "stale.wav");
writeFileSync(stale, "x");
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
utimesSync(stale, twoHoursAgo, twoHoursAgo);

// Fully faked deps for every OTHER family so this eval never touches the
// network / launchctl / gh — isolates the assertion to tmp-sweep alone.
const results = await sweepTick({
  homeDir: home,
  baseDir,
  repoDir: process.cwd(),
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent",
  flushFn: async () => "empty",
  getStateFn: () => undefined,
  statMtimeFn: () => new Date(),
  readFileFn: () => undefined,
  writeFileFn: () => {},
  lintFn: () => [],
});

if (existsSync(stale)) {
  console.error("FAIL: stale file still exists after sweepTick");
  process.exit(1);
}
if (results["tmp-sweep"] !== "ok") {
  console.error(`FAIL: tmp-sweep family result was ${results["tmp-sweep"]}, expected ok`);
  process.exit(1);
}
console.log("PASS: stale file removed, family reported ok");
process.exit(0);
