# AGENTS.md — Wiki Schema for assistant-agent

## Wiki location

`/Users/harrison/Github/assistant-agent-wiki/`

## Git config (read by wiki-lint/wiki-ingest/wiki-query)

The vault's own config, `assistant-agent-wiki/.claude/workflow.config.yaml`:

```yaml
project: assistant-agent-wiki
wiki_path: .
worktree_base: /Users/harrison/Github
worktree_script: null
jira: null
engineering_principles_paths: null
engineering_principles_skill: null
```

`worktree_script: null` (no worktree/PR flow configured) means writes land directly on `assistant-agent-wiki`'s `main`, no branch/PR ceremony. Confirmed against the vault's own history (three pre-existing commits landed straight on `main` before this file existed).

## Schema lineage

This schema is a documented extension of the coderails wiki schema, not a fork of it: page format (frontmatter fields, `[[wiki-links]]`), `index.md`-first navigation, append-only `log.md`, and the ingest/query/lint workflows below all follow coderails' own wiki conventions. The extension is the page-type taxonomy — `architecture/capabilities/patterns/investigations/sources/templates` (+ `raw/`) — which stays as-is rather than adopting coderails' own type set (`command/hook/skill/design/investigation/source`), because this wiki documents a personal agent's capabilities and behaviour, not a plugin's commands and hooks. Adopt coderails' rules; keep this project's taxonomy.

## Three layers

1. **Raw sources** — immutable input. Two locations:
   - The project codebase at `/Users/harrison/Github/assistant-agent/` — read via normal file tools
   - Drop zone at `/Users/harrison/Github/assistant-agent-wiki/raw/` — articles, PDFs, notes Gary drops in. Read, never modify.
2. **Wiki** — LLM-maintained markdown at the vault path above. Claude owns this entirely.
3. **Schema** — this file. Defines conventions and workflows.

## Page types

| Directory | Purpose |
|-----------|---------|
| `architecture/` | How the system is built — components, wiring, data flow |
| `capabilities/` | What Rachel can do — one page per tool surface |
| `patterns/` | Reusable approaches — how to extend, configure, evolve |
| `investigations/` | Filed-back answers to Gary's queries |
| `sources/` | Ingested references — docs, gists, PRs |
| `templates/` | Page skeletons — copy, don't edit |

## Page format

```yaml
---
title: ""
type: architecture | capability | pattern | investigation | source
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
sources: []   # file paths or URLs consulted
tags: []
---
```

Body: concise (under 2 min to read). Use `[[wiki-links]]` for cross-references. No narrative — facts and relationships only.

## Workflows

### Ingest (new source added)
Trigger: Gary says "ingest raw/" or "ingest [file]", or a new file appears in `raw/`.
1. `Glob` the `raw/` directory to find unprocessed files
2. For each file: `Read` it in full — never summarise before reading
3. Update 5–15 existing wiki pages that relate to it (add cross-refs, update facts, correct stale claims)
4. Create a new `sources/YYYY-MM-DD-slug.md` page summarising what was learned
5. Append an entry to `log.md`
6. Do NOT delete or modify the raw file — it stays as the immutable source

### Query (Gary asks a question)
1. Read `index.md` first
2. Read relevant pages
3. Answer from wiki; if the answer required non-trivial synthesis, file it back as `investigations/YYYY-MM-DD-slug.md`
4. Update `index.md` if a new investigations page was created

### Lint (periodic maintenance)
- Check for contradictions between pages
- Check for orphaned pages not linked from `index.md`
- Check `last_updated` — flag pages not updated in 90+ days if they cover active code

## Conventions

- `index.md` — read first, always. Update when pages are added.
- `log.md` — append only. Format: `## [YYYY-MM-DD] operation | description`
- Wikilinks use filename without extension: `[[architecture/overview]]`
- "Not yet documented." marks known gaps in `index.md`

## Evolution

This schema evolves with the project. When a new capability or page type is needed, update this file and add the new directory and template.

## Send gate (folded from build-time scratch notes)

`rachel.ts` wires a `PreToolUse` hook (`gate/sendGate.ts`) that intercepts every call to a gated tool and blocks it until an approval surface (terminal, Telegram, or the dashboard queue file at `~/.claude/coderails-dashboard/approvals/`) resolves. This is the enforcement floor referenced in `prompts/system.md`'s "The send gate" section; the prompt-level draft-first rules remain the UX contract, not the enforcement.

