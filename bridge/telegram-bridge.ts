#!/usr/bin/env -S npx tsx

// Telegram front-end for the secretary — owns THE single getUpdates
// consumer for the configured bot token (Telegram allows exactly one).
// Routes ordinary chat messages into a FIFO turn queue dispatched through
// runTurn(), and routes callback_query taps (approve/deny) immediately into
// the Telegram approval surface's handleCallbackQuery — never queued behind
// pending chat turns, since a gate decision may be blocking a turn.

import { tg, sendChunked, sendTyping, setMyCommands, type ApiConfig } from "./api.ts";
import type { TelegramApprovalSurface, TelegramCallbackQuery } from "../gate/surfaces/telegram.ts";

export type BridgeRunTurn = (input: string, emit: (line: string) => void, signal: AbortSignal) => Promise<void>;

export interface CreateBridgeOptions {
  config: ApiConfig;
  runTurn: BridgeRunTurn;
  getSessionId: () => string | undefined;
  resetSession: () => void;
  telegramSurface?: TelegramApprovalSurface;
  pollIntervalMs?: number;
  typingIntervalMs?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; from?: { id: number } };
  callback_query?: TelegramCallbackQuery;
}

const DEFAULT_TYPING_INTERVAL_MS = 5000;

export interface Bridge {
  // Runs one getUpdates cycle (and processes whatever it returns) — the
  // seam tests drive directly instead of the infinite run() loop.
  drainOnce(): Promise<void>;
  // Starts the real infinite poll + FIFO-drain loop. Resolves only when
  // stop() is called (or a fatal error occurs).
  run(): Promise<void>;
  stop(): Promise<void>;
}

export function createBridge(options: CreateBridgeOptions): Bridge {
  const { config, runTurn, getSessionId, resetSession } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const typingIntervalMs = options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

  const fifo: string[] = [];
  let offset: number | undefined;
  let stopped = false;
  let currentAbort: AbortController | undefined;
  let draining = false;
  let backoffMs = 1000;
  const MAX_BACKOFF_MS = 30_000;

  async function reply(text: string): Promise<void> {
    await sendChunked(config, text);
  }

  async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const fromChatId = String(msg.chat.id);
    if (fromChatId !== config.chatId) {
      // Audit row for rejected ingress — a message from an unauthorised
      // chat must never reach the agent.
      console.error(`[telegram-bridge] rejected message from unauthorised chat_id=${fromChatId}`);
      return;
    }

    const text = (msg.text ?? "").trim();
    if (!text) return;

    if (text === "/reset") {
      resetSession();
      await reply("Session reset.");
      return;
    }
    if (text === "/status") {
      const sessionId = getSessionId();
      await reply(
        `uptime: ${Math.floor(process.uptime())}s\n` +
          `session: ${sessionId ?? "(none)"}\n` +
          `model: ${process.env["SECRETARY_MODEL"] ?? "claude-sonnet-4-6"}\n` +
          `turn in flight: ${currentAbort ? "yes" : "no"}`,
      );
      return;
    }
    if (text === "/stop") {
      if (currentAbort) {
        currentAbort.abort();
        await reply("Stopped.");
      } else {
        await reply("No turn in flight.");
      }
      return;
    }

    fifo.push(text);
  }

  async function handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
    if (String(cb.from.id) !== config.chatId) {
      console.error(`[telegram-bridge] rejected callback_query from unauthorised from_id=${cb.from.id}`);
      return;
    }
    if (options.telegramSurface) {
      await options.telegramSurface.handleCallbackQuery(cb);
    }
  }

  async function drainFifo(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (fifo.length > 0) {
        const text = fifo.shift()!;
        const abortController = new AbortController();
        currentAbort = abortController;

        const typingTimer = setInterval(() => {
          sendTyping(config).catch(() => {
            // Best-effort — a failed typing indicator must never affect the turn.
          });
        }, typingIntervalMs);
        // Fire once immediately so the indicator appears without waiting a
        // full interval for a short turn.
        sendTyping(config).catch(() => {});

        const buffer: string[] = [];
        try {
          await runTurn(text, (line) => buffer.push(line), abortController.signal);
        } catch (err) {
          buffer.push(`[secretary] error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearInterval(typingTimer);
          currentAbort = undefined;
        }

        const replyText = buffer.join("\n").trim();
        await reply(replyText || "(no output)");
      }
    } finally {
      draining = false;
    }
  }

  async function processUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      offset = update.update_id + 1;
      const cbq = update.callback_query;
      if (update.message) {
        await handleMessage(update.message);
      }
      if (cbq) {
        // MUTATION: queue callback behind a fake long delay to simulate
        // "queued behind pending chat turns".
        setTimeout(() => { void handleCallbackQuery(cbq); }, 500);
        continue;
      }
    }
    // Kick the FIFO drain off without blocking this poll cycle — a
    // long-running turn (or one waiting on /stop) must never stall getUpdates,
    // since /stop itself has to arrive via the next poll.
    void drainFifo().catch((err) => {
      console.error(`[telegram-bridge] drain error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function pollOnce(): Promise<void> {
    const params = new URLSearchParams({ timeout: "30" });
    if (offset !== undefined) params.set("offset", String(offset));
    const result = (await tg(config, `getUpdates?${params.toString()}`, {})) as TelegramUpdate[];
    backoffMs = 1000;
    await processUpdates(result ?? []);
  }

  return {
    async drainOnce() {
      await pollOnce();
    },

    async run() {
      setMyCommands(config, [
        { command: "reset", description: "Reset the conversation session" },
        { command: "status", description: "Show bridge status" },
        { command: "stop", description: "Abort the in-flight turn" },
      ]).catch((err) => {
        console.error(`[telegram-bridge] setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      while (!stopped) {
        try {
          await pollOnce();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("409") || message.toLowerCase().includes("conflict")) {
            // A second getUpdates consumer on this token is fatal — Telegram
            // allows exactly one. Exit loud; launchd restarts the process.
            console.error(`[telegram-bridge] FATAL: ${message} — a second getUpdates consumer detected, exiting.`);
            process.exit(1);
          }
          console.error(`[telegram-bridge] poll error: ${message}`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    },

    async stop() {
      stopped = true;
      if (currentAbort) {
        currentAbort.abort();
      }
    },
  };
}

// Only start the real bridge when this file is executed directly, not when
// imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadTelegramConfig } = await import("../gate/surfaces/telegram.ts");
  // Import secretary.ts's OWN telegramSurface instance — the one its
  // send-gate hook actually races against — rather than constructing a
  // second, disconnected surface here. A callback tap must resolve the same
  // instance the gate is waiting on.
  const { runTurn, getSessionId, resetSession, telegramSurface } = await import("../secretary.ts");

  const telegramConfig = loadTelegramConfig();
  if (!telegramConfig) {
    console.error("[telegram-bridge] no Telegram config found (SECRETARY_TELEGRAM_TOKEN/SECRETARY_TELEGRAM_CHAT_ID or ~/.secretary/telegram.json) — exiting.");
    process.exit(2);
  }
  if (!telegramSurface) {
    console.error("[telegram-bridge] secretary.ts loaded but its telegramSurface is undefined — config mismatch, exiting.");
    process.exit(2);
  }

  const bridge = createBridge({
    config: telegramConfig,
    runTurn,
    getSessionId,
    resetSession,
    telegramSurface,
  });

  process.on("SIGINT", () => void bridge.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void bridge.stop().then(() => process.exit(0)));

  console.log("[telegram-bridge] starting.");
  await bridge.run();
}
