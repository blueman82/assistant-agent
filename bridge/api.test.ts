import { test } from "node:test";
import assert from "node:assert/strict";
import { tg, sendChunked, sendTyping, setMyCommands, stripMarkdown } from "./api.ts";

function makeStubTransport(handler: (url: string, body: unknown) => unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    return { ok: true, json: async () => handler(url, body) } as Response;
  };
  return { transport, calls };
}

test("tg() posts to the method URL and returns the parsed body on ok:true", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: { foo: "bar" } }));
  const result = await tg({ token: "t", chatId: "1", transport }, "sendMessage", { chat_id: "1", text: "hi" });
  assert.deepEqual(result, { foo: "bar" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes("/sendMessage"));
});

test("tg() aborts and rejects when the transport hangs past requestTimeoutMs", async () => {
  // A wedged getUpdates long-poll never resolves and never throws — without a
  // timeout, tg() would hang forever and the bridge's health machine (which
  // assumes failures throw) never fires. Prove the AbortSignal.timeout turns a
  // hang into an observable rejection. The stub honours the signal exactly as
  // real fetch does; a stub that ignored it would hang this test rather than
  // fail it.
  const transport: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject((init!.signal as AbortSignal).reason));
    });
  await assert.rejects(
    () => tg({ token: "t", chatId: "1", transport, requestTimeoutMs: 20 }, "getUpdates", {}),
    /request failed/,
  );
});

test("tg() throws when the HTTP response is not ok", async () => {
  const transport: typeof fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: "boom" }) } as Response);
  await assert.rejects(() => tg({ token: "t", chatId: "1", transport }, "sendMessage", {}), /boom/);
});

test("tg() throws when the Telegram body reports ok:false", async () => {
  const transport: typeof fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: "Bad Request: nope" }) } as Response);
  await assert.rejects(() => tg({ token: "t", chatId: "1", transport }, "sendMessage", {}), /Bad Request: nope/);
});

test("tg() redacts the bot token from any thrown error message", async () => {
  const transport: typeof fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: "fail" }) } as Response);
  await assert.rejects(
    () => tg({ token: "SECRET-TOKEN-123", chatId: "1", transport }, "sendMessage", {}),
    (err: Error) => {
      assert.ok(!err.message.includes("SECRET-TOKEN-123"), `error message leaked the token: ${err.message}`);
      return true;
    },
  );
});

test("sendChunked sends the whole text in one call when under 4096 chars", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  await sendChunked({ token: "t", chatId: "1", transport }, "hello world");
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sendCalls.length, 1);
  assert.equal((sendCalls[0]!.body as Record<string, unknown>)["text"], "hello world");
});

test("sendChunked splits text over 4096 chars into multiple calls, each <= 4096, reconstructing the original", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  const text = "x".repeat(5000);
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCalls.length > 1);
  const texts = sendCalls.map((c) => (c.body as Record<string, unknown>)["text"] as string);
  for (const t of texts) {
    assert.ok(t.length <= 4096);
  }
  assert.equal(texts.join("").length, 5000);
});

test("sendChunked splits at the last newline before the 4096 boundary when one exists", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  // Construct text with a newline just before the 4096 boundary so the
  // splitter should prefer breaking there over a mid-word cut.
  const before = "a".repeat(4000) + "\n" + "b".repeat(50);
  const after = "c".repeat(200);
  const text = before + after;
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  const firstChunk = (sendCalls[0]!.body as Record<string, unknown>)["text"] as string;
  assert.equal(firstChunk, "a".repeat(4000) + "\n", "first chunk should break right after the newline, not mid-word past it");
  const rejoined = sendCalls.map((c) => (c.body as Record<string, unknown>)["text"] as string).join("");
  assert.equal(rejoined.length, text.length);
});

test("sendChunked never splits a surrogate pair across chunks when it straddles the 4096 boundary", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  // An astral character (emoji, U+1F600) is a surrogate pair in UTF-16. Place
  // it exactly at the 4096-unit boundary so a naive .slice(0, 4096) splits
  // the pair: chunk 0 ends in the lone high surrogate, chunk 1 starts with
  // the lone low surrogate.
  const text = "a".repeat(4095) + "\u{1F600}" + "b".repeat(10);
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  const texts = sendCalls.map((c) => (c.body as Record<string, unknown>)["text"] as string);
  for (const t of texts) {
    // A lone surrogate silently UTF-8-encodes to U+FFFD (replacement
    // character) rather than throwing, so the corruption only shows up as a
    // round-trip mismatch, not an exception.
    const roundTripped = new TextDecoder("utf-8").decode(new TextEncoder().encode(t));
    assert.equal(roundTripped, t, `chunk contains a lone surrogate that corrupts on UTF-8 encode: ${JSON.stringify(t)}`);
  }
  assert.equal(texts.join(""), text, "rejoined chunks must equal the original text exactly");
});

test("sendTyping calls sendChatAction with action 'typing'", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: true }));
  await sendTyping({ token: "t", chatId: "1", transport });
  const call = calls.find((c) => c.url.includes("/sendChatAction"));
  assert.ok(call);
  assert.equal((call!.body as Record<string, unknown>)["action"], "typing");
  assert.equal((call!.body as Record<string, unknown>)["chat_id"], "1");
});

