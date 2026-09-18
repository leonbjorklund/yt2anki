import assert from "node:assert/strict";
import test from "node:test";
import { reopenPendingPopup } from "../src/background/recovery.ts";
import {
  APP_PROTOCOL_VERSION,
  isFreshPopupRecovery,
  POPUP_RECOVERY_KEY,
  POPUP_RECOVERY_MAX_AGE_MS,
} from "../src/popup-recovery.ts";

const now = 2_000_000;
const recovery = {
  protocolVersion: APP_PROTOCOL_VERSION,
  requestedAt: now,
};

test("accepts only current one-shot popup recovery records", () => {
  assert.equal(isFreshPopupRecovery(recovery, now), true);
  for (const value of [
    { ...recovery, protocolVersion: 2 },
    { ...recovery, protocolVersion: APP_PROTOCOL_VERSION + 1 },
    { ...recovery, requestedAt: now - POPUP_RECOVERY_MAX_AGE_MS - 1 },
    { ...recovery, requestedAt: now + 1 },
    null,
  ]) {
    assert.equal(isFreshPopupRecovery(value, now), false);
  }
});

test("consumes a current recovery record and reopens the popup", async () => {
  const originalChrome = globalThis.chrome;
  const stored = {
    [POPUP_RECOVERY_KEY]: {
      protocolVersion: APP_PROTOCOL_VERSION,
      requestedAt: Date.now(),
    },
  };
  let openCount = 0;
  globalThis.chrome = {
    action: {
      async openPopup() {
        openCount += 1;
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: stored[key] };
        },
        async remove(key) {
          delete stored[key];
        },
      },
    },
  };

  try {
    await reopenPendingPopup();
    assert.equal(openCount, 1);
    assert.equal(stored[POPUP_RECOVERY_KEY], undefined);
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});
