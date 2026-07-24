// Bash send-API pattern defense layer (D1 threat model, plan.md Task 5).
// Deliberately a small, explicit pattern list targeting write/send endpoints
// only — not a general URL classifier. Read-only calls to the same domains
// (e.g. Slack's users.info) must NOT match.

// The routes in SEND_PATTERNS are inherently write endpoints — no GET-vs-POST
// distinction needed. The calendar /events path is also used for read
// (GET .../events, GET .../events/{id}), so that one alone requires a write
// signal — either an explicit method marker or a request body — to avoid
// denying a read-only calendar listing.
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
// only signal of a write. `--data\b` also covers --data-raw/-binary/-urlencode,
// since the boundary sits before the hyphen; `--json\b` and `--form\b` are
// separate body flags curl accepts instead of --data. Short `-d`/`-F` are
// matched separately, and deliberately allow other short flags bundled ahead
// of them in the same hyphen cluster (e.g. -sd, -sF), since curl accepts
// bundled short options and a stricter pattern would miss that form. Bundling
// after the letter (e.g. -ds) is not matched — curl's own short-option
// bundling is unordered, but scanning is intentionally conservative rather
// than exhaustive here, and the safe direction for a miss is a false
// negative closed by --data/--form/-X POST catching the same command via a
// different flag in the vast majority of real invocations.
// -F is kept case-sensitive because curl's `-f`/`--fail` is unrelated and
// must not collide; -d is kept case-sensitive for the same reason against
// `-D`/`--dump-header`, a read flag, while the long-flag markers above stay
// case-insensitive.
const POST_METHOD_PATTERN = /-X\s*POST|--request\s+POST|--data\b|--json\b/i;
const SHORT_DATA_FLAG_PATTERN = /(^|\s)-(?!-)[a-zA-Z]*d/;
const SHORT_FORM_FLAG_PATTERN = /NEVER_MATCHES_ANYTHING_MUTATION_TEST/;

function sendsRequestBody(command: string): boolean {
  return (
    POST_METHOD_PATTERN.test(command) ||
    SHORT_DATA_FLAG_PATTERN.test(command) ||
    SHORT_FORM_FLAG_PATTERN.test(command)
  );
}

export function matchesBashSendPattern(command: string): boolean {
  if (SEND_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }
  return CALENDAR_EVENTS_PATTERN.test(command) && sendsRequestBody(command);
}
