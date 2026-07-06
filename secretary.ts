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
// Graceful shutdown
// ---------------------------------------------------------------------------
function exitClean(signal: string): void {
  console.log(`\n[secretary] ${signal} — goodbye.`);
  process.exit(0);
}
process.on("SIGINT", () => exitClean("SIGINT"));
process.on("SIGTERM", () => exitClean("SIGTERM"));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODEL = process.env["SECRETARY_MODEL"] ?? "claude-sonnet-4-6";
const MAX_TURNS = parseInt(process.env["SECRETARY_MAX_TURNS"] ?? "200", 10);

const SYSTEM_PROMPT_PATH = join(__dirname, "prompts", "system.md");
if (!existsSync(SYSTEM_PROMPT_PATH)) {
  console.error(`[secretary] missing system prompt at ${SYSTEM_PROMPT_PATH}`);
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
const auditLogPath = join(homedir(), ".secretary", "send-gate-audit.jsonl");

const approvalSurfaces = [createTerminalApprovalSurface()];

const telegramConfig = loadTelegramConfig();
if (telegramConfig) {
  approvalSurfaces.push(createTelegramApprovalSurface(telegramConfig));
} else {
  console.log("[secretary] Telegram approval surface disabled (no SECRETARY_TELEGRAM_TOKEN / ~/.secretary/telegram.json) — gate remains functional via terminal/queue surfaces.");
}

approvalSurfaces.push(createQueueApprovalSurface());

const sendGateHook = createSendGateHook(approvalSurfaces, auditLogPath);

// ---------------------------------------------------------------------------
// CLI loop
// ---------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let sessionId: string | undefined;
let turnCount = 0;

console.log(`[secretary] model=${MODEL} maxTurns=${MAX_TURNS}`);
console.log(`[secretary] Type your request. Ctrl+C to exit.\n`);

async function runTurn(userInput: string): Promise<void> {
  turnCount++;

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

  const stream = query({ prompt: userInput, options });

  process.stdout.write("\n");

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
            process.stdout.write(block.text + "\n");
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const summary =
              block.name === "Bash"
                ? String(input["command"] ?? "").slice(0, 100)
                : block.name === "Read" || block.name === "Write" || block.name === "Edit"
                  ? String(input["file_path"] ?? "")
                  : JSON.stringify(block.input).slice(0, 100);
            console.log(`  [${block.name}] ${summary}`);
          }
        }
      }

      if (msg.type === "result") {
        const cost = msg.total_cost_usd != null ? ` cost=$${msg.total_cost_usd.toFixed(4)}` : "";
        console.log(`\n[secretary] done turns=${msg.num_turns}${cost}\n`);
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      // Already printed the interrupt message
    } else {
      throw err;
    }
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
    await runTurn(initialPrompt);
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
    sessionId = undefined;
    console.log("[secretary] session reset.\n");
    continue;
  }

  try {
    await runTurn(input.trim());
  } catch (err) {
    console.error(`[secretary] error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
