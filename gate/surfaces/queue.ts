import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ApprovalSurface } from "../types.ts";

// The file written per pending approval — frozen seam shape consumed by the
// dashboard (sub-project 2/WU4). Field names are exact and must not drift.
export interface QueueFileEntry {
  hash: string;
  toolName: string;
  toolInput: unknown;
  createdAt: number; // epoch ms
  status: "pending" | "approved" | "denied";
}

export const DEFAULT_QUEUE_DIR = join(homedir(), ".claude", "coderails-dashboard", "approvals");

export function writeQueueEntry(queueDir: string, entry: QueueFileEntry): void {
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, `${entry.hash}.json`), JSON.stringify(entry, null, 2));
}

const DEFAULT_POLL_INTERVAL_MS = 500;

// Writes a pending entry then polls the same file for an externally-written
// status change (by a future dashboard Approve/Deny button — not built here,
// per D3/plan.md Task 4 step 5). Never resolves on its own if the file is
// never updated; the gate's own internal timeout is what bounds this.
export function createQueueApprovalSurface(
  queueDir: string = DEFAULT_QUEUE_DIR,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): ApprovalSurface {
  return {
    async requestApproval(toolName, toolInput, hash) {
      writeQueueEntry(queueDir, {
        hash,
        toolName,
        toolInput,
        createdAt: Date.now(),
        status: "pending",
      });

      const path = join(queueDir, `${hash}.json`);
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          // A throw here (e.g. a poll landing mid-write on a non-atomic
          // external writer, or a transient fs error) would otherwise be an
          // uncaught exception inside a setInterval callback — fatal to the
          // process in Node, not a promise rejection raceSurfaces could catch.
          // Treat any read/parse failure as "not yet decided" and keep
          // polling; the gate's own internal timeout still bounds this.
          try {
            if (!existsSync(path)) return;
            const entry = JSON.parse(readFileSync(path, "utf8")) as QueueFileEntry;
            if (entry.status === "approved") {
              clearInterval(interval);
              resolve("approve");
            } else if (entry.status === "denied") {
              clearInterval(interval);
              resolve("deny");
            }
          } catch {
            // Keep polling — see comment above.
          }
        }, pollIntervalMs);
        // This surface can lose the raceSurfaces() race (e.g. the gate's own
        // internal timeout, or another surface, resolves first) with no way
        // for the caller to cancel it — ApprovalSurface has no cancellation
        // signal. unref() so a losing poll loop never keeps the process from
        // exiting; it just polls harmlessly in the background until the file
        // is eventually written or the process exits on its own.
        interval.unref();
      });
    },
  };
}
