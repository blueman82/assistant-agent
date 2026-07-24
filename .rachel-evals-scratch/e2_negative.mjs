// Negative control for E2: assert the OPPOSITE outcome (that the symlink
// target was deleted) — this must fail, proving E2's real assertion
// ("target survives") has discriminating power and isn't vacuously true.
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTick } from "../proactive/sweep.ts";

const home = mkdtempSync(join(tmpdir(), "pr71-e2neg-"));
const baseDir = mkdtempSync(join(tmpdir(), "pr71-e2neg-base-"));
writeFileSync(join(baseDir, "config.json"), JSON.stringify({ calendar_oneshot_hours: [], pr_watch_repos: [] }));
const tmpDir = join(home, ".rachel", "tmp");
mkdirSync(tmpDir, { recursive: true });
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
const outside = join(home, "precious.txt");
writeFileSync(outside, "do not delete");
utimesSync(outside, twoHoursAgo, twoHoursAgo);
const link = join(tmpDir, "escape-hatch");
symlinkSync(outside, link);

await sweepTick({
  homeDir: home, baseDir, repoDir: process.cwd(),
  execFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  pushFn: async () => "sent", flushFn: async () => "empty",
  getStateFn: () => undefined, statMtimeFn: () => new Date(),
  readFileFn: () => undefined, writeFileFn: () => {}, lintFn: () => [],
});

// Deliberately asserting the WRONG thing (target was deleted) to prove
// this class of check can fail when the claim doesn't hold.
if (!existsSync(outside)) {
  console.error("outside target was deleted (would make this control pass) — but it correctly survived so this exits nonzero");
  process.exit(0);
}
console.error("negative control: asserting 'target was deleted' fails as expected, because the real guard keeps it alive");
process.exit(1);
