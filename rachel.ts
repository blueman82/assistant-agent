#!/usr/bin/env -S npx tsx

import {
  forkSession,
  getSessionMessages,
  query,
  type HookCallback,
  type SDKMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { homedir } from "node:os";
import { createSendGateHook } from "./gate/sendGate.ts";
import { createAskUserQuestionHook } from "./gate/askUserQuestionHook.ts";
import { createMemoryGateHook } from "./gate/memoryGate.ts";
import { createTerminalApprovalSurface } from "./gate/surfaces/terminal.ts";
import { createTelegramApprovalSurface, loadTelegramConfig } from "./gate/surfaces/telegram.ts";
import { createQueueApprovalSurface } from "./gate/surfaces/queue.ts";
import { resolveAllowedTools } from "./proactive/allowedTools.ts";
import { resolveSystemPromptPath } from "./proactive/systemPrompt.ts";
import { getModel, getEffort, handleConfigCommand, isHelpFlag, renderHelp, parseArgvConfig } from "./proactive/modelConfig.ts";
import { composeSystemPrompt, resolveMemoryPath } from "./proactive/memoryIndex.ts";
import {
  readSession,
  writeSession,
  clearSession,
  type PersistedSession,
  type SessionAbortReason,
} from "./proactive/sessionPersist.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The agent's auto-approval list, not its tool surface — entries here skip
// the permission prompt. It does NOT restrict which tools Rachel can reach:
// the SDK's `tools` option (the actual availability control) is never set
// below, so no `--tools` flag reaches the underlying `claude` process and it
// runs with its full default toolset regardless of what's listed here.
// Narrowable per invocation via the RACHEL_ALLOWED_TOOLS env seam
// (resolveAllowedTools) — headless one-shots run with a minimum subset; the
// env var can only remove entries from this list, never add to it. Exported
// for the cross-check test that pins every one-shot narrowing set as a
// subset of this list.
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
// The SDK default is effectively unbounded, so one wedged MCP call can
// otherwise consume the bridge's entire ten-minute emergency turn budget.
// Read per turn and preserve an explicit operator override.
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 70;

// Generic tracked prompt vs the operator's own local override — resolution
// order and rationale live in proactive/systemPrompt.ts.
const SYSTEM_PROMPT_PATH = resolveSystemPromptPath(__dirname);
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

const askUserQuestionHook = createAskUserQuestionHook();
const memoryGateHook = createMemoryGateHook(auditLogPath);

// Redacted lifecycle telemetry: tool name/id/status/duration only. Inputs,
// outputs, and raw failure strings may contain private mail, messages, or
// document content and are deliberately never logged.
const toolStartTelemetryHook: HookCallback = async (input, toolUseId) => {
  if (input.hook_event_name === "PreToolUse") {
    console.error(`[${new Date().toISOString()}] [Rachel] tool started name=${input.tool_name} id=${toolUseId ?? input.tool_use_id}`);
  }
  return {};
};
const toolSuccessTelemetryHook: HookCallback = async (input, toolUseId) => {
  if (input.hook_event_name === "PostToolUse") {
    console.error(`[${new Date().toISOString()}] [Rachel] tool completed name=${input.tool_name} id=${toolUseId ?? input.tool_use_id} duration_ms=${input.duration_ms ?? "unknown"}`);
  }
  return {};
};
const toolFailureTelemetryHook: HookCallback = async (input, toolUseId) => {
  if (input.hook_event_name === "PostToolUseFailure") {
    console.error(`[${new Date().toISOString()}] [Rachel] tool failed name=${input.tool_name} id=${toolUseId ?? input.tool_use_id} duration_ms=${input.duration_ms ?? "unknown"}`);
  }
  return {};
};

// ---------------------------------------------------------------------------
// Session state — module-scoped so it persists across turns within a
// process, for both the terminal REPL and the Telegram bridge (which calls
// runTurn directly rather than going through the REPL below).
//
// RACHEL_SESSION_FILE — bridge-only persistence seam. A launchd bridge
// restart otherwise wipes the Telegram thread mid-conversation, because
// sessionId below is module-scoped and never survives a process restart.
// Read per-call (matching resolveAllowedTools's process.env[...] idiom, not
// a module-load default) and used as a GATE, not a path-with-fallback: unset
// means this seam is never touched, so the CLI and all 8 headless one-shots
// stay byte-for-byte identical to today. It must be set ONLY in the
// bridge's plist (bridge/launchd.plist) — exactly one writer, so the
// concurrent-resume hazard documented there never arises.
// ---------------------------------------------------------------------------
let sessionId: string | undefined;
let lastCompletedAssistantMessageId: string | undefined;
// Ownership epoch for async SDK streams. resetSession() rotates the epoch so
// an abandoned pre-reset turn cannot later emit system/init and resurrect its
// stale session in memory or in the bridge persistence file.
let sessionGeneration = 0;
let turnCount = 0;

export function getSessionId(): string | undefined {
  return sessionId;
}

export type TurnOutcome =
  | { status: "completed" }
  | { status: "aborted"; reason: SessionAbortReason; recovery: "forked" | "fresh" | "superseded" };

export interface SessionRecoveryDeps {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string; dir: string },
  ): Promise<{ sessionId: string }>;
  getSessionMessages(
    sessionId: string,
    options: { dir: string },
  ): Promise<SessionMessage[]>;
}

