// Tests for scripts/install.sh — the one-package installer that takes a
// fresh-ish machine to fully-deployed Rachel (four launchd services,
// Telegram config check, proactive config bootstrap, deployed-surface
// verification).
//
// Every test runs the real script via spawnSync against a sandboxed HOME
// and a launchctl SHIM, so nothing here ever touches the real
// ~/Library/LaunchAgents, the real launchd domain, or the real ~/.rachel.
// The shim mirrors real launchd exit codes: bootout of a not-loaded label
// exits 3 ("Boot-out failed: 3: No such process"), bootstrap of an
// already-loaded label exits 5 — the installer must tolerate the former
// and avoid the latter by always booting out first.
//
// Injection seams under test (all env vars, so no test touches the machine):
//   HOME                        — sandboxed home (default seam)
//   INSTALL_HOME                — overrides HOME for ~/.rachel + LaunchAgents
//   INSTALL_LAUNCH_AGENTS_DIR   — overrides the plist install target dir
//   INSTALL_LAUNCHCTL           — overrides the launchctl binary (else PATH)
//   INSTALL_HEARTBEAT_WAIT_SECS — bounds the heartbeat wait (default 120)

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install.sh");

const LABELS = [
  "com.rachel.telegram-bridge",
  "com.rachel.inbox-brief",
  "com.rachel.proactive-sweep",
  "com.rachel.proactive-calendar",
].sort();

// launchctl shim — same semantics as the eval harness's PATH-front shim,
// plus two fault-injection seams the reviews asked for: a per-label bootout
// delay (to separate the bootout instant from script start) and a per-label
// bootstrap failure.
const SHIM = `#!/bin/bash
log="\${LAUNCHCTL_LOG:?}"; state="\${LAUNCHCTL_STATE:?}"
echo "$@" >> "$log"
lbl_from() { if [ -f "$1" ]; then /usr/bin/plutil -extract Label raw -o - "$1"; else basename "$1"; fi; }
cmd="\${1:-}"; shift || true
case "$cmd" in
  bootstrap)
    shift
    for p in "$@"; do
      l="$(lbl_from "$p")"
      if [ -n "\${LAUNCHCTL_BOOTSTRAP_FAIL:-}" ] && [ "\${LAUNCHCTL_BOOTSTRAP_FAIL}" = "$l" ]; then echo "Bootstrap failed: 5" >&2; exit 5; fi
      if [ -n "\${LAUNCHCTL_SUPPRESS:-}" ] && [ "\${LAUNCHCTL_SUPPRESS}" = "$l" ]; then continue; fi
      if grep -qx "$l" "$state" 2>/dev/null; then echo "Bootstrap failed: 5" >&2; exit 5; fi
      echo "$l" >> "$state"
    done
    exit 0;;
  bootout)
    if [ $# -ge 2 ]; then l="$(lbl_from "$2")"; else l="\${1##*/}"; fi
    if [ -n "\${LAUNCHCTL_BOOTOUT_DELAY:-}" ] && [ "$l" = "\${LAUNCHCTL_BOOTOUT_DELAY_LABEL:-}" ]; then sleep "\${LAUNCHCTL_BOOTOUT_DELAY}"; fi
    if grep -qx "$l" "$state" 2>/dev/null; then
      grep -vx "$l" "$state" > "$state.tmp" || true
      mv "$state.tmp" "$state"; exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2; exit 3;;
  print)
    l="\${1##*/}"
    if grep -qx "$l" "$state" 2>/dev/null; then echo "state = running"; exit 0; fi
    exit 113;;
  list)
    if [ $# -ge 1 ]; then grep -qx "$1" "$state" 2>/dev/null && exit 0 || exit 113; fi
    awk '{print "1\\t0\\t" $0}' "$state" 2>/dev/null; exit 0;;
  *) exit 0;;
esac
`;

