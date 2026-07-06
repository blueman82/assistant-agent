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
const SEND_PATTERNS: RegExp[] = [
  /slack\.com\/api\/chat\.postMessage/i,
  /api\.telegram\.org\/bot[^/]*\/sendMessage/i,
  /googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send/i,
];

const CALENDAR_EVENTS_PATTERN = /googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events\b/i;
const POST_METHOD_PATTERN = /-X\s*POST|--request\s+POST/i;

export function matchesBashSendPattern(command: string): boolean {
  if (SEND_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }
  return CALENDAR_EVENTS_PATTERN.test(command) && POST_METHOD_PATTERN.test(command);
}
