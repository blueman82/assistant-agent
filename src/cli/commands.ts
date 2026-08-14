import type { AgentSession } from "../core/contracts.ts";

export interface CliMemoryService {
  remember(text: string): Promise<void>;
  forget(query: string): Promise<void>;
  resetConversation(): Promise<void>;
}

export function parseCliCommand(text: string): { command: string; argument?: string } | undefined {
  const match = /^\/(\w+)(?:\s+(.+))?$/u.exec(text.trim());
  return match ? { command: match[1]!, ...(match[2] ? { argument: match[2].trim() } : {}) } : undefined;
}

export async function resetCliSession(
  session: Pick<AgentSession, "reset">,
  write: (text: string) => void = (text) => process.stdout.write(text),
  memory?: Pick<CliMemoryService, "resetConversation">,
): Promise<void> {
  await session.reset();
  await memory?.resetConversation();
  write("Session reset.\n");
}

export async function handleCliMemoryCommand(
  text: string,
  memory: CliMemoryService,
  write: (text: string) => void = (value) => process.stdout.write(value),
): Promise<boolean> {
  const command = parseCliCommand(text);
  if (!command || !["remember", "forget"].includes(command.command)) return false;
  if (!command.argument) {
    write(`Usage: /${command.command} <text>\n`);
    return true;
  }
  if (command.command === "remember") await memory.remember(command.argument);
  else await memory.forget(command.argument);
  write(command.command === "remember" ? "Remembered.\n" : "Forgotten.\n");
  return true;
}

export async function stopCliSession(
  session: Pick<AgentSession, "stop">,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  write(await session.stop("user") ? "Stopped.\n" : "No active turn.\n");
}