interface Sandbox {
  root: string;
  home: string;
  launchAgents: string;
  binDir: string;
  logPath: string;
  statePath: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "install-test-"));
  const home = join(root, "home");
  const launchAgents = join(home, "Library", "LaunchAgents");
  const binDir = join(root, "bin");
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(join(home, ".rachel"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, "launchctl.log");
  const statePath = join(root, "launchctl.state");
  writeFileSync(logPath, "");
  writeFileSync(statePath, "");
  const shimPath = join(binDir, "launchctl");
  writeFileSync(shimPath, SHIM);
  chmodSync(shimPath, 0o755);
  return { root, home, launchAgents, binDir, logPath, statePath };
}

function writeTelegramJson(sb: Sandbox): void {
  writeFileSync(
    join(sb.home, ".rachel", "telegram.json"),
    JSON.stringify({ token: "000000:TEST-DUMMY-NOT-A-TOKEN", chatId: "1" }),
  );
}

function writeFreshHeartbeat(sb: Sandbox): void {
  writeFileSync(join(sb.home, ".rachel", "bridge-heartbeat.json"), '{"schema_version":1}');
}

interface RunResult {
  status: number;
  output: string;
}

function runInstaller(
  sb: Sandbox,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
  installer: string = INSTALLER,
): RunResult {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("RACHEL_TELEGRAM") && !k.startsWith("INSTALL_")) env[k] = v;
  }
  env["HOME"] = sb.home;
  env["PATH"] = `${sb.binDir}:${process.env["PATH"] ?? ""}`;
  env["LAUNCHCTL_LOG"] = sb.logPath;
  env["LAUNCHCTL_STATE"] = sb.statePath;
  env["INSTALL_HEARTBEAT_WAIT_SECS"] = "8";
  Object.assign(env, extraEnv);
  const res = spawnSync(installer, args, { env, encoding: "utf8", cwd: dirname(dirname(installer)) });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, output: `${res.stdout}${res.stderr}` };
}

function installedPlists(sb: Sandbox): string[] {
  return readdirSync(sb.launchAgents).filter((f) => f.endsWith(".plist")).sort();
}

function stateLabels(sb: Sandbox): string[] {
  return readFileSync(sb.statePath, "utf8").split("\n").filter((l) => l !== "").sort();
}

// ---------------------------------------------------------------------------

test("dry-run prints the full plan naming all four labels with zero side effects", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  const { status, output } = runInstaller(sb, ["--dry-run"]);
  assert.strictEqual(status, 0, output);
  for (const label of LABELS) {
    assert.match(output, new RegExp(label), `plan must name ${label}`);
  }
  // Zero side effects: nothing installed, no proactive config created,
  // and no launchctl mutation verbs reached the shim.
  assert.deepStrictEqual(installedPlists(sb), []);
  assert.ok(!existsSync(join(sb.home, ".rachel", "proactive")), "dry-run must not create proactive config");
  const log = readFileSync(sb.logPath, "utf8");
  assert.ok(!/^(bootstrap|bootout|load|unload)/m.test(log), `dry-run must not mutate launchd: ${log}`);
});

test("real run stamps all four templates into LaunchAgents with the repo path and no placeholder remnants", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb);
  assert.strictEqual(status, 0, output);
  const plists = installedPlists(sb);
  assert.strictEqual(plists.length, 4, `expected 4 plists, got: ${plists.join(", ")}`);
  const labels: string[] = [];
  for (const f of plists) {
    const content = readFileSync(join(sb.launchAgents, f), "utf8");
    assert.ok(!content.includes("__REPO_PATH__"), `${f} still contains __REPO_PATH__`);
    assert.ok(content.includes(REPO_ROOT), `${f} must contain the discovered repo path ${REPO_ROOT}`);
    // Stamped output must still be a syntactically valid plist.
    execFileSync("/usr/bin/plutil", ["-lint", join(sb.launchAgents, f)]);
    const m = content.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
    assert.ok(m, `${f} must declare a Label`);
    labels.push(m[1]!);
  }
  assert.deepStrictEqual(labels.sort(), LABELS);
  // The verification summary is part of the run: PASS, and the heartbeat
  // check is named (not silently skipped).
  assert.match(output, /PASS/);
  assert.match(output, /heartbeat/i);
});

