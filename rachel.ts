#!/usr/bin/env -S npx tsx

import { query, type SDKMessage, type ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { homedir } from "node:os";
import { createSendGateHook } from "./gate/sendGate.ts";
import { createTerminalApprovalSurface } from "./gate/surfaces/terminal.ts";
import { createTelegramApprovalSurface, loadTelegramConfig } from "./gate/surfaces/telegram.ts";
import { createQueueApprovalSurface } from "./gate/surfaces/queue.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Graceful shutdown — only registered when this file runs as the terminal
// REPL, not when imported as a module (e.g. by the Telegram bridge, which
// installs its own SIGINT/SIGTERM handlers to stop its poll loop and abort
// any in-flight turn first; these unconditional handlers would otherwise
// fire first on import and exit the process before the bridge's own
// handlers get a chance to run).
// ---------------------------------------------------------------------------
function exitClean(signal: string): void {
  console.log(`\n[Rachel] ${signal} — goodbye.`);
  process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  process.on("SIGINT", () => exitClean("SIGINT"));
  process.on("SIGTERM", () => exitClean("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODEL = process.env["RACHEL_MODEL"] ?? "claude-sonnet-4-6";
const MAX_TURNS = parseInt(process.env["RACHEL_MAX_TURNS"] ?? "200", 10);

const SYSTEM_PROMPT_PATH = join(__dirname, "prompts", "system.md");
if (!existsSync(SYSTEM_PROMPT_PATH)) {
  console.error(`[Rachel] missing system prompt at ${SYSTEM_PROMPT_PATH}`);
  process.exit(2);
}
const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------
// No MCP servers spawned — the agent uses:
// - mcp__claude_ai_Gmail__*, mcp__claude_ai_Google_Calendar__*, and mcp__claude_ai_Slack__* for personal email, calendar, and Slack
// - mcp__claude-in-chrome__* tools for general browser tasks (native Chrome extension)
// - mcp__mcp-exec__* playwright for any fallback browser tasks
const mcpServers = {};

// ---------------------------------------------------------------------------
// Send-approval gate (D1-D3) — deterministic PreToolUse enforcement,
// supplementing (not replacing) the confirm-before-send rules in system.md.
// Constructed once at module scope so approval state (the one-shot Map) and
// the audit log persist across turns within a session, not reset per-turn.
// ---------------------------------------------------------------------------
// Audit-log path override — same env-seam idiom as RACHEL_GATE_TIMEOUT_MS
// below; unset in production (falls back to the real ~/.rachel path), so
// tests can redirect audit writes away from the operator's real home
// directory.
const auditLogPath = process.env["RACHEL_AUDIT_LOG_PATH"]
  ?? join(homedir(), ".rachel", "send-gate-audit.jsonl");

const approvalSurfaces = [createTerminalApprovalSurface()];

const telegramConfig = loadTelegramConfig();
// Exported so the Telegram bridge (bridge/telegram-bridge.ts) can feed
// callback_query taps into THIS surface instance rather than constructing
// its own — the gate's raceSurfaces() call only ever sees this one.
export const telegramSurface = telegramConfig ? createTelegramApprovalSurface(telegramConfig) : undefined;
if (telegramSurface) {
  approvalSurfaces.push(telegramSurface);
} else {
  console.log("[Rachel] Telegram approval surface disabled (no RACHEL_TELEGRAM_TOKEN / ~/.rachel/telegram.json) — gate remains functional via terminal/queue surfaces.");
}

// Queue-dir override — same env-seam idiom as above; unset in production
// (falls back to createQueueApprovalSurface's own DEFAULT_QUEUE_DIR under
// ~/.claude/coderails-dashboard/approvals), so tests can redirect queue
// writes away from the operator's real dashboard queue directory rather
// than leaving stale "pending" entries the dashboard would render as
// phantom approval cards.
approvalSurfaces.push(
  process.env["RACHEL_QUEUE_DIR"]
    ? createQueueApprovalSurface(process.env["RACHEL_QUEUE_DIR"])
    : createQueueApprovalSurface(),
);

// Internal deny-timeout override — unset in production (falls back to
// createSendGateHook's own 60s default); exists so tests can exercise the
// real gate's timeout-denies-by-default path without waiting 60s.
const gateTimeoutMs = process.env["RACHEL_GATE_TIMEOUT_MS"]
  ? parseInt(process.env["SECRETARY_GATE_TIMEOUT_MS"], 10)
  : undefined;
const sendGateHook = gateTimeoutMs !== undefined
  ? createSendGateHook(approvalSurfaces, auditLogPath, new Map(), gateTimeoutMs)
  : createSendGateHook(approvalSurfaces, auditLogPath);

// ---------------------------------------------------------------------------
// Session state — module-scoped so it persists across turns within a
// process, for both the terminal REPL and the Telegram bridge (which calls
// runTurn directly rather than going through the REPL below).
// ---------------------------------------------------------------------------
let sessionId: string | undefined;
let turnCount = 0;

export function getSessionId(): string | undefined {
  return sessionId;
}

export function resetSession(): void {
  sessionId = undefined;
}

// Emits one piece of turn output to the caller — assistant text, a tool-use
// summary line, or a final status line. The terminal REPL below writes these
// straight to stdout; the Telegram bridge instead buffers them for a
// chunked reply.
export type TurnEmit = (line: string) => void;

// Runs one turn of the Rachel agent loop against `userInput`, invoking
// `emit` for each line of output as it streams in. `signal` aborts the SDK
// query when triggered (wired to an AbortController the caller owns — e.g.
// a terminal 'q' keypress or a Telegram /stop command). Session continuity
// (resume) is tracked via the module-scoped sessionId above and updated as
// the SDK's init message reports it. `queryFn` defaults to the real SDK
// query() — injectable (matching the repo's transport/surface idiom) so
// tests can exercise the real PreToolUse hook wiring above without hitting
// the network.
export async function runTurn(
  userInput: string,
  emit: TurnEmit,
  signal: AbortSignal,
  queryFn: typeof query = query,
): Promise<void> {
  turnCount++;

  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const options: Parameters<typeof query>[0]["options"] = {
    model: MODEL,
    maxTurns: MAX_TURNS,
    permissionMode: "auto",
    allowedTools: [
      "Read", "Write", "Edit", "Glob", "Grep", "Bash",
      "WebSearch", "WebFetch",
      "ToolSearch", "Skill",
      "mcp__mcp-exec__execute_code_with_wrappers",
      "mcp__mcp-exec__list_available_mcp_servers",
      "mcp__mcp-exec__get_mcp_tool_schema",
      "mcp__claude-in-chrome__*",
      "mcp__claude_ai_Gmail__*",
      "mcp__claude_ai_Google_Calendar__*",
      "mcp__claude_ai_Slack__*",
    ],
    mcpServers,
    extraArgs: { "chrome": null },
    abortController,
    hooks: {
      PreToolUse: [
        {
          // Left permissive rather than omitted: sdk.d.ts does not document
          // undefined-matches-all semantics for HookCallbackMatcher.matcher,
          // so this is set defensively to match every tool call. The gate
          // itself filters by tool_name/command internally.
          matcher: ".*",
          hooks: [sendGateHook],
        },
      ],
    },
    agent: "secretary",
    agents: {
      secretary: {
        description: "Gary's AI secretary — email, calendar, and tasks.",
        prompt: systemPrompt,
        skills: [],
      },
    },
    ...(sessionId ? { resume: sessionId } : {}),
  };

  const stream = queryFn({ prompt: userInput, options });

  try {
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && (msg as Record<string, unknown>)["subtype"] === "init") {
        const raw = msg as Record<string, unknown>;
        if (typeof raw["session_id"] === "string") {
          sessionId = raw["session_id"];
        }
      }

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            emit(block.text);
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const summary =
              block.name === "Bash"
                ? String(input["command"] ?? "").slice(0, 100)
                : block.name === "Read" || block.name === "Write" || block.name === "Edit"
                  ? String(input["file_path"] ?? "")
                  : JSON.stringify(block.input).slice(0, 100);
            emit(`  [${block.name}] ${summary}`);
          }
        }
      }

      if (msg.type === "result") {
        const cost = msg.total_cost_usd != null ? ` cost=$${msg.total_cost_usd.toFixed(4)}` : "";
        emit(`[secretary] done turns=${msg.num_turns}${cost}`);
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      // Caller already surfaced the interrupt.
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal REPL — guarded so importing this module (e.g. from the Telegram
// bridge, which calls runTurn directly) never starts the CLI loop.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`[secretary] model=${MODEL} maxTurns=${MAX_TURNS}`);
  console.log(`[secretary] Type your request. Ctrl+C to exit.\n`);

  async function runTerminalTurn(userInput: string): Promise<void> {
    const abortController = new AbortController();

    // Listen for 'q' keypress to abort the current turn
    const rawMode = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    const onKeypress = (data: Buffer): void => {
      const ch = data.toString();
      if (ch === "q" || ch === "Q") {
        abortController.abort();
        console.log("\n[secretary] interrupted.\n");
      }
    };
    process.stdin.on("data", onKeypress);

    process.stdout.write("\n");
    try {
      await runTurn(userInput, (line) => process.stdout.write(line + "\n"), abortController.signal);
    } finally {
      process.stdin.removeListener("data", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(rawMode ?? false);
      }
    }
  }

  // Handle initial prompt from CLI args: secretary "check my email"
  const initialPrompt = process.argv.slice(2).join(" ").trim();

  if (initialPrompt) {
    try {
      await runTerminalTurn(initialPrompt);
    } catch (err) {
      console.error(`[secretary] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Interactive loop — keeps running after initial prompt
  while (true) {
    const input = await rl.question("You: ").catch(() => null);
    if (input === null || input.toLowerCase() === "/exit" || input.toLowerCase() === "/quit") {
      exitClean("exit");
      break;
    }
    if (!input.trim()) continue;

    // Reset session
    if (input.trim() === "/reset") {
      resetSession();
      console.log("[secretary] session reset.\n");
      continue;
    }

    try {
      await runTerminalTurn(input.trim());
    } catch (err) {
      console.error(`[secretary] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Only run the REPL when this file is executed directly (tsx secretary.ts),
// not when imported as a module (e.g. by the Telegram bridge).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
