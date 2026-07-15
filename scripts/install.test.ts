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

// launchctl shim — same semantics as the eval harness's PATH-front shim.
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
      if [ -n "\${LAUNCHCTL_SUPPRESS:-}" ] && [ "\${LAUNCHCTL_SUPPRESS}" = "$l" ]; then continue; fi
      if grep -qx "$l" "$state" 2>/dev/null; then echo "Bootstrap failed: 5" >&2; exit 5; fi
      echo "$l" >> "$state"
    done
    exit 0;;
  bootout)
    if [ $# -ge 2 ]; then l="$(lbl_from "$2")"; else l="\${1##*/}"; fi
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

test("fails with npm install guidance when node_modules is missing", () => {
  const sb = makeSandbox();
  // Build a fake repo around a copy of the script: same layout, no
  // node_modules — also proves the repo path is resolved from the script's
  // own location, not from cwd or a hardcoded path.
  const fakeRepo = join(sb.root, "fake-repo");
  for (const dir of ["scripts", "bridge", "tasks"]) mkdirSync(join(fakeRepo, dir), { recursive: true });
  const fakeInstaller = join(fakeRepo, "scripts", "install.sh");
  copyFileSync(INSTALLER, fakeInstaller);
  chmodSync(fakeInstaller, 0o755);
  copyFileSync(join(REPO_ROOT, "bridge", "launchd.plist"), join(fakeRepo, "bridge", "launchd.plist"));
  for (const f of ["inbox-brief-launchd.plist", "proactive-sweep-launchd.plist", "proactive-calendar-launchd.plist"]) {
    copyFileSync(join(REPO_ROOT, "tasks", f), join(fakeRepo, "tasks", f));
  }
  writeTelegramJson(sb); // config present, so the failure is attributable to node_modules
  const { status, output } = runInstaller(sb, [], {}, fakeInstaller);
  assert.notStrictEqual(status, 0, "missing node_modules must fail the run");
  assert.match(output, /npm install/, "must tell the user to run npm install");
  assert.deepStrictEqual(installedPlists(sb), [], "preflight failure must precede any install");
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