test("real run bootouts then bootstraps each service through launchctl", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb);
  assert.strictEqual(status, 0, output);
  const lines = readFileSync(sb.logPath, "utf8").split("\n").filter((l) => l !== "");
  const bootouts = lines.filter((l) => l.startsWith("bootout"));
  const bootstraps = lines.filter((l) => l.startsWith("bootstrap"));
  assert.ok(bootouts.length >= 4, `expected >=4 bootout calls, got ${bootouts.length}`);
  assert.ok(bootstraps.length >= 4, `expected >=4 bootstrap calls, got ${bootstraps.length}`);
  const firstBootout = lines.findIndex((l) => l.startsWith("bootout"));
  const firstBootstrap = lines.findIndex((l) => l.startsWith("bootstrap"));
  assert.ok(firstBootout < firstBootstrap, "first bootout must precede first bootstrap");
  assert.deepStrictEqual(stateLabels(sb), LABELS, "all four services must end up bootstrapped");
});

test("fails loud when telegram config is absent, naming both config routes", () => {
  const sb = makeSandbox();
  // No telegram.json, no RACHEL_TELEGRAM_* env (runInstaller strips them).
  const { status, output } = runInstaller(sb);
  assert.notStrictEqual(status, 0, "must exit nonzero without telegram config");
  assert.match(output, /telegram\.json/, "instructions must name the telegram.json route");
  assert.match(output, /RACHEL_TELEGRAM/, "instructions must name the env-var route");
  assert.ok(!existsSync(join(sb.home, ".rachel", "telegram.json")), "installer must never write credentials");
  assert.deepStrictEqual(installedPlists(sb), [], "preflight failure must precede any install");
});

test("accepts the env-var telegram route without writing credentials", () => {
  const sb = makeSandbox();
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb, [], {
    RACHEL_TELEGRAM_TOKEN: "000000:TEST-DUMMY-NOT-A-TOKEN",
    RACHEL_TELEGRAM_CHAT_ID: "1",
  });
  assert.strictEqual(status, 0, output);
  assert.ok(!existsSync(join(sb.home, ".rachel", "telegram.json")), "installer must never write credentials");
});

test("bootstraps proactive config with the documented defaults when absent", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb);
  assert.strictEqual(status, 0, output);
  const cfg = JSON.parse(readFileSync(join(sb.home, ".rachel", "proactive", "config.json"), "utf8"));
  // Pinned to proactive/push.ts DEFAULT_CONFIG verbatim.
  assert.strictEqual(cfg.schema_version, 1);
  assert.strictEqual(cfg.timezone, "Europe/Dublin");
  assert.deepStrictEqual(cfg.quiet_hours, { start: "22:30", end: "08:00" });
  assert.strictEqual(cfg.daily_budget, 10);
  assert.deepStrictEqual(cfg.pr_watch_repos, []);
  assert.deepStrictEqual(cfg.calendar_oneshot_hours, [8, 11, 14, 17]);
});

test("never overwrites an existing proactive config", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const cfgPath = join(sb.home, ".rachel", "proactive", "config.json");
  mkdirSync(dirname(cfgPath), { recursive: true });
  const userConfig = JSON.stringify({
    schema_version: 1,
    timezone: "Europe/Dublin",
    quiet_hours: { start: "23:00", end: "07:00" },
    daily_budget: 3,
    pr_watch_repos: [],
    calendar_oneshot_hours: [9],
  });
  writeFileSync(cfgPath, userConfig);
  const { status, output } = runInstaller(sb);
  assert.strictEqual(status, 0, output);
  assert.strictEqual(readFileSync(cfgPath, "utf8"), userConfig, "user config must be byte-untouched");
});

