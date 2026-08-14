import type { WatchTarget } from "./types.ts";

export interface ProcessProbe {
  isAlive(pid: number): boolean;
}

export interface WatchdogResult {
  readonly name: string;
  readonly alive: boolean;
  readonly responsive: boolean;
}

export function checkWatchdog(target: WatchTarget, now: number, probe: ProcessProbe): WatchdogResult {
  const alive = target.pid === undefined || probe.isAlive(target.pid);
  const responsive = target.lastProgressAt === undefined || now - target.lastProgressAt <= target.timeoutMs;
  return { name: target.name, alive, responsive };
}

export function isWatchdogFailure(result: WatchdogResult): boolean {
  return !result.alive || !result.responsive;
}
