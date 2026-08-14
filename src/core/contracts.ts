export type SessionId = string;
export type TurnId = string;
export type CheckpointId = string;
export type ToolName = string;

export type StopReason = "deadline" | "user" | "shutdown" | "reset";
export type AbortReason = "deadline" | "stop" | "shutdown";
export type SessionStatus = "active" | "tainted";

export interface AgentInput {
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

export interface Attachment {
  readonly kind: "image" | "audio" | "document";
  readonly path: string;
  readonly mimeType?: string;
  readonly fileName?: string;
}

export interface CapabilitySet {
  readonly streaming?: boolean;
  readonly toolUse?: boolean;
  readonly approvals?: boolean;
  readonly attachments?: readonly Attachment["kind"][];
}

export type Capability = keyof CapabilitySet;

export interface SessionOptions {
  readonly capabilities?: CapabilitySet;
  readonly timeoutMs?: number;
  readonly sessionPolicy?: SessionPolicy;
  readonly approvalPolicy?: ApprovalPolicy;
}

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type TurnEvent =
  | { readonly type: "started"; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: "text"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly text: string }
  | { readonly type: "tool_call"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly request: ToolRequest }
  | { readonly type: "approval_required"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly request: ApprovalRequest }
  | { readonly type: "usage"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly usage: Usage }
  | { readonly type: "completed"; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: "stopped"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly reason: StopReason }
  | { readonly type: "error"; readonly sessionId: SessionId; readonly turnId: TurnId; readonly error: AgentError };

export interface AgentSession {
  readonly id: SessionId;
  run(input: AgentInput): AsyncIterable<TurnEvent>;
  reset(): Promise<void>;
  stop(reason?: StopReason): Promise<boolean>;
}

export interface AgentRuntime {
  startSession(options?: SessionOptions): Promise<AgentSession>;
}

export interface SessionPolicy {
  snapshot(): Session | undefined;
  start(sessionId: SessionId): Session;
  checkpoint(checkpointId: CheckpointId): Session;
  taint(reason: AbortReason): Session;
  recover(sessionId: SessionId, checkpointId?: CheckpointId): Session;
  owns(sessionId: SessionId): boolean;
}

export type Session =
  | { readonly sessionId: SessionId; readonly status: "active"; readonly checkpointId?: CheckpointId }
  | { readonly sessionId: SessionId; readonly status: "tainted"; readonly checkpointId?: CheckpointId; readonly abortReason: AbortReason };

export interface SessionStore {
  load(): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

export interface ToolRequest {
  readonly toolName: ToolName;
  readonly input: unknown;
}

export interface ApprovalRequest extends ToolRequest {
  readonly requestId: string;
}

export type ApprovalResolution = "approve" | "deny";

export interface ApprovalDecision {
  readonly decision: ApprovalResolution;
  readonly reason: string;
}

export interface ApprovalCoordinator {
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
  resolve(request: ApprovalRequest, resolution: ApprovalResolution): ApprovalDecision;
}

export interface ApprovalPolicy extends ApprovalCoordinator {
  hash(request: ToolRequest): string;
  begin(request: ApprovalRequest): ApprovalDecision;
}
