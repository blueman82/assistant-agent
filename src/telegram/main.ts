import { tmpdir } from "node:os";
import { createApprovalPolicy } from "../core/approval.ts";
import { AgentError, type ApprovalRequest, type TurnEvent } from "../core/contracts.ts";
import { providerFromEnvironment } from "../providers/selection.ts";
import { createProviderRuntime } from "../providers/runtime.ts";
import { LocalSpeech } from "../speech/local.ts";
import { createTelegramApi } from "./api.ts";
import { createApprovalTransport } from "./approval.ts";
import { createTelegramRuntime } from "./runtime.ts";
import type { TelegramConfig } from "./types.ts";

function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = env.RACHEL_TELEGRAM_TOKEN;
  const chatId = env.RACHEL_TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new AgentError("telegram_config_missing", "RACHEL_TELEGRAM_TOKEN and RACHEL_TELEGRAM_CHAT_ID are required");
  return { token, chatId };
}

function replyFor(
  event: TurnEvent,
  reply: (text: string) => Promise<void>,
  context: {
    approval: ReturnType<typeof createApprovalPolicy>;
    transport: ReturnType<typeof createApprovalTransport>;
    pending: Map<string, ApprovalRequest>;
  },
): Promise<void> | undefined {
  if (event.type === "text") return reply(event.text);
  if (event.type === "error") throw event.error;
  if (event.type === "approval_required") {
    const hash = context.approval.hash(event.request);
    context.pending.set(hash.slice(0, 32), event.request);
    void context.approval.request(event.request);
    void context.transport.request(hash, `Approval required for ${event.request.toolName}`);
  }
  return undefined;
}

export async function runTelegram(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = providerFromEnvironment(env);
  const runtime = createProviderRuntime(provider);
  const status = await runtime.checkAvailability();
  if (!status.authenticated) throw new AgentError("authentication_unavailable", status.message ?? `${provider} OAuth is unavailable`);
  const config = configFromEnvironment(env);
  const api = createTelegramApi(config);
  const approval = createApprovalPolicy();
  const pending = new Map<string, ApprovalRequest>();
  const transport = createApprovalTransport(api, config.chatId);
  const approvalContext = { approval, transport, pending };
  const session = await runtime.startSession({ approvalPolicy: approval });
  const telegram = createTelegramRuntime(config, async (text, reply) => {
    for await (const event of session.run({ text })) await replyFor(event, reply, approvalContext);
  }, {
    api,
    mediaDirectory: tmpdir(),
    transcriber: new LocalSpeech(),
    onCallback: async (query) => {
      const result = await transport.callback(query);
      if (!result) return;
      const request = pending.get(result.hash);
      if (!request) return;
      pending.delete(result.hash);
      approval.resolve(request, result.decision);
    },
  });
  process.once("SIGINT", telegram.stop);
  try { while (true) await telegram.poller.pollOnce(); }
  finally { telegram.stop(); await session.stop("shutdown"); process.removeListener("SIGINT", telegram.stop); }
}

if (process.argv[1]?.endsWith("/src/telegram/main.ts")) {
  runTelegram().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Telegram runtime could not start: ${message}\n`);
    process.exitCode = 1;
  });
}
