import assert from "node:assert/strict";
import { test } from "node:test";
import { runCliInput } from "./main.ts";
import { resetCliSession, stopCliSession } from "./commands.ts";

test("CLI reset invalidates the session and confirms it", async () => {
  let reset = false;
  let output = "";
  await resetCliSession({ reset: async () => { reset = true; } }, (text) => { output += text; });
  assert.equal(reset, true);
  assert.equal(output, "Session reset.\n");
});

test("CLI stop reports whether it aborted an active turn", async () => {
  let output = "";
  let reason = "";
  await stopCliSession({ stop: async (value) => { reason = value ?? ""; return false; } }, (text) => { output += text; });
  await stopCliSession({ stop: async (value) => { reason = value ?? ""; return true; } }, (text) => { output += text; });
  assert.equal(reason, "user");
  assert.equal(output, "No active turn.\nStopped.\n");
});

test("CLI stop aborts the active turn without starting queued input or printing late events", async () => {
  const listeners: { line?: (line: string) => void; close?: () => void } = {};
  const input = {
    on(event: "line" | "close", listener: ((line: string) => void) | (() => void)) {
      if (event === "line") listeners.line = listener as (line: string) => void;
      else listeners.close = listener as () => void;
      return input;
    },
  };
  const emitLine = (line: string) => { assert.ok(listeners.line); listeners.line(line); };
  const emitClose = () => { assert.ok(listeners.close); listeners.close(); };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => { secondStarted = resolve; });
  let runs = 0;
  let stopped = false;
  let output = "";
  const session = {
    async *run(_input: { text: string }) {
      runs += 1;
      if (runs === 2) secondStarted();
      await released;
      yield { type: "text", sessionId: "s", turnId: String(runs), text: "late" } as const;
    },
    async reset() {},
    async stop() { stopped = true; return true; },
  };
  const loop = runCliInput(input, session, (event) => { output += `${event.type}\n`; }, (text) => { output += text; });
  emitLine("hello");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  emitLine("/stop");
  emitLine("after");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(stopped, true);
  assert.equal(runs, 1);
  assert.equal(output, "Stopped.\n");
  release();
  await started;
  assert.equal(runs, 2);
  emitClose();
  await loop;
  assert.equal(output, "Stopped.\ntext\n");
});
