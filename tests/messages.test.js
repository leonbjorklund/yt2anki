import assert from "node:assert/strict";
import test from "node:test";
import { isAppMessage } from "../src/messages.ts";

test("accepts complete extension messages", () => {
  assert.equal(isAppMessage({ tabId: 1, type: "inspect" }), true);
  assert.equal(isAppMessage({ tabId: 1, type: "inspect-recovery" }), true);
  assert.equal(
    isAppMessage({ tabId: 1, type: "preflight", videoId: "abcdefghijk" }),
    true,
  );
  assert.equal(
    isAppMessage({
      tabId: 1,
      targetTrackId: ".zh-Hans",
      translationTrackId: ".en-GB",
      type: "generate",
    }),
    true,
  );
  assert.equal(
    isAppMessage({
      tabId: 1,
      targetTrackId: ".zh-Hans",
      type: "generate-package",
      videoId: "abcdefghijk",
    }),
    true,
  );
});

test("rejects malformed AppMessage fields and options", () => {
  for (const value of [
    null,
    [],
    { type: "inspect" },
    { tabId: -1, type: "inspect" },
    { tabId: 1.5, type: "inspect" },
    { tabId: 1, type: "preflight", videoId: "invalid" },
    { tabId: 1, type: "generate" },
    {
      tabId: 1,
      targetTrackId: ".zh-Hans",
      type: "generate-package",
    },
    {
      tabId: 1,
      targetTrackId: ".zh-Hans",
      type: "generate-package",
      videoId: "invalid",
    },
    {
      tabId: 1,
      targetTrackId: " ",
      type: "generate-package",
    },
    {
      tabId: 1,
      targetTrackId: " ",
      type: "generate",
    },
    {
      tabId: 1,
      targetTrackId: 42,
      type: "generate",
    },
    {
      tabId: 1,
      targetTrackId: ".en",
      translationTrackId: ".en",
      type: "generate",
    },
  ]) {
    assert.equal(isAppMessage(value), false);
  }
});

test("resumed Preview requires the exact Source Video identity", () => {
  const message = {
    tabId: 1,
    targetTrackId: ".zh-Hans",
    type: "generate-preview",
  };
  assert.equal(isAppMessage(message), false);
  assert.equal(isAppMessage({ ...message, videoId: "invalid" }), false);
  assert.equal(isAppMessage({ ...message, videoId: "abcdefghijk" }), true);
});