**Update-routing for Telegram (`gate/surfaces/telegram.ts` + `bridge/telegram-bridge.ts`)**: Telegram allows exactly one `getUpdates` long-poll consumer per bot token, so `bridge/telegram-bridge.ts` owns that single loop — it is the only thing in the repo calling `getUpdates`. The approval surface (`gate/surfaces/telegram.ts`) does not poll for itself; it exposes `handleCallbackQuery`, and the bridge feeds `callback_query` updates into it as they arrive, routed ahead of any queued chat turn (a gate decision may be blocking a turn, so a callback must never wait behind the FIFO). Ordinary chat messages take the other path: the bridge queues them FIFO and drains them through `rachel.ts`'s exported `runTurn`. Both paths converge on the same `telegramSurface` instance exported from `rachel.ts` — the bridge imports it rather than constructing a second one, so a button tap resolves the exact surface the send gate is racing against.

**Gated tools** (Calendar and Gmail confirmed live against this session's own attached MCP tool lists; Slack confirmed via `prompts/system.md`'s documented tool names, not a live introspection — see the residual-risk note below):
```
mcp__claude_ai_Slack__slack_send_message
mcp__claude_ai_Google_Calendar__create_event
mcp__claude_ai_Google_Calendar__update_event
mcp__claude_ai_Google_Calendar__delete_event
mcp__claude_ai_Google_Calendar__respond_to_event
```
Gmail has no send tool (confirmed live — only `create_draft` and read/label/search tools exist), so nothing to gate there. Draft tools (`slack_send_message_draft`, Gmail `create_draft`) stay ungated deliberately — gating a draft breaks the confirm flow for no security benefit.

**Residual risk, stated not silent**: the Slack tool-name confirmation above came from `prompts/system.md`'s documented names, not a live introspection of the secretary's own Slack MCP connector (this session's attached Slack connector wasn't the same authenticated instance). If the secretary's live tool names ever drift from what's documented here, `GATED_TOOL_NAMES` in `gate/sendGate.ts` silently stops matching and the gate stops covering the real send path. Closing this needs either a startup-time live schema check or a future hook-probe run confirming tool names directly inside a secretary session — not yet built.

**Fail-closed semantics, confirmed by a live spike against the installed SDK** (Node v24.10.0, `@anthropic-ai/claude-agent-sdk`): a `PreToolUse` hook that throws is swallowed by the SDK and treated as no-opinion (tool proceeds) — confirmed fail-open. A hook whose promise resolves after its declared `HookCallbackMatcher.timeout`/`asyncTimeout` also proceeds — the SDK does not cut it off itself, also confirmed fail-open. Neither `timeout` field is a real enforcement mechanism. Consequence: `createSendGateHook` wraps its entire body in try/catch (explicit deny on any exception) and races every approval surface against its own internal deny-timer (`Promise.race`, strictly shorter than any matcher timeout) rather than trusting the SDK to fail closed on its own. This is why the gate self-enforces rather than relying on SDK-native timeout/throw behaviour.

**Per-item approval, one-shot, audited**: approval is bound to a SHA-256 hash of the canonicalised (sorted-key) tool input — approving one message never approves a different one, even to the same tool. An approval is consumed on first use; a replay of the same hash is denied (`"Approval already consumed — request a fresh approval."`). Every attempt and decision is appended to `~/.secretary/send-gate-audit.jsonl`. A well-formed send with no approval received is denied with `"No approval received — redraft or ask the operator directly."` A `Bash` command matching a known send-API pattern (Slack `chat.postMessage`, Telegram `sendMessage`, Gmail `messages/send`, or a `POST` to the Calendar events endpoint) is denied outright with `"Send-capable Bash command blocked — use the corresponding MCP tool instead (Slack/Gmail/Calendar), which routes through the approval gate."` — this path has no approval to offer, since a Bash send bypasses hash-binding entirely.

**Accepted residual, not closed by this gate**: browser-automation sends (`mcp__claude-in-chrome__*` driving the Slack/Gmail web UI) are not pattern-matchable and are not gated. Detection is audit-log-only. This is a documented tradeoff, not an oversight.
