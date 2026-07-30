import assert from "node:assert/strict";
import test from "node:test";
import { isAppMessage } from "../src/messages.ts";

test("accepts complete inspect and generate messages", () => {
  assert.equal(isAppMessage({ tabId: 1, type: "inspect" }), true);
  assert.equal(
    isAppMessage({
      nativeLocale: "en-GB",
      nativeTrackId: ".en-GB",
      tabId: 1,
      targetLocale: "zh-Hans",
      targetTrackId: ".zh-Hans",
      type: "generate",
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
    { tabId: 1, type: "generate" },
    {
      nativeLocale: "not a locale",
      tabId: 1,
      targetLocale: "zh-Hans",
      type: "generate",
    },
    {
      nativeLocale: "en-GB",
      nativeTrackId: " ",
      tabId: 1,
      targetLocale: "zh-Hans",
      type: "generate",
    },
    {
      nativeLocale: "en-GB",
      tabId: 1,
      targetLocale: "zh-Hans",
      targetTrackId: 42,
      type: "generate",
    },
  ]) {
    assert.equal(isAppMessage(value), false);
  }
});
