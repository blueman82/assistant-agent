import type { SessionPolicy, Session, AbortReason, CheckpointId, SessionId } from "./contracts.ts";

export type { SessionPolicy } from "./contracts.ts";

export function createSessionPolicy(initial?: Session): SessionPolicy {
  let current = initial;

  return {
    snapshot: () => current,
    owns: (sessionId) => current?.sessionId === sessionId && current.status === "active",
    start(sessionId) {
      if (current?.status === "active") throw new Error("session already active");
      return (current = { sessionId, status: "active" });
    },
    checkpoint(checkpointId) {
      if (!current || current.status !== "active") throw new Error("cannot checkpoint an inactive session");
      return (current = { ...current, checkpointId });
    },
    taint(reason) {
      if (!current) throw new Error("cannot taint an absent session");
      if (current.status === "tainted") return current;
      return (current = { ...current, status: "tainted", abortReason: reason });
    },
    recover(sessionId, checkpointId) {
      return (current = checkpointId === undefined
        ? { sessionId, status: "active" }
        : { sessionId, status: "active", checkpointId });
    },
  };
}
