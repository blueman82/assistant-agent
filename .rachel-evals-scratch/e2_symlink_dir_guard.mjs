// E2 (P0): a stale symlink pointing outside tmp, and a stale subdirectory,
// are BOTH left untouched by sweepTick — the safety-critical guard against
// deleting a real file elsewhere in the operator's home via a followed link,
// or recursing into a directory. Fresh driver, not reusing the PR's test file.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e2-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e2-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);

// A file OUTSIDE tmp that a followed symlink would wrongly delete.
const outside = join(home, "precious.txt");
writeFileSync(outside, "do not delete");
utimesSync(outside, twoHoursAgo, twoHoursAgo);
const link = join(tmpDir, "escape-hatch");
symlinkSync(outside, link);

// A stale subdirectory with a stale file inside it.
const sub = join(tmpDir, "nested");
mkdirSync(sub, { recursive: true });
utimesSync(sub, twoHoursAgo, twoHoursAgo);
const nestedFile = join(sub, "deep.wav");
writeFileSync(nestedFile, "x");
utimesSync(nestedFile, twoHoursAgo, twoHoursAgo);

await sweepTick({
  homeDir: home, baseDir, repoDir: process.cwd(),
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent", flushFn: async () => "empty",
  getStateFn: () => undefined, statMtimeFn: () => new Date(),
  readFileFn: () => undefined, writeFileFn: () => {}, lintFn: () => [],
});

let ok = true;
if (!existsSync(outside)) { console.error("FAIL: symlink target outside tmp was deleted"); ok = false; }
try { if (!lstatSync(link).isSymbolicLink()) { console.error("FAIL: the symlink itself is gone/changed"); ok = false; } } catch { console.error("FAIL: symlink entry vanished"); ok = false; }
if (!existsSync(sub)) { console.error("FAIL: stale subdirectory was removed"); ok = false; }
if (!existsSync(nestedFile)) { console.error("FAIL: nested file inside subdirectory was removed (sweep recursed)"); ok = false; }

if (!ok) process.exit(1);
console.log("PASS: symlink target and stale subdirectory both survived untouched");
process.exit(0);
