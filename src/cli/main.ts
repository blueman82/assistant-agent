import { createInterface } from "node:readline";
import { AgentError, type TurnEvent } from "../core/contracts.ts";
import { providerFromEnvironment, type ProviderName } from "../providers/selection.ts";
import { createProviderRuntime } from "../providers/runtime.ts";
import { handleCliMemoryCommand, resetCliSession, stopCliSession, type CliMemoryService } from "./commands.ts";

interface CliInput {
  on(event: "line", listener: (line: string) => void): CliInput;
  on(event: "close", listener: () => void): CliInput;
}

export interface CliRunOptions { memory?: CliMemoryService }

function printEvent(event: TurnEvent): void {
  if (event.type === "text") process.stdout.write(`${event.text}\n`);
  if (event.type === "tool_call") process.stdout.write(`[tool: ${event.request.toolName}]\n`);
  if (event.type === "error") process.stderr.write(`Error: ${event.error.message}\n`);
}

export async function runCliInput(
  input: CliInput,
  session: Parameters<typeof stopCliSession>[0] & { run(input: { text: string }): AsyncIterable<TurnEvent>; reset(): Promise<void> },
  print: (event: TurnEvent) => void = printEvent,
  write: (text: string) => void = (text) => process.stdout.write(text),
  memory?: CliMemoryService,
): Promise<void> {
  const pending: string[] = [];
  let active: { cancelled: boolean } | undefined;
  let closed = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const drain = async (): Promise<void> => {
    if (active) return;
    const text = pending.shift();
    if (text === undefined) { if (closed) finish(); return; }
    const turn = { cancelled: false };
    active = turn;
    try {
      if (text === "/reset") await resetCliSession(session, write, memory);
      else if (memory && await handleCliMemoryCommand(text, memory, write)) return;
      else for await (const event of session.run({ text })) if (!turn.cancelled) print(event);
    } finally {
      if (active === turn) { active = undefined; void drain(); }
    }
  };

  input.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/stop") {
      if (active) active.cancelled = true;
      void stopCliSession(session, write);
      return;
    }
    pending.push(text);
    void drain();
  });
  input.on("close", () => { closed = true; void drain(); });
  await done;
}

export function providerFromCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ProviderName {
  const [provider] = args;
  return providerFromEnvironment(provider ? { ...env, RACHEL_PROVIDER: provider } : env);
}

export async function runCli(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<void> {
  const provider = providerFromCli(args, env);
  const runtime = createProviderRuntime(provider);
  const status = await runtime.checkAvailability();
  if (!status.authenticated) throw new AgentError("authentication_unavailable", status.message ?? `${provider} OAuth is unavailable`);
  const session = await runtime.startSession();
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stop = () => void session.stop("shutdown");
  process.once("SIGINT", stop);
  process.stdout.write(`Rachel (${provider}) ready.\n`);
  try {
    await runCliInput(input, session, printEvent, (text) => process.stdout.write(text), options.memory);
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
