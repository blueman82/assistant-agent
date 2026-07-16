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
import { resolveAllowedTools } from "./proactive/allowedTools.ts";
import { getModel, getEffort, handleConfigCommand, isHelpFlag, renderHelp, parseArgvConfig } from "./proactive/modelConfig.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The agent's full tool surface. Narrowable per invocation via the
// RACHEL_ALLOWED_TOOLS env seam (resolveAllowedTools) — headless one-shots
// run with a minimum subset; the env var can only remove entries from this
// list, never add to it. Exported for the cross-check test that pins every
// one-shot narrowing set as a subset of this list.
export const DEFAULT_ALLOWED_TOOLS = [
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
] as const;

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
// Model + effort are no longer boot-time consts — proactive/modelConfig.ts
// owns the current values (defaulted from RACHEL_MODEL at import) so a
// /model or /effort command can change them mid-session; runTurn and the
// startup banner below read the getters, not a captured value.
const DEFAULT_MAX_TURNS = 200;
const MAX_TURNS = parseInt(process.env["RACHEL_MAX_TURNS"] ?? String(DEFAULT_MAX_TURNS), 10);

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
  ? parseInt(process.env["RACHEL_GATE_TIMEOUT_MS"], 10)
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

// Kind of a single emitted line — lets callers (the Telegram bridge, in
// particular) distinguish the model's own reply text from tool-use echoes
// and the turn's completion footer, without pattern-matching on content.
export type TurnEmitKind = "text" | "tool" | "meta";

// Emits one piece of turn output to the caller — assistant text, a tool-use
// summary line, or a final status line — tagged with its kind. The terminal
// REPL below writes every kind straight to stdout; the Telegram bridge
// instead buffers only "text" lines for a chunked reply.
export type TurnEmit = (line: string, kind: TurnEmitKind) => void;

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
    model: getModel(),
    effort: getEffort(),
    maxTurns: MAX_TURNS,
    permissionMode: "auto",
    // Env read here, per call, not at module load — launchd/spawn
    // environments differ per invocation.
    allowedTools: resolveAllowedTools(DEFAULT_ALLOWED_TOOLS, process.env["RACHEL_ALLOWED_TOOLS"]),
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
    agent: "rachel",
    agents: {
      rachel: {
        description: "Gary's AI assistant Rachel — email, calendar, and tasks.",
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
            emit(block.text, "text");
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const summary =
              block.name === "Bash"
                ? String(input["command"] ?? "")
                : block.name === "Read" || block.name === "Write" || block.name === "Edit"
                  ? String(input["file_path"] ?? "")
                  : JSON.stringify(block.input);
            emit(`  [${block.name}] ${summary}`, "tool");
          }
        }
      }

      if (msg.type === "result") {
        const cost = msg.total_cost_usd != null ? ` cost=$${msg.total_cost_usd.toFixed(4)}` : "";
        emit(`[Rachel] done turns=${msg.num_turns}${cost}`, "meta");
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
  // --help/-h: print and exit BEFORE the initialPrompt join below, so the
  // literal flag is never sent to the agent as a prompt (that would burn a
  // real API turn on Rachel guessing what "--help" means).
  if (isHelpFlag(process.argv.slice(2))) {
    // Pass the STATIC default, not MAX_TURNS (the effective value) — a
    // RACHEL_MAX_TURNS override must not make the help page claim the
    // override is the default.
    console.log(renderHelp(DEFAULT_MAX_TURNS));
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // /model and /effort commands passed as argv (rachel /model opus /effort
  // xhigh) must apply as config, not be joined into the prompt and sent to
  // the agent — parseArgvConfig (proactive/modelConfig.ts) walks argv,
  // applies every config command it finds via the same handleConfigCommand
  // the REPL uses below, and returns whatever's left as the one-shot prompt.
  // This runs BEFORE the banner below so `rachel /model opus` reports the
  // switched model, not the pre-switch default.
  const { configReplies, remainingPrompt: initialPrompt } = parseArgvConfig(process.argv.slice(2));

  console.log(`[Rachel] model=${getModel()} maxTurns=${MAX_TURNS}`);
  console.log(`[Rachel] Type your request. Ctrl+C to exit.\n`);

  for (const reply of configReplies) {
    console.log(`[Rachel] ${reply}\n`);
  }

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
        console.log("\n[Rachel] interrupted.\n");
      }
    };
    process.stdin.on("data", onKeypress);

    process.stdout.write("\n");
    try {
      await runTurn(userInput, (line, _kind) => process.stdout.write(line + "\n"), abortController.signal);
    } finally {
      process.stdin.removeListener("data", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(rawMode ?? false);
      }
    }
  }

  // Handle initial prompt from CLI args: rachel "check my email"
  // (initialPrompt/configReplies were already computed above, before the
  // banner, so the banner reflects any /model or /effort switch.)
  if (initialPrompt) {
    try {
      await runTerminalTurn(initialPrompt);
    } catch (err) {
      console.error(`[Rachel] error: ${err instanceof Error ? err.message : String(err)}`);
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
      console.log("[Rachel] session reset.\n");
      continue;
    }

    // /model and /effort dispatch through the shared, surface-agnostic
    // handleConfigCommand (proactive/modelConfig.ts) — it owns parsing and
    // state, and returns undefined for anything else so control falls
    // through to the turn below.
    const configReply = handleConfigCommand(input);
    if (configReply !== undefined) {
      console.log(`[Rachel] ${configReply}\n`);
      continue;
    }

    try {
      await runTerminalTurn(input.trim());
    } catch (err) {
      console.error(`[Rachel] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Only run the REPL when this file is executed directly (tsx rachel.ts),
// not when imported as a module (e.g. by the Telegram bridge).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
