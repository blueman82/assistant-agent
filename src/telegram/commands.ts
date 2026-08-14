export type CommandResult = { command: string; argument?: string } | undefined;

export interface TelegramMemoryService {
  remember(text: string): Promise<void>;
  forget(query: string): Promise<void>;
  resetConversation(): Promise<void>;
}

export function parseCommand(text: string): CommandResult {
  const match = /^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/u.exec(text.trim());
  return match ? { command: match[1]!, ...(match[2] ? { argument: match[2].trim() } : {}) } : undefined;
}

export interface CommandContext {
  reset(): void | Promise<void>;
  stop(): boolean;
  status(): string;
  memory?: TelegramMemoryService;
}

export async function handleCommand(text: string, context: CommandContext): Promise<string | undefined> {
  const command = parseCommand(text);
  if (!command) return undefined;
  if (command.command === "reset") {
    await context.reset();
    await context.memory?.resetConversation();
    return "Session reset.";
  }
  if (command.command === "stop") return context.stop() ? "Stopped." : "No turn in flight.";
  if (command.command === "status") return context.status();
  if (command.command === "remember" || command.command === "forget") {
    if (!command.argument) return `Usage: /${command.command} <text>`;
    if (!context.memory) return "Memory commands aren't available right now.";
    if (command.command === "remember") await context.memory.remember(command.argument);
    else await context.memory.forget(command.argument);
    return command.command === "remember" ? "Remembered." : "Forgotten.";
  }
  return undefined;
}
