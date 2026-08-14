import type { RuntimeState } from "./types.ts";

export class RuntimeLiveness {
  private readonly states = new Map<string, RuntimeState>();

  observe(name: string, at: number): RuntimeState {
    if (!name || !Number.isFinite(at)) throw new Error("runtime name and finite timestamp are required");
    const state: RuntimeState = { name, lastSeenAt: at, healthy: true };
    this.states.set(name, state);
    return state;
  }

  check(name: string, now: number, timeoutMs: number): RuntimeState {
    const previous = this.states.get(name);
    const healthy = previous !== undefined && now - previous.lastSeenAt <= timeoutMs;
    const state: RuntimeState = { name, lastSeenAt: previous?.lastSeenAt ?? 0, healthy };
    this.states.set(name, state);
    return state;
  }

  get(name: string): RuntimeState | undefined {
    return this.states.get(name);
  }
}
