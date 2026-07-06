// Shared types for the send-approval gate (D1-D3, spec.md).

export interface GateDecision {
  decision: "allow" | "deny";
  reason: string;
}

export interface PendingApproval {
  hash: string; // sha256 of canonicalised tool_input
  toolName: string;
  toolInput: unknown;
  createdAt: number; // epoch ms
  consumed: boolean;
}

export interface ApprovalSurface {
  // Presents the pending approval to the owner and resolves with their
  // decision. Must resolve within the caller's timeout budget or the caller
  // treats a still-pending promise as a timeout (deny).
  requestApproval(toolName: string, toolInput: unknown, hash: string): Promise<"approve" | "deny">;
}