const realSessionRecoveryDeps: SessionRecoveryDeps = { forkSession, getSessionMessages };

function persistSession(state: PersistedSession): void {
  const path = process.env["RACHEL_SESSION_FILE"];
  if (path) writeSession(path, state);
}

function startFreshIfOwned(ownedGeneration: number, reason: string): "fresh" | "superseded" {
  if (sessionGeneration !== ownedGeneration) return "superseded";
  sessionGeneration++;
  sessionId = undefined;
  lastCompletedAssistantMessageId = undefined;
  const path = process.env["RACHEL_SESSION_FILE"];
  if (path) clearSession(path);
  console.error(`[Rachel] ${reason} — starting a fresh session; the source transcript was retained for audit.`);
  return "fresh";
}

async function recoverSessionFromCheckpoint(
  sourceSessionId: string | undefined,
  sourceCheckpointId: string | undefined,
  ownedGeneration: number,
  deps: SessionRecoveryDeps,
): Promise<"forked" | "fresh" | "superseded"> {
  if (sessionGeneration !== ownedGeneration) return "superseded";
  if (!sourceSessionId || !sourceCheckpointId) {
    return startFreshIfOwned(ownedGeneration, "Cannot recover the interrupted turn because no clean checkpoint exists");
  }

  try {
    const forked = await deps.forkSession(sourceSessionId, {
      upToMessageId: sourceCheckpointId,
      dir: process.cwd(),
    });
    // /reset may have won while forkSession was copying the transcript. Keep
    // the now-superseded fork for audit, but never let it reclaim ownership.
    if (sessionGeneration !== ownedGeneration) return "superseded";

    const messages = await deps.getSessionMessages(forked.sessionId, { dir: process.cwd() });
    if (sessionGeneration !== ownedGeneration) return "superseded";
    const remappedCheckpoint = [...messages].reverse().find((message: SessionMessage) => message.type === "assistant")?.uuid;
    if (!remappedCheckpoint) throw new Error("fork contains no remapped assistant checkpoint");

    sessionId = forked.sessionId;
    lastCompletedAssistantMessageId = remappedCheckpoint;
    persistSession({
      sessionId,
      lastCompletedAssistantMessageId,
      state: "active",
    });
    return "forked";
  } catch (err) {
    return startFreshIfOwned(
      ownedGeneration,
      `Checkpoint fork failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// Reads the persisted session (if the seam is set and a file exists) into
// module state. Called explicitly by the bridge's CLI guard on startup —
// never at module load — so importing this module (e.g. from tests, or
// from the Telegram bridge before it's ready) never has this side effect.
export async function hydratePersistedSession(
  deps: SessionRecoveryDeps = realSessionRecoveryDeps,
): Promise<"none" | "active" | "forked" | "fresh" | "superseded"> {
  const path = process.env["RACHEL_SESSION_FILE"];
  if (!path) return "none";
  const persisted = readSession(path);
  if (!persisted) {
    sessionId = undefined;
    lastCompletedAssistantMessageId = undefined;
    return "none";
  }
  sessionId = persisted.sessionId;
  lastCompletedAssistantMessageId = persisted.lastCompletedAssistantMessageId;
  if (persisted.state === "active") return "active";

  // Rotate immediately so a stale init from work that survived the previous
  // process generation cannot race the recovered pointer in this process.
  const recoveryGeneration = ++sessionGeneration;
  return recoverSessionFromCheckpoint(sessionId, lastCompletedAssistantMessageId, recoveryGeneration, deps);
}

export function resetSession(): void {
  sessionGeneration++;
  sessionId = undefined;
  lastCompletedAssistantMessageId = undefined;
  const path = process.env["RACHEL_SESSION_FILE"];
  if (path) {
    clearSession(path);
  }
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
  recoveryDeps: SessionRecoveryDeps = realSessionRecoveryDeps,
): Promise<TurnOutcome> {
  turnCount++;
  const ownedSessionGeneration = sessionGeneration;

  const abortController = new AbortController();
  let abortReason: SessionAbortReason | undefined;
  let recoveryGeneration: number | undefined;
  let sourceSessionAtAbort: string | undefined;
  let checkpointAtAbort: string | undefined;
  let latestCleanAssistantMessageId: string | undefined;
  let sawSuccessfulResult = false;

  const forwardAbort = (): void => {
    if (abortReason) return;
    const reason: SessionAbortReason = signal.reason === "deadline" || signal.reason === "shutdown" || signal.reason === "stop"
      ? signal.reason
      : "stop";
    abortReason = reason;
    sourceSessionAtAbort = sessionId;
    checkpointAtAbort = lastCompletedAssistantMessageId;

    // Persist the taint before the SDK sees the abort. A signal-triggered
    // process exit after this point is therefore recoverable on startup.
    if (ownedSessionGeneration === sessionGeneration) {
      if (sourceSessionAtAbort) {
        persistSession({
          sessionId: sourceSessionAtAbort,
          lastCompletedAssistantMessageId: checkpointAtAbort,
          state: "tainted",
          abortReason: reason,
        });
      }
      recoveryGeneration = ++sessionGeneration;
    }
    abortController.abort(abortReason);
  };
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();

  const childEnv = { ...process.env };
  delete childEnv["RACHEL_SESSION_FILE"];
  childEnv["MCP_TOOL_TIMEOUT"] = process.env["MCP_TOOL_TIMEOUT"] ?? String(DEFAULT_MCP_TOOL_TIMEOUT_MS);

  const options: Parameters<typeof query>[0]["options"] = {
    model: getModel(),
    effort: getEffort(),
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
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
          hooks: [sendGateHook, askUserQuestionHook, memoryGateHook, toolStartTelemetryHook],
          // Strictly longer than sendGateHook's internal 60-second deny
          // timer. Installed SDK 0.3.216 fails closed when this expires.
          timeout: DEFAULT_HOOK_TIMEOUT_SECONDS,
        },
      ],
      PostToolUse: [
        { matcher: ".*", hooks: [toolSuccessTelemetryHook], timeout: 5 },
      ],
      PostToolUseFailure: [
        { matcher: ".*", hooks: [toolFailureTelemetryHook], timeout: 5 },
      ],
    },
    agent: "rachel",
    agents: {
      rachel: {
        description: "Gary's AI assistant Rachel — email, calendar, and tasks.",
        // Re-composed per turn (not read once at module load) — the memory
        // index at ~/.rachel/memory/MEMORY.md can change between turns, and
        // RACHEL_MEMORY_PATH is a per-invocation env seam like
        // RACHEL_ALLOWED_TOOLS above. An absent index means no memories
        // yet, not an error — composeSystemPrompt returns systemPrompt
        // unchanged in that case.
        prompt: composeSystemPrompt(systemPrompt, resolveMemoryPath()),
        skills: [],
      },
    },
    // Second-writer hole: RACHEL_SESSION_FILE is documented above as
    // "exactly one writer" (the bridge), but the bridge's plist sets no
    // RACHEL_ALLOWED_TOOLS, so bridge turns run with unrestricted Bash. A
    // Bash-spawned child (e.g. a nested `bin/rachel "..."` one-shot, an
    // established pattern per prompts/system.md) would otherwise inherit
    // RACHEL_SESSION_FILE via ordinary process env inheritance and silently
    // clobber the bridge's live session pointer. sdk.d.ts's Options.env
    // REPLACES the subprocess env entirely rather than merging, so this
    // spreads process.env and deletes only the one key — everything else
    // (PATH, HOME, etc.) still reaches the SDK subprocess unchanged. The
    // same child environment installs a bounded MCP tool timeout for every
    // Rachel surface.
    env: childEnv,
    ...(sessionId ? { resume: sessionId } : {}),
  };

  try {
    const stream = queryFn({ prompt: userInput, options });
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && (msg as Record<string, unknown>)["subtype"] === "init") {
        const raw = msg as Record<string, unknown>;
        if (typeof raw["session_id"] === "string" && ownedSessionGeneration === sessionGeneration) {
          sessionId = raw["session_id"];
        }
      }

      if (msg.type === "assistant") {
        const raw = msg as unknown as Record<string, unknown>;
        if (raw["aborted"] !== true && typeof raw["uuid"] === "string") {
          latestCleanAssistantMessageId = raw["uuid"];
        }
        // Preserve adjacent text blocks as one frame without reordering them
        // around tool_use blocks. Telegram can then discard narration before
        // a tool while retaining a multi-block final answer after it.
        let textParts: string[] = [];
        const flushTextFrame = (): void => {
          if (textParts.length > 0) emit(textParts.join("\n"), "text");
          textParts = [];
        };
        for (const block of msg.message.content) {
          if (block.type === "text") {
            const text = block.text.trim();
            if (text) textParts.push(text);
          } else if (block.type === "tool_use") {
            flushTextFrame();
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
        flushTextFrame();
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") sawSuccessfulResult = true;
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
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }

  if (abortReason) {
    const recovery = recoveryGeneration === undefined
      ? "superseded"
      : await recoverSessionFromCheckpoint(
          sourceSessionAtAbort,
          checkpointAtAbort,
          recoveryGeneration,
          recoveryDeps,
        );
    return { status: "aborted", reason: abortReason, recovery };
  }

  // A streamed assistant frame is only a candidate checkpoint. Commit it
  // after the SDK reports a successful result and while this turn still owns
  // the generation; error results and reset-raced turns never advance it.
  if (sawSuccessfulResult && sessionId && ownedSessionGeneration === sessionGeneration) {
    if (latestCleanAssistantMessageId) {
      lastCompletedAssistantMessageId = latestCleanAssistantMessageId;
    }
    persistSession({
      sessionId,
      lastCompletedAssistantMessageId,
      state: "active",
    });
  }
  return { status: "completed" };
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
