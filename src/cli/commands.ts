import type { AgentSession } from "../core/contracts.ts";

export async function resetCliSession(
  session: Pick<AgentSession, "reset">,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  await session.reset();
  write("Session reset.\n");
}
