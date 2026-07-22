import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, synthesize, convertToOgg, synthesizeTimeoutMs, type ExecFileFn } from "./speech.ts";

function stubExec(result: { stdout?: string; stderr?: string; exitCode?: number }): {
  fn: ExecFileFn;
  calls: { cmd: string; args: string[]; timeoutMs: number }[];
} {
  const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
  const fn: ExecFileFn = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { fn, calls };
}

test("transcribe() shells out to the venv python with transcribe.py, the audio path, and a 30s timeout", async () => {
  const { fn, calls } = stubExec({ stdout: "hello there\n" });
  await transcribe("/tmp/voice.ogg", fn);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /\.rachel\/venvs\/speech\/bin\/python$/);
  assert.match(calls[0]!.args[0]!, /scripts\/speech\/transcribe\.py$/);
  assert.equal(calls[0]!.args[1], "/tmp/voice.ogg");
  assert.equal(calls[0]!.timeoutMs, 30_000);
});

test("transcribe() trims trailing whitespace/newline from stdout", async () => {
  const { fn } = stubExec({ stdout: "  hello there  \n" });
  const result = await transcribe("/tmp/voice.ogg", fn);
  assert.equal(result, "hello there");
});

test("transcribe() throws on nonzero exit, including stderr detail", async () => {
  const { fn } = stubExec({ exitCode: 1, stderr: "model load failed" });
  await assert.rejects(() => transcribe("/tmp/voice.ogg", fn), /model load failed/);
});

test("transcribe() throws on an empty transcript", async () => {
  const { fn } = stubExec({ stdout: "   " });
  await assert.rejects(() => transcribe("/tmp/voice.ogg", fn), /empty transcript/);
});

test("synthesize() shells out to the venv python with synthesize.py, the text, the outPath, and a length-scaled timeout", async () => {
  const { fn, calls } = stubExec({});
  await synthesize("hello Gary", "/tmp/reply.wav", fn);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /\.rachel\/venvs\/speech\/bin\/python$/);
  assert.match(calls[0]!.args[0]!, /scripts\/speech\/synthesize\.py$/);
  assert.equal(calls[0]!.args[1], "hello Gary");
  assert.equal(calls[0]!.args[2], "/tmp/reply.wav");
  assert.equal(calls[0]!.timeoutMs, synthesizeTimeoutMs("hello Gary".length));
});

test("synthesize() throws on nonzero exit", async () => {
  const { fn } = stubExec({ exitCode: 1, stderr: "voice preset not found" });
  await assert.rejects(() => synthesize("hi", "/tmp/reply.wav", fn), /voice preset not found/);
});

// Regression: 2026-07-22 voice-reply incident. mlx-audio's generate_audio
// catches every exception, prints the reason with a bare print() — STDOUT —
// then returns normally without writing a file. synthesize.py correctly exits
// 1 naming the no-output condition on stderr, but the *reason* is on stdout.
// synthesize() discarded stdout, so the live log recorded only a progress bar
// and the failure was undiagnosable.
test("synthesize() includes stdout in the thrown error (upstream prints its reason to stdout)", async () => {
  const { fn } = stubExec({
    exitCode: 1,
    stdout: "Error loading model: kokoro weights missing",
    stderr: "Fetching 56 files: 100%",
  });
  await assert.rejects(
    () => synthesize("hi", "/tmp/reply.wav", fn),
    /kokoro weights missing/,
  );
});

test("synthesize() still reports stderr when stdout is empty", async () => {
  const { fn } = stubExec({ exitCode: 1, stdout: "", stderr: "voice preset not found" });
  await assert.rejects(() => synthesize("hi", "/tmp/reply.wav", fn), /voice preset not found/);
});

// Regression: the same incident's latent second cliff. Synthesis cost scales
// with text length (measured on host: 210 chars -> 6s, 9800 -> 25s, 9696 of
// Rachel-shaped text -> 30s), so a flat 20s budget fails every long reply.
// Bumping the constant just moves the cliff, so the budget is a function of
// length with a floor for cold model load and a ceiling against runaways.
test("synthesizeTimeoutMs() grants a long reply more than its measured real duration", () => {
  // The live failing reply: 9696 chars, measured at 30s.
  assert.ok(
    synthesizeTimeoutMs(9696) > 30_000,
    `9696 chars must get >30000ms, got ${synthesizeTimeoutMs(9696)}`,
  );
});

test("synthesizeTimeoutMs() grows with text length", () => {
  assert.ok(synthesizeTimeoutMs(9696) > synthesizeTimeoutMs(200));
});

test("synthesizeTimeoutMs() keeps a floor covering cold model load for short text", () => {
  assert.ok(synthesizeTimeoutMs(10) >= 15_000, `got ${synthesizeTimeoutMs(10)}`);
});

test("synthesizeTimeoutMs() is bounded so a runaway text cannot hang the bridge", () => {
  const ms = synthesizeTimeoutMs(1_000_000);
  assert.ok(Number.isFinite(ms) && ms <= 600_000, `got ${ms}`);
});

test("synthesize() passes the length-scaled budget through to execFile", async () => {
  const { fn, calls } = stubExec({});
  const text = "x".repeat(9696);
  await synthesize(text, "/tmp/reply.wav", fn);
  assert.equal(calls[0]!.timeoutMs, synthesizeTimeoutMs(text.length));
});

test("convertToOgg() shells out to ffmpeg with the exact libopus argv and a 15s timeout", async () => {
  const { fn, calls } = stubExec({});
  await convertToOgg("/tmp/reply.wav", "/tmp/reply.ogg", fn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "ffmpeg");
  assert.deepEqual(calls[0]!.args, ["-y", "-i", "/tmp/reply.wav", "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "/tmp/reply.ogg"]);
  assert.equal(calls[0]!.timeoutMs, 15_000);
});

test("convertToOgg() throws on nonzero exit", async () => {
  const { fn } = stubExec({ exitCode: 1, stderr: "ffmpeg: command not found" });
  await assert.rejects(() => convertToOgg("/tmp/reply.wav", "/tmp/reply.ogg", fn), /command not found/);
});

test("grep guard: no test in this file ever invokes defaultExecFileFn (no real subprocess spawn in CI)", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./speech.test.ts", import.meta.url), "utf8");
  assert.equal(/defaultExecFileFn\(/.test(source), false);
});
