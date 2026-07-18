import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, synthesize, convertToOgg, type ExecFileFn } from "./speech.ts";

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

test("synthesize() shells out to the venv python with synthesize.py, the text, the outPath, and a 20s timeout", async () => {
  const { fn, calls } = stubExec({});
  await synthesize("hello Gary", "/tmp/reply.wav", fn);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /\.rachel\/venvs\/speech\/bin\/python$/);
  assert.match(calls[0]!.args[0]!, /scripts\/speech\/synthesize\.py$/);
  assert.equal(calls[0]!.args[1], "hello Gary");
  assert.equal(calls[0]!.args[2], "/tmp/reply.wav");
  assert.equal(calls[0]!.timeoutMs, 20_000);
});

test("synthesize() throws on nonzero exit", async () => {
  const { fn } = stubExec({ exitCode: 1, stderr: "voice preset not found" });
  await assert.rejects(() => synthesize("hi", "/tmp/reply.wav", fn), /voice preset not found/);
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
