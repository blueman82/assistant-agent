import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditRow {
  ts: string;
  event: "attempt" | "decision";
  toolName: string;
  hash: string;
  surface: string;
  decision?: "allow" | "deny";
  errorCode?: string;
  errorMessage?: string;
}

// Append-only: never rewrites, one JSON object per line.
export function appendAuditRow(auditLogPath: string, row: AuditRow): void {
  mkdirSync(dirname(auditLogPath), { recursive: true });
  appendFileSync(auditLogPath, JSON.stringify(row) + "\n");
}