test("setMyCommands posts the given command list", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: true }));
  await setMyCommands({ token: "t", chatId: "1", transport }, [
    { command: "reset", description: "Reset session" },
    { command: "status", description: "Show status" },
    { command: "stop", description: "Abort in-flight turn" },
  ]);
  const call = calls.find((c) => c.url.includes("/setMyCommands"));
  assert.ok(call);
  const body = call!.body as Record<string, unknown>;
  assert.equal((body["commands"] as unknown[]).length, 3);
});

test("stripMarkdown removes ** bold markers keeping the content", () => {
  assert.equal(stripMarkdown("an **urgent** reply"), "an urgent reply");
});

test("stripMarkdown removes single-asterisk italic markers keeping the content", () => {
  assert.equal(stripMarkdown("that *really* matters"), "that really matters");
});

test("stripMarkdown removes double-underscore markers keeping the content", () => {
  assert.equal(stripMarkdown("__note__ this"), "note this");
});

test("stripMarkdown removes leading header hashes at line start", () => {
  assert.equal(stripMarkdown("## Today\nfirst thing"), "Today\nfirst thing");
  assert.equal(stripMarkdown("### Deeper\nbody"), "Deeper\nbody");
});

test("stripMarkdown removes inline-code backticks keeping the content", () => {
  assert.equal(stripMarkdown("run `npm start` now"), "run npm start now");
});

test("stripMarkdown converts [text](url) links to text (url)", () => {
  assert.equal(stripMarkdown("[calendar](https://cal.example/week)"), "calendar (https://cal.example/week)");
});

test("stripMarkdown leaves list hyphens alone", () => {
  assert.equal(stripMarkdown("- milk\n- eggs"), "- milk\n- eggs");
});

test("stripMarkdown is a no-op on already-plain text", () => {
  const plain = "Meeting moved to 3pm. Room 4. Bring the printout.";
  assert.equal(stripMarkdown(plain), plain);
});

test("stripMarkdown does not mangle URLs containing single underscores", () => {
  assert.equal(stripMarkdown("see https://docs.example/api_reference_v2"), "see https://docs.example/api_reference_v2");
});

test("stripMarkdown leaves genuine asterisk maths with surrounding spaces alone", () => {
  assert.equal(stripMarkdown("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
});

test("stripMarkdown leaves fenced code blocks byte-identical, including hashes, backticks, and asterisks inside", () => {
  const fenced = "```python\n# fetch the data\ndef f(*args, **kwargs):\n    pass\n```";
  assert.equal(stripMarkdown(fenced), fenced);
});

test("stripMarkdown sanitises text around a fence while leaving the fence untouched", () => {
  const input = "Here's the script, **run it**:\n```sh\n# step one\necho *glob*\n```\nthen `reboot`.";
  assert.equal(stripMarkdown(input), "Here's the script, run it:\n```sh\n# step one\necho *glob*\n```\nthen reboot.");
});

test("stripMarkdown leaves unspaced asterisk arithmetic alone", () => {
  assert.equal(stripMarkdown("3*4=12 and 5*6=30"), "3*4=12 and 5*6=30");
});

test("stripMarkdown leaves single-underscore emphasis untouched by design (only double underscores are markers)", () => {
  assert.equal(stripMarkdown("_important_ note"), "_important_ note");
});

test("sendChunked strips markdown on the whole text before chunking, so a marker straddling the 4096 boundary never leaks", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  // Place ** markers so the bold span crosses the 4096-unit boundary: if
  // stripping ran per-chunk instead of pre-chunk, the pair would be split
  // across chunks and both halves would leak literal asterisks.
  const text = "a".repeat(4090) + " **bold across the boundary** " + "b".repeat(200);
  await sendChunked({ token: "t", chatId: "1", transport }, text);
  const rejoined = calls
    .filter((c) => c.url.includes("/sendMessage"))
    .map((c) => (c.body as Record<string, unknown>)["text"] as string)
    .join("");
  assert.ok(!rejoined.includes("*"), `asterisks leaked to Telegram: ${JSON.stringify(rejoined.slice(4080, 4130))}`);
  assert.ok(rejoined.includes("bold across the boundary"));
});

test("stripMarkdown handles a mixed markdown message in one pass", () => {
  assert.equal(
    stripMarkdown("## Inbox\n**Two** new mails, reply via *phone* or [webmail](https://mail.example)"),
    "Inbox\nTwo new mails, reply via phone or webmail (https://mail.example)",
  );
});

test("sendChunked strips markdown before the text reaches the sendMessage body", async () => {
  const { transport, calls } = makeStubTransport(() => ({ ok: true, result: {} }));
  await sendChunked({ token: "t", chatId: "1", transport }, "**Done.** Draft saved to `drafts/`");
  const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal((sendCalls[0]!.body as Record<string, unknown>)["text"], "Done. Draft saved to drafts/");
});

test("grep guard: no test in this file ever calls the real api.telegram.org network endpoint", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./api.test.ts", import.meta.url), "utf8");
  const realFetchCall = /fetch\(\s*["'`]https:\/\/api\.telegram\.org/;
  assert.equal(realFetchCall.test(source), false);
});