test("second run converges to an identical end state (idempotent over loaded services)", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const run1 = runInstaller(sb);
  assert.strictEqual(run1.status, 0, run1.output);
  const snapshot1 = installedPlists(sb).map((f) => readFileSync(join(sb.launchAgents, f), "utf8"));
  writeFreshHeartbeat(sb); // the live bridge would keep refreshing between runs
  // Second run: labels are now loaded in shim state, so a bootstrap without
  // a preceding bootout would exit 5 — the installer must still exit 0.
  const run2 = runInstaller(sb);
  assert.strictEqual(run2.status, 0, run2.output);
  const snapshot2 = installedPlists(sb).map((f) => readFileSync(join(sb.launchAgents, f), "utf8"));
  assert.deepStrictEqual(snapshot2, snapshot1, "installed plists must be byte-identical across runs");
  assert.deepStrictEqual(stateLabels(sb), LABELS, "each label must be loaded exactly once");
});

test("fails loud within its own bound when the heartbeat never appears", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  // No heartbeat file and nothing refreshing it.
  const started = Date.now();
  const { status, output } = runInstaller(sb, [], { INSTALL_HEARTBEAT_WAIT_SECS: "2" });
  const elapsedMs = Date.now() - started;
  assert.notStrictEqual(status, 0, "missing heartbeat must fail the run");
  assert.match(output, /FAIL/);
  assert.match(output, /heartbeat/i, "the failing check must be named");
  assert.ok(elapsedMs < 30_000, `wait must be bounded by the installer itself (took ${elapsedMs}ms)`);
});

test("verification names a service that failed to load and exits nonzero", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb, [], { LAUNCHCTL_SUPPRESS: "com.rachel.proactive-sweep" });
  assert.notStrictEqual(status, 0, "a missing service must fail the run");
  assert.match(output, /FAIL/);
  assert.match(output, /com\.rachel\.proactive-sweep/, "the summary must name the failing service");
});

// Builds a copy of the repo layout (script + templates) at `fakeRepo` so
// tests can vary the environment around the script — missing node_modules,
// hostile characters in the checkout path — without touching this repo.
// Proves as a side effect that the repo path is resolved from the script's
// own location, not from cwd or a hardcoded path.
function makeFakeRepo(fakeRepo: string, opts: { nodeModules: boolean }): string {
  for (const dir of ["scripts", "bridge", "tasks"]) mkdirSync(join(fakeRepo, dir), { recursive: true });
  const fakeInstaller = join(fakeRepo, "scripts", "install.sh");
  copyFileSync(INSTALLER, fakeInstaller);
  chmodSync(fakeInstaller, 0o755);
  copyFileSync(join(REPO_ROOT, "bridge", "launchd.plist"), join(fakeRepo, "bridge", "launchd.plist"));
  for (const f of ["inbox-brief-launchd.plist", "proactive-sweep-launchd.plist", "proactive-calendar-launchd.plist"]) {
    copyFileSync(join(REPO_ROOT, "tasks", f), join(fakeRepo, "tasks", f));
  }
  if (opts.nodeModules) {
    const bin = join(fakeRepo, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsx"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(bin, "tsx"), 0o755);
  }
  return fakeInstaller;
}

test("fails with npm install guidance when node_modules is missing", () => {
  const sb = makeSandbox();
  const fakeInstaller = makeFakeRepo(join(sb.root, "fake-repo"), { nodeModules: false });
  writeTelegramJson(sb); // config present, so the failure is attributable to node_modules
  const { status, output } = runInstaller(sb, [], {}, fakeInstaller);
  assert.notStrictEqual(status, 0, "missing node_modules must fail the run");
  assert.match(output, /npm install/, "must tell the user to run npm install");
  assert.deepStrictEqual(installedPlists(sb), [], "preflight failure must precede any install");
});

// --- Review-round tests (PR #31 two-reviewer gate) -------------------------

// CRITICAL 1a: the proactive config write must be checked — an unwritable
// directory (mkdir -p exits 0 on an existing chmod-555 dir) must produce a
// loud nonzero failure, never a "wrote" claim over a missing/truncated file.
test("fails loud when the proactive config directory is unwritable", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const cfgDir = join(sb.home, ".rachel", "proactive");
  mkdirSync(cfgDir, { recursive: true });
  chmodSync(cfgDir, 0o555);
  try {
    const { status, output } = runInstaller(sb);
    assert.notStrictEqual(status, 0, "unwritable config dir must fail the run");
    assert.match(output, /config\.json/, "the failure must name the config file");
    assert.ok(!existsSync(join(cfgDir, "config.json")), "no config file must exist");
  } finally {
    chmodSync(cfgDir, 0o755);
  }
});

