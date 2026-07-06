# Gated tools — live verification (Task 5 step 1)

Source: `prompts/system.md`'s live-documented Slack section (added in commit
`aeb14d8`, "Wire in personal Slack") plus this session's own attached
Gmail/Calendar MCP tool lists (surfaced directly in this conversation's
deferred-tools system reminder, not re-derived from docs).

## Gmail — confirmed NO send tool exists

Full tool list observed live in this session: `apply_sensitive_message_label`,
`apply_sensitive_thread_label`, `create_draft`, `create_label`, `get_thread`,
`label_message`, `label_thread`, `list_drafts`, `list_labels`,
`search_threads`, `unlabel_message`, `unlabel_thread`. No `send_message` /
`send_draft` tool present. Matches pre-flight finding — Gmail has draft-only
send UX (`create_draft`), left ungated per D2.

## Google Calendar — all four write tools confirmed present

Full tool list observed live in this session: `create_event`, `delete_event`,
`get_event`, `list_calendars`, `list_events`, `respond_to_event`,
`suggest_time`, `update_event`. All four named in spec.md/plan.md
(`create_event`, `update_event`, `delete_event`, `respond_to_event`) are
present and gated.

## Slack — confirmed via system.md's documented tool names

This session's own attached Slack MCP only exposes `authenticate` /
`complete_authentication` (this Claude Code session is not OAuth'd into a
personal Slack workspace) — a different connector instance than the
secretary's dedicated Slack MCP wiring. The authoritative source for the
secretary's actual tool names is `prompts/system.md`'s Slack section (added in
commit `aeb14d8`), which documents: `slack_search_channels`,
`slack_search_users`, `slack_search_public`, `slack_search_public_and_private`,
`slack_read_channel`, `slack_read_thread`, `slack_send_message_draft` (draft,
ungated), `slack_send_message` (send, gated). Full name:
`mcp__claude_ai_Slack__slack_send_message`.

**Residual note**: this is a documentation-sourced confirmation for Slack, not
a live tool-schema introspection, since this session's own Slack connector
isn't authenticated the same way secretary's is. If the secretary's live tool
names ever diverge from what `system.md` documents, `GATED_TOOL_NAMES`
silently stops matching and NC1/NC2/NC3 would no longer gate the real send
path — this is a stated risk, not silently accepted; WU1's live probe or a
future startup-time schema check would close it.

## Final GATED_TOOL_NAMES (folded into `gate/sendGate.ts`)

```
mcp__claude_ai_Slack__slack_send_message
mcp__claude_ai_Google_Calendar__create_event
mcp__claude_ai_Google_Calendar__update_event
mcp__claude_ai_Google_Calendar__delete_event
mcp__claude_ai_Google_Calendar__respond_to_event
```

No Gmail send tool exists to add. Draft tools (`slack_send_message_draft`,
Gmail `create_draft`) remain deliberately absent from this list — ungated per
D2.
