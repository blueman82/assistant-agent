import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify, parseNotifyArgv } from "./notify.ts";

function makeStubTransport() {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    return { ok: true, json: async () => ({ ok: true, result: {} }) } as Response;
  };
  return { transport, calls };
}

test("notify() reads the message from the given file path and sends it to the configured chatId", async () => {
  const { transport, calls } = makeStubTransport();
  const dir = mkdtempSync(join(tmpdir(), "rachel-notify-test-"));
  const filePath = join(dir, "brief.txt");
  writeFileSync(filePath, "needs-action: 1 thread. new: 0. noise: 2.");

  await notify(filePath, () => ({ token: "t", chatId: "12345", transport }));

  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes("/sendMessage"));
  assert.equal((calls[0]!.body as { chat_id: string }).chat_id, "12345");
  assert.equal((calls[0]!.body as { text: string }).text, "needs-action: 1 thread. new: 0. noise: 2.");
});

test("notify() throws when no Telegram config is available, rather than silently doing nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rachel-notify-test-"));
  const filePath = join(dir, "brief.txt");
  writeFileSync(filePath, "hello");

  await assert.rejects(
    () => notify(filePath, () => undefined),
    /no Telegram config/,
  );
});

test("parseNotifyArgv returns the file path for exactly one CLI argument", () => {
  assert.equal(parseNotifyArgv(["node", "notify.ts", "/tmp/x"]), "/tmp/x");
});

test("parseNotifyArgv returns null when the file path argument is missing", () => {
  assert.equal(parseNotifyArgv(["node", "notify.ts"]), null);
});

test("parseNotifyArgv returns null when any extra argument is present (no-destination pin: extra argv must reject, never be silently ignored)", () => {
  assert.equal(parseNotifyArgv(["node", "notify.ts", "/tmp/x", "@evil_chat"]), null);
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./notify.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
