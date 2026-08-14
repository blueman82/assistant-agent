import type { AgentSession } from "../core/contracts.ts";

export async function resetCliSession(
  session: Pick<AgentSession, "reset">,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  await session.reset();
  write("Session reset.\n");
}

export async function stopCliSession(
  session: Pick<AgentSession, "stop">,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  write(await session.stop("user") ? "Stopped.\n" : "No active turn.\n");
}
