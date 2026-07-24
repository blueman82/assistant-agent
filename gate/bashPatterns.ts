// Bash send-API pattern defense layer (D1 threat model, plan.md Task 5).
// Deliberately a small, explicit pattern list targeting write/send endpoints
// only — not a general URL classifier. Read-only calls to the same domains
// (e.g. Slack's users.info) must NOT match.

// chat.postMessage/sendMessage/messages/send are inherently write endpoints —
// no GET-vs-POST distinction needed. The calendar /events path is also used
// for read (GET .../events, GET .../events/{id}), so that one alone requires
// an explicit non-GET method marker (curl -X POST / -XPOST) to avoid denying
// a read-only calendar listing — matching the plan's own true-case list,
// which uses `-X POST` on every calendar example.
// Each verb/route below is anchored explicitly rather than matching a bare
// `chat.` or `drafts` prefix, so read routes on the same surface
// (chat.getPermalink, drafts listing) stay allowed.
const SEND_PATTERNS: RegExp[] = [
  /slack\.com\/api\/chat\.(postMessage|update|delete)\b/i,
  /api\.telegram\.org\/bot[^/]*\/send(Message|Voice|Document)\b/i,
  /googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send/i,
  /googleapis\.com\/gmail\/v1\/users\/[^/]+\/drafts\/send\b/i,
];

const CALENDAR_EVENTS_PATTERN = /googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events\b/i;
// curl infers POST from any body flag, so an explicit method marker is not the
// only signal of a write. `--data` covers --data-raw/-binary/-urlencode; `-d`
// is matched separately with a boundary so --dump-header does not trip it.
const POST_METHOD_PATTERN = /-X\s*POST|--request\s+POST|--data\b|--data-(raw|binary|urlencode)\b|(^|\s)-d(\s|$)/i;

export function matchesBashSendPattern(command: string): boolean {
  if (SEND_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }
  return CALENDAR_EVENTS_PATTERN.test(command) && POST_METHOD_PATTERN.test(command);
}
