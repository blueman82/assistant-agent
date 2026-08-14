import { createTelegramRuntime } from "./src/telegram/runtime.ts";

const sent: string[] = [];
let downloadCalled = 0;
const api = {
  send: async (_c: string, t: string) => { sent.push(t); },
  download: async () => { downloadCalled++; },
  getUpdates: async () => [],
  sendVoice: async () => {},
  answerCallbackQuery: async () => {},
} as never;

let turnCalls = 0;
const logs: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((c: string) => { logs.push(String(c)); return true; }) as never;

const rt = createTelegramRuntime(
  { token: "t", chatId: "1" },
  async (_text: string, reply: (t: string) => Promise<void>) => { turnCalls++; await reply("hello back"); },
  { api, mediaDirectory: "/tmp" },
);
rt.queue.add({ message_id: 1, chat: { id: 1 }, text: "hi" } as never);
await new Promise((r) => setTimeout(r, 300));
process.stdout.write = realWrite;

console.log("turn() calls:", turnCalls);
console.log("api.download calls:", downloadCalled);
console.log("replies sent:", JSON.stringify(sent));
console.log("--- stdout log lines ---");
for (const l of logs) process.stdout.write("  " + l);
