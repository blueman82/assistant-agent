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
