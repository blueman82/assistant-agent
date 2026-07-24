import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesBashSendPattern } from "./bashPatterns.ts";

test("curl POST to slack.com/api/chat.postMessage -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://slack.com/api/chat.postMessage -d '{"channel":"#x","text":"hi"}'`),
    true,
  );
});

test("curl to api.telegram.org/bot.../sendMessage -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl https://api.telegram.org/bot123456:ABC/sendMessage -d 'chat_id=1&text=hi'`),
    true,
  );
});

test("curl to googleapis gmail messages/send -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://www.googleapis.com/gmail/v1/users/me/messages/send -d '{}'`),
    true,
  );
});

test("curl POST to googleapis calendar events -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://www.googleapis.com/calendar/v3/calendars/primary/events -d '{}'`),
    true,
  );
});

test("ls -la -> false", () => {
  assert.equal(matchesBashSendPattern("ls -la"), false);
});

test("read-only Slack API call (users.info) -> false, since it's not a send route", () => {
  assert.equal(matchesBashSendPattern("curl https://slack.com/api/users.info?user=U123"), false);
});

test("read-only GET to the same calendar events path -> false, since listing/reading events is not a send", () => {
  assert.equal(
    matchesBashSendPattern("curl https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    false,
  );
});

// --- RCA 2026-07-23 item 14: coverage holes ---

// Hole 1: curl infers POST from a body flag, so matching only on an explicit
// -X POST let a calendar write through.

test("calendar events with --data and no -X POST -> true, since curl infers POST from a body", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events --data '{"summary":"x"}'`,
    ),
    true,
  );
});

test("calendar events with --data-raw and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events --data-raw '{"summary":"x"}'`,
    ),
    true,
  );
});

test("calendar events with --data-binary and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events --data-binary @body.json`,
    ),
    true,
  );
});

test("calendar events with --data-urlencode and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events --data-urlencode 'summary=x'`,
    ),
    true,
  );
});

test("calendar events with short -d and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events -d '{"summary":"x"}'`,
    ),
    true,
  );
});

// curl also accepts -d with its value attached rather than space-separated,
// which is at least as idiomatic as the spaced form.

test("calendar events with attached -d@file and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern("curl -d@body.json https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    true,
  );
});

test("calendar events with attached -d'{...}' and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl -d'{"summary":"x"}' https://www.googleapis.com/calendar/v3/calendars/primary/events`,
    ),
    true,
  );
});

test("calendar events with attached -dkey=value and no -X POST -> true", () => {
  assert.equal(
    matchesBashSendPattern("curl -dsummary=x https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    true,
  );
});

test("calendar events GET with unrelated flags starting in d -> false, since no body is sent", () => {
  assert.equal(
    matchesBashSendPattern(
      "curl --dump-header /dev/null https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ),
    false,
  );
});

test("calendar events GET with -D dump-header -> false, since -D is a read flag, not -d", () => {
  assert.equal(
    matchesBashSendPattern("curl -D headers.txt https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    false,
  );
});

// Additional gaps found in review: curl accepts several other body-flag
// forms beyond -X POST/--data*/-d that also imply a write.

test("calendar events with --json and no -X POST -> true, since --json implies a body", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl https://www.googleapis.com/calendar/v3/calendars/primary/events --json '{"summary":"x"}'`,
    ),
    true,
  );
});

test("calendar events with -F form field and no -X POST -> true, since -F sends multipart body", () => {
  assert.equal(
    matchesBashSendPattern(
      "curl https://www.googleapis.com/calendar/v3/calendars/primary/events -F summary=x",
    ),
    true,
  );
});

test("calendar events GET with -f fail-on-error -> false, since -f is unrelated to -F", () => {
  assert.equal(
    matchesBashSendPattern("curl -f https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    false,
  );
});

test("calendar events with bundled -sd short flags and no -X POST -> true, since -s and -d can bundle", () => {
  assert.equal(
    matchesBashSendPattern(
      `curl -sd '{"summary":"x"}' https://www.googleapis.com/calendar/v3/calendars/primary/events`,
    ),
    true,
  );
});

test("calendar events with bundled -sF short flags and no -X POST -> true, since -s and -F can bundle", () => {
  assert.equal(
    matchesBashSendPattern(
      "curl -sF summary=x https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ),
    true,
  );
});

// Hole 2: Telegram send endpoints beyond sendMessage.

test("telegram sendVoice -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl https://api.telegram.org/bot123456:ABC/sendVoice -F chat_id=1 -F voice=@a.ogg`),
    true,
  );
});

test("telegram sendDocument -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl https://api.telegram.org/bot123456:ABC/sendDocument -F chat_id=1 -F document=@a.pdf`),
    true,
  );
});

test("telegram getUpdates -> false, since polling is a read, not a send", () => {
  assert.equal(
    matchesBashSendPattern("curl https://api.telegram.org/bot123456:ABC/getUpdates"),
    false,
  );
});

// Hole 3: Slack message mutation endpoints beyond chat.postMessage.

test("slack chat.update -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://slack.com/api/chat.update -d '{"ts":"1","text":"edited"}'`),
    true,
  );
});

test("slack chat.delete -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://slack.com/api/chat.delete -d '{"ts":"1"}'`),
    true,
  );
});

test("slack chat.getPermalink -> false, since reading a permalink is not a send", () => {
  assert.equal(
    matchesBashSendPattern("curl https://slack.com/api/chat.getPermalink?channel=C1&message_ts=1"),
    false,
  );
});

// Hole 4: Gmail can send an existing draft without touching messages/send.

test("gmail drafts/send -> true", () => {
  assert.equal(
    matchesBashSendPattern(`curl -X POST https://www.googleapis.com/gmail/v1/users/me/drafts/send -d '{"id":"r1"}'`),
    true,
  );
});

test("gmail drafts list -> false, since listing drafts is a read", () => {
  assert.equal(
    matchesBashSendPattern("curl https://www.googleapis.com/gmail/v1/users/me/drafts"),
    false,
  );
});
