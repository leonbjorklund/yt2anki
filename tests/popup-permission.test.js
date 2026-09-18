import assert from "node:assert/strict";
import test from "node:test";
import {
  isPopupPermissionRequest,
  isPopupPermissionResume,
  isPopupPermissionResumeClaim,
  PopupPermissionCoordinator,
} from "../src/popup-permission.ts";

globalThis.chrome = { runtime: { id: "test-extension" } };
const packageSnapshot = {
  downloadUrl: "blob:chrome-extension://test-extension/package-id",
  downloadId: null,
  draftFingerprint: "{}",
  draftVideoId: "abcdefghijk",
};

const requestMessage = {
  package: packageSnapshot,
  action: "open-package",
  tabId: 42,
  targetTrackId: ".zh-Hans",
  translationTrackId: ".en-GB",
  type: "request-popup-permission",
  videoId: "abcdefghijk",
};

test("requests opening permission before waiting and restores the exact package", async () => {
  let resolveContains;
  let requestStarted = false;
  let openCount = 0;
  const coordinator = new PopupPermissionCoordinator({
    contains: () =>
      new Promise((resolve) => {
        resolveContains = resolve;
      }),
    now: () => 1_000,
    openPopup: async () => {
      openCount += 1;
    },
    randomId: () => "attempt-1",
    request: async () => {
      requestStarted = true;
      return true;
    },
  });

  const pending = coordinator.request(requestMessage);
  assert.equal(requestStarted, true);
  resolveContains(false);
  assert.deepEqual(await pending, { attemptId: "attempt-1" });
  assert.equal(openCount, 1);
  assert.deepEqual(
    coordinator.claim({ type: "claim-popup-permission-resume" }),
    {
      action: "open-package",
      package: packageSnapshot,
      granted: true,
      attemptId: "attempt-1",
      requestedAt: 1_000,
      tabId: 42,
      targetTrackId: ".zh-Hans",
      translationTrackId: ".en-GB",
      videoId: "abcdefghijk",
    },
  );
  assert.equal(
    coordinator.claim({ type: "claim-popup-permission-resume" }),
    null,
  );
});

test("returns the existing popup continuation without reopening it", async () => {
  let openCount = 0;
  const coordinator = new PopupPermissionCoordinator({
    contains: async () => true,
    now: () => 1_000,
    openPopup: async () => {
      openCount += 1;
    },
    randomId: () => "attempt-2",
    request: async () => true,
  });

  const result = await coordinator.request(requestMessage);
  assert.equal(openCount, 0);
  assert.equal(
    coordinator.claim({
      attemptId: result.attemptId,
      type: "claim-popup-permission-resume",
    })?.attemptId,
    "attempt-2",
  );
});

for (const granted of [false, true]) {
  test(`preview permission ${granted ? "approval resumes once" : "denial cancels"}`, async () => {
    let opens = 0;
    const coordinator = new PopupPermissionCoordinator({
      contains: async () => false,
      now: () => 1_000,
      openPopup: async () => {
        opens += 1;
      },
      randomId: () => "preview-attempt",
      request: async (permissions) => {
        assert.deepEqual(permissions, {
          origins: ["https://www.youtube.com/*"],
        });
        return granted;
      },
    });
    const result = await coordinator.request({
      ...requestMessage,
      action: "preview",
    });
    assert.deepEqual(result, granted ? { attemptId: "preview-attempt" } : null);
    assert.equal(opens, granted ? 1 : 0);
    const claim = coordinator.claim({ type: "claim-popup-permission-resume" });
    assert.equal(claim?.action ?? null, granted ? "preview" : null);
    assert.equal(
      coordinator.claim({ type: "claim-popup-permission-resume" }),
      null,
    );
  });
}

test("expired or mismatched preview attempts cannot resume", async () => {
  let now = 1_000;
  const coordinator = new PopupPermissionCoordinator({
    contains: async () => true,
    now: () => now,
    openPopup: async () => {},
    randomId: () => "preview-attempt",
    request: async () => true,
  });
  await coordinator.request({ ...requestMessage, action: "preview" });
  assert.equal(
    coordinator.claim({
      type: "claim-popup-permission-resume",
      attemptId: "old",
    }),
    null,
  );
  now += 60_001;
  assert.equal(
    coordinator.claim({ type: "claim-popup-permission-resume" }),
    null,
  );
});

test("rejects malformed popup permission messages", () => {
  assert.equal(isPopupPermissionRequest(requestMessage), true);
  assert.equal(
    isPopupPermissionResumeClaim({
      attemptId: "attempt-1",
      type: "claim-popup-permission-resume",
    }),
    true,
  );
  assert.equal(
    isPopupPermissionResume({
      action: "open-package",
      package: packageSnapshot,
      granted: true,
      attemptId: "attempt-1",
      requestedAt: 1_000,
      tabId: 42,
      targetTrackId: ".zh-Hans",
      videoId: "abcdefghijk",
    }),
    true,
  );
  for (const value of [
    { ...requestMessage, action: "invalid" },
    { ...requestMessage, tabId: -1 },
    { ...requestMessage, targetTrackId: "" },
    { ...requestMessage, translationTrackId: ".zh-Hans" },
    { ...requestMessage, videoId: "invalid" },
    { attemptId: "", type: "claim-popup-permission-resume" },
    {
      action: "open-package",
      package: packageSnapshot,
      granted: true,
      attemptId: "attempt-1",
      requestedAt: Number.NaN,
      tabId: 42,
      targetTrackId: ".zh-Hans",
      videoId: "abcdefghijk",
    },
  ]) {
    assert.equal(
      isPopupPermissionRequest(value) ||
        isPopupPermissionResumeClaim(value) ||
        isPopupPermissionResume(value),
      false,
    );
  }
});

test("denied opening permission restores the same package without authorizing opening", async () => {
  let opens = 0;
  const coordinator = new PopupPermissionCoordinator({
    contains: async () => false,
    now: () => 1_000,
    openPopup: async () => {
      opens += 1;
    },
    randomId: () => "denied",
    request: async () => false,
  });
  await coordinator.request(requestMessage);
  const result = coordinator.claim({ type: "claim-popup-permission-resume" });
  assert.equal(result.granted, false);
  assert.deepEqual(result.package, packageSnapshot);
  assert.equal(opens, 1);
});