// CRITICAL 1b: a pre-existing corrupt config.json is protected by the
// never-overwrite guard, so verification must catch it — push.ts would
// otherwise silently fall back to defaults on every tick.
test("verification fails on a pre-existing corrupt proactive config", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const cfgPath = join(sb.home, ".rachel", "proactive", "config.json");
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, '{"daily_budget":'); // truncated JSON
  const { status, output } = runInstaller(sb);
  assert.notStrictEqual(status, 0, "corrupt config must fail verification");
  assert.match(output, /FAIL/);
  assert.match(output, /config\.json/, "the failing check must name the config file");
  assert.strictEqual(readFileSync(cfgPath, "utf8"), '{"daily_budget":', "corrupt file must still not be overwritten");
});

// CRITICAL 2: heartbeat freshness must be measured from the bridge's
// bootout instant, not script start — otherwise the OUTGOING bridge's last
// write satisfies the check while the new bridge is wedged in 409 backoff.
// The shim delays the bridge bootout by 6s (beyond the 5s clock slack) so a
// heartbeat that was fresh at script start is provably pre-bootout.
test("verification rejects a heartbeat last written before the bridge bootout", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb); // fresh relative to script start, never refreshed again
  const { status, output } = runInstaller(sb, [], {
    LAUNCHCTL_BOOTOUT_DELAY: "6",
    LAUNCHCTL_BOOTOUT_DELAY_LABEL: "com.rachel.telegram-bridge",
    INSTALL_HEARTBEAT_WAIT_SECS: "2",
  });
  assert.notStrictEqual(status, 0, "a pre-bootout heartbeat must not pass verification");
  assert.match(output, /FAIL/);
  assert.match(output, /heartbeat/i, "the failing check must be named");
});

// IMPORTANT 1: a bootstrap failure mid-loop must not abort the remaining
// services — all plists are already on disk at that point, so the loop must
// complete, the summary must name the casualty, and the exit be nonzero.
test("a bootstrap failure on one service does not abort the remaining services", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb, [], { LAUNCHCTL_BOOTSTRAP_FAIL: "com.rachel.inbox-brief" });
  assert.notStrictEqual(status, 0, "a failed bootstrap must fail the run");
  assert.match(output, /FAIL/);
  assert.match(output, /com\.rachel\.inbox-brief/, "the summary must name the failed service");
  assert.deepStrictEqual(
    stateLabels(sb),
    LABELS.filter((l) => l !== "com.rachel.inbox-brief"),
    "the remaining services must still be bootstrapped",
  );
});

// IMPORTANT 2a: loadTelegramConfig's truthy check accepts a numeric chatId —
// the preflight must not be stricter than the runtime contract.
test("accepts a numeric chatId in telegram.json", () => {
  const sb = makeSandbox();
  writeFileSync(
    join(sb.home, ".rachel", "telegram.json"),
    JSON.stringify({ token: "000000:TEST-DUMMY-NOT-A-TOKEN", chatId: 1 }),
  );
  writeFreshHeartbeat(sb);
  const { status, output } = runInstaller(sb);
  assert.strictEqual(status, 0, output);
});

// IMPORTANT 2b: malformed JSON is "absent" to loadTelegramConfig, so the
// preflight must fail loud instead of letting the bridge crash-loop later.
test("fails loud at preflight on malformed telegram.json", () => {
  const sb = makeSandbox();
  writeFileSync(
    join(sb.home, ".rachel", "telegram.json"),
    '{"token": "000000:TEST-DUMMY-NOT-A-TOKEN", "chatId": "1",}', // trailing comma
  );
  const { status, output } = runInstaller(sb);
  assert.notStrictEqual(status, 0, "malformed telegram.json must fail preflight");
  assert.match(output, /telegram\.json/);
  assert.match(output, /RACHEL_TELEGRAM/);
  assert.deepStrictEqual(installedPlists(sb), [], "preflight failure must precede any install");
});

