import { createInterface } from "node:readline";
import { AgentError, type TurnEvent } from "../core/contracts.ts";
import { providerFromEnvironment } from "../providers/selection.ts";
import { createProviderRuntime } from "../providers/runtime.ts";
import { resetCliSession } from "./commands.ts";

function printEvent(event: TurnEvent): void {
  if (event.type === "text") process.stdout.write(`${event.text}\n`);
  if (event.type === "tool_call") process.stdout.write(`[tool: ${event.request.toolName}]\n`);
  if (event.type === "error") process.stderr.write(`Error: ${event.error.message}\n`);
}

export async function runCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = providerFromEnvironment(env);
  const runtime = createProviderRuntime(provider);
  const status = await runtime.checkAvailability();
  if (!status.authenticated) throw new AgentError("authentication_unavailable", status.message ?? `${provider} OAuth is unavailable`);
  const session = await runtime.startSession();
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stop = () => void session.stop("shutdown");
  process.once("SIGINT", stop);
  process.stdout.write(`Rachel (${provider}) ready.\n`);
  try {
    for await (const line of input) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/reset") { await resetCliSession(session); continue; }
      if (text === "/stop") { await session.stop("user"); continue; }
      for await (const event of session.run({ text })) printEvent(event);
    }
  } finally {
    input.close();
    process.removeListener("SIGINT", stop);
    await session.stop("shutdown");
  }
}

if (process.argv[1]?.endsWith("/src/cli/main.ts")) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Rachel could not start: ${message}\n`);
    process.exitCode = 1;
  });
}
