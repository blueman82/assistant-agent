export type CommandResult = { command: string; argument?: string } | undefined;

export function parseCommand(text: string): CommandResult {
  const match = /^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/u.exec(text.trim());
  return match ? { command: match[1]!, ...(match[2] ? { argument: match[2].trim() } : {}) } : undefined;
}

export interface CommandContext { reset(): void; stop(): boolean; status(): string }

export function handleCommand(text: string, context: CommandContext): string | undefined {
  const command = parseCommand(text);
  if (!command) return undefined;
  if (command.command === "reset") { context.reset(); return "Session reset."; }
  if (command.command === "stop") return context.stop() ? "Stopped." : "No turn in flight.";
  if (command.command === "status") return context.status();
  return undefined;
}

