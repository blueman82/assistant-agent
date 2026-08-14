import type { AgentInput } from "../core/contracts.ts";

export interface NormalizedConversationTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt?: string;
}

export interface RetrievedMemory {
  readonly text: string;
  readonly source?: string;
  readonly updatedAt?: string;
}

export interface ProviderContext {
  readonly conversation?: readonly NormalizedConversationTurn[];
  readonly memories?: readonly RetrievedMemory[];
}

export type ProviderInput = AgentInput & { readonly context?: ProviderContext };

export function providerPrompt(input: ProviderInput): string {
  const context = input.context;
  const sections: string[] = [];
  if (context?.memories?.length) {
    sections.push("Relevant durable memories:\n" + context.memories.map((memory) => `- ${memory.text}`).join("\n"));
  }
  if (context?.conversation?.length) {
    sections.push("Recent conversation:\n" + context.conversation.map((turn) => `${turn.role}: ${turn.text}`).join("\n"));
  }
  return sections.length ? `${sections.join("\n\n")}\n\nuser: ${input.text}` : input.text;
}
