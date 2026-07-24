import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, synthesize, convertToOgg, synthesizeTimeoutMs, type ExecFileFn } from "./speech.ts";

type Captured = { cmd: string; args: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv };

function stubExec(result: { stdout?: string; stderr?: string; exitCode?: number }): {
  fn: ExecFileFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fn: ExecFileFn = async (cmd, args, timeoutMs, env) => {
    calls.push({ cmd, args, timeoutMs, env });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { fn, calls };
}

test("transcribe() shells out to the venv python with transcribe.py, the audio path, and a 2-minute timeout", async () => {
  const { fn, calls } = stubExec({ stdout: "hello there\n" });
  await transcribe("/tmp/voice.ogg", fn);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /\.rachel\/venvs\/speech\/bin\/python$/);
  assert.match(calls[0]!.args[0]!, /scripts\/speech\/transcribe\.py$/);
  assert.equal(calls[0]!.args[1], "/tmp/voice.ogg");
  assert.equal(calls[0]!.timeoutMs, 120_000);
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

// Regression: RCA 2026-07-23 headline finding 3. mlx-whisper performs a
// HuggingFace Hub freshness check on every call even with the model fully
// cached. With the HF endpoint unreachable it hung past 45s before touching
// the audio, and the execFile budget SIGTERMed it — five such failures in the
// bridge log. HF_HUB_OFFLINE=1 makes huggingface_hub use the local cache
// only: measured 4.3s vs 12.2s, no network touch.
test("transcribe() sets HF_HUB_OFFLINE=1 in the child env (no HuggingFace hub round-trip)", async () => {
  const { fn, calls } = stubExec({ stdout: "hello there\n" });
  await transcribe("/tmp/voice.ogg", fn);
  assert.equal(calls[0]!.env?.HF_HUB_OFFLINE, "1");
});

// The child env REPLACES rather than merges (node's execFile, same trap as
// the SDK's query() env). Passing a bare { HF_HUB_OFFLINE: "1" } would strip
// HOME — and huggingface_hub locates its cache via HOME. Offline mode plus no
// cache path is a hard failure, i.e. the exact opposite of this fix.
test("transcribe() inherits the parent env rather than replacing it (HOME locates the HF cache)", async () => {
  const { fn, calls } = stubExec({ stdout: "hello there\n" });
  await transcribe("/tmp/voice.ogg", fn);
  assert.equal(calls[0]!.env?.HOME, process.env.HOME);
  assert.equal(calls[0]!.env?.PATH, process.env.PATH);
});

// Same hub check on the synthesis side: "Fetching 56 files" was observed in
// the live logs for the Kokoro model, which is likewise already cached.
test("synthesize() sets HF_HUB_OFFLINE=1 in the child env", async () => {
  const { fn, calls } = stubExec({});
  await synthesize("hello Gary", "/tmp/reply.wav", fn);
  assert.equal(calls[0]!.env?.HF_HUB_OFFLINE, "1");
});

test("synthesize() inherits the parent env rather than replacing it", async () => {
  const { fn, calls } = stubExec({});
  await synthesize("hello Gary", "/tmp/reply.wav", fn);
  assert.equal(calls[0]!.env?.HOME, process.env.HOME);
  assert.equal(calls[0]!.env?.PATH, process.env.PATH);
});

// ffmpeg is not a HuggingFace consumer — it gets no env override, so the
// child simply inherits the parent's environment via execFile's default.
test("convertToOgg() passes no env override (ffmpeg has no HuggingFace dependency)", async () => {
  const { fn, calls } = stubExec({});
  await convertToOgg("/tmp/reply.wav", "/tmp/reply.ogg", fn);
  assert.equal(calls[0]!.env, undefined);
});

// Item 4 (Gary's decision, overruling the RCA author's "no change"): a human
// may legitimately send a voice note longer than the old 30s budget allowed.
test("transcribe() budget is 2 minutes, room for a genuinely long voice note", async () => {
  const { fn, calls } = stubExec({ stdout: "hello there\n" });
  await transcribe("/tmp/voice.ogg", fn);
  assert.ok(
    calls[0]!.timeoutMs >= 120_000,
    `transcribe budget must be at least 120000ms, got ${calls[0]!.timeoutMs}`,
  );
});

test("grep guard: no test in this file ever invokes defaultExecFileFn (no real subprocess spawn in CI)", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./speech.test.ts", import.meta.url), "utf8");
  assert.equal(/defaultExecFileFn\(/.test(source), false);
});
