// Bash send-API pattern defense layer (D1 threat model, plan.md Task 5).
// Deliberately a small, explicit pattern list targeting write/send endpoints
// only — not a general URL classifier. Read-only calls to the same domains
// (e.g. Slack's users.info) must NOT match.

const SEND_PATTERNS: RegExp[] = [
  /slack\.com\/api\/chat\.postMessage/i,
  /api\.telegram\.org\/bot[^/]*\/sendMessage/i,
  /googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send/i,
  /googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events\b/i,
];

export function matchesBashSendPattern(command: string): boolean {
  return SEND_PATTERNS.some((pattern) => pattern.test(command));
}
