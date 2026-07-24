import { defaultExecFn, parseEtimeMs } from "./proactive/sweep.ts";

const repo = process.cwd();
const log = await defaultExecFn("git", ["-C", repo, "log", "-1", "--format=%cI\t%h", "HEAD", "--", "rachel.ts", "bridge/", "prompts/"]);
console.log("git exit:", log.exitCode, "stdout:", JSON.stringify(log.stdout));
const [iso, sha] = log.stdout.trim().split("\t");
console.log("parsed commitISO:", iso, "sha:", sha, "epoch:", Date.parse(iso ?? ""));

const none = await defaultExecFn("git", ["-C", repo, "log", "-1", "--format=%cI\t%h", "HEAD", "--", "no/such/dir/"]);
console.log("irrelevant-path stdout:", JSON.stringify(none.stdout), "exit:", none.exitCode);

for (const s of ["03:31:00", "05:00:00", "1-02:03:04", "10:00", "not-a-duration", ""]) {
  console.log(`parseEtimeMs(${JSON.stringify(s)}) =`, parseEtimeMs(s));
}