// IMPORTANT 3: a repo path containing XML-hostile characters must be caught
// at stamping time (plutil -lint on the stamped output), not surface later
// as an opaque bootstrap error — and the invalid plist must never land in
// LaunchAgents (atomic temp+rename with lint before the rename).
test("fails loud when the stamped plist would be invalid XML (hostile repo path)", () => {
  const sb = makeSandbox();
  const fakeInstaller = makeFakeRepo(join(sb.root, "fake & repo"), { nodeModules: true });
  writeTelegramJson(sb);
  const { status, output } = runInstaller(sb, [], {}, fakeInstaller);
  assert.notStrictEqual(status, 0, "invalid stamped XML must fail the run");
  assert.match(output, /lint/i, "the failure must come from the stamping lint check");
  assert.deepStrictEqual(installedPlists(sb), [], "no invalid plist may land in LaunchAgents");
});

// S3: extra arguments are a user error, not something to silently ignore.
test("rejects extra arguments with a usage error", () => {
  const sb = makeSandbox();
  writeTelegramJson(sb);
  const { status, output } = runInstaller(sb, ["--dry-run", "extra"]);
  assert.strictEqual(status, 2, output);
  assert.match(output, /usage/i);
});

// Dry-run restructure: preflight problems must not pre-empt the plan —
// --dry-run prints the full plan, THEN reports the problems, exiting nonzero.
test("dry-run prints the full plan then names preflight problems", () => {
  const sb = makeSandbox();
  // No telegram config at all.
  const { status, output } = runInstaller(sb, ["--dry-run"]);
  assert.notStrictEqual(status, 0, "dry-run must still signal that a real run would fail");
  for (const label of LABELS) {
    assert.match(output, new RegExp(label), `plan must still name ${label}`);
  }
  assert.match(output, /telegram\.json/);
  assert.match(output, /RACHEL_TELEGRAM/);
  assert.deepStrictEqual(installedPlists(sb), [], "still zero side effects");
});

test("honours INSTALL_HOME, INSTALL_LAUNCH_AGENTS_DIR and INSTALL_LAUNCHCTL seams", () => {
  const sb = makeSandbox();
  // Config + heartbeat live under an ALTERNATE home; plists go to an
  // alternate dir; launchctl comes from INSTALL_LAUNCHCTL, not PATH.
  const altHome = join(sb.root, "alt-home");
  mkdirSync(join(altHome, ".rachel"), { recursive: true });
  writeFileSync(
    join(altHome, ".rachel", "telegram.json"),
    JSON.stringify({ token: "000000:TEST-DUMMY-NOT-A-TOKEN", chatId: "1" }),
  );
  writeFileSync(join(altHome, ".rachel", "bridge-heartbeat.json"), '{"schema_version":1}');
  const altAgents = join(sb.root, "alt-agents");
  mkdirSync(altAgents, { recursive: true });
  const { status, output } = runInstaller(sb, [], {
    INSTALL_HOME: altHome,
    INSTALL_LAUNCH_AGENTS_DIR: altAgents,
    INSTALL_LAUNCHCTL: join(sb.binDir, "launchctl"),
    PATH: "/usr/bin:/bin", // shim NOT on PATH — must come from INSTALL_LAUNCHCTL
  });
  assert.strictEqual(status, 0, output);
  assert.strictEqual(readdirSync(altAgents).filter((f) => f.endsWith(".plist")).length, 4);
  assert.deepStrictEqual(installedPlists(sb), [], "default LaunchAgents dir must be untouched");
  assert.ok(existsSync(join(altHome, ".rachel", "proactive", "config.json")), "proactive config must follow INSTALL_HOME");
  assert.deepStrictEqual(stateLabels(sb), LABELS);
});
