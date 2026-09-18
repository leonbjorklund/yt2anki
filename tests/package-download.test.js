import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadPackage,
  isPackageDeliverySnapshot,
  PackageDelivery,
} from "../src/anki/package-download.ts";
import { createDraft } from "./fixtures.js";

test("invalidates an in-flight package when its Draft changes", async (context) => {
  const draft = createDraft();
  let markSearchStarted;
  const searchStarted = new Promise((resolve) => {
    markSearchStarted = resolve;
  });
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
    },
    search: async () => {
      markSearchStarted();
      return [{ danger: "safe", id: 42, state: "in_progress" }];
    },
    url: "blob:changing-package",
  });
  const delivery = new PackageDelivery();
  const pending = delivery.run({
    build: async () => Uint8Array.from([4, 2]),
    prepareDraft: async () => draft,
  });
  await searchStarted;

  assert.equal(
    delivery.invalidateForDraftChange(structuredClone(draft)),
    false,
  );
  const changed = structuredClone(draft);
  changed.segments[0].target = "Changed elsewhere";
  assert.equal(delivery.invalidateForDraftChange(changed), true);
  tracker.onChanged.emit({ id: 42, state: { current: "complete" } });
  assert.equal(await pending, "superseded");
  assert.equal(delivery.canOpen, false);
  assert.equal(delivery.needsFreshPackage, true);
  assertTrackerClean(tracker);
});

test("ignores an older open result after a replacement package completes", async (context) => {
  let nextDownloadId = 41;
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: nextDownloadId++,
        state: "complete",
        url,
      });
    },
    search: async ({ id }) => [completedItem(id)],
    url: "blob:replacement-package",
  });
  const openCalls = [];
  let finishFirstOpen;
  let markFirstOpenStarted;
  const firstOpenStarted = new Promise((resolve) => {
    markFirstOpenStarted = resolve;
  });
  globalThis.chrome.downloads.open = (downloadId) => {
    openCalls.push(downloadId);
    if (downloadId === 41) {
      markFirstOpenStarted();
      return new Promise((resolve) => {
        finishFirstOpen = resolve;
      });
    }
    return Promise.resolve();
  };
  const delivery = new PackageDelivery();
  const options = {
    build: async () => Uint8Array.from([4, 2]),
    prepareDraft: async () => createDraft(),
  };

  assert.equal(await delivery.run(options), "completed");
  const firstOpen = delivery.open();
  await firstOpenStarted;
  assert.equal(await delivery.run(options), "completed");
  finishFirstOpen();
  assert.equal(await firstOpen, "superseded");
  assert.equal(await delivery.open(), "accepted");
  assert.deepEqual(openCalls, [41, 42]);
  assertTrackerClean(tracker, 2);
});

test("requires a new download when the completed package is missing", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "complete",
        url,
      });
    },
    search: async ({ id }) => [{ ...completedItem(id), exists: false }],
    url: "blob:deleted-package",
  });
  const openCalls = [];
  globalThis.chrome.downloads.open = async (downloadId) => {
    openCalls.push(downloadId);
  };
  const delivery = new PackageDelivery();

  assert.equal(
    await delivery.run({
      build: async () => Uint8Array.from([4, 2]),
      prepareDraft: async () => createDraft(),
    }),
    "completed",
  );
  assert.equal(await delivery.open(), "missing");
  assert.equal(delivery.canOpen, false);
  assert.equal(delivery.needsFreshPackage, true);
  assert.deepEqual(openCalls, []);
  assertTrackerClean(tracker);
});

test("downloads without requesting permission and retains the exact package for opening", async (context) => {
  const tracker = installTrackedDownload(context, {
    click() {},
    search: async () => [],
    url: "blob:permission-free-package",
  });
  let requests = 0;
  globalThis.chrome.permissions.contains = async () => false;
  globalThis.chrome.permissions.request = async () => {
    requests++;
    return false;
  };
  const delivery = new PackageDelivery();
  const draft = createDraft();
  assert.equal(
    await delivery.run({
      build: async () => Uint8Array.from([4, 2]),
      prepareDraft: async () => draft,
    }),
    "started",
  );
  assert.equal(requests, 0);
  assert.equal(tracker.starts.length, 1);
  assert.equal(delivery.canOpen, true);
  assert.equal(delivery.draftVideoId, draft.video.videoId);
  assert.equal(
    delivery.invalidateForDraftChange(structuredClone(draft)),
    false,
  );
  assert.equal(delivery.openPermissionsGranted, false);
  delivery.markOpenPermissionsGranted();
  assert.equal(delivery.openPermissionsGranted, true);
  assert.equal(requests, 0);
  assert.equal(delivery.canOpen, true);
  assert.equal(delivery.invalidateForUserChange(), true);
  assert.equal(delivery.canOpen, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("opens only the exact permission-free download after grant, including a restored popup", async (context) => {
  const queries = [];
  const tracker = installTrackedDownload(context, {
    click() {},
    search: async (query) => {
      queries.push(query);
      return [
        {
          ...completedItem(42),
          url: "blob:chrome-extension://test/exact-package",
        },
      ];
    },
    url: "blob:chrome-extension://test/exact-package",
  });
  globalThis.chrome.runtime.id = "test";
  globalThis.chrome.permissions.contains = async () => false;
  const delivery = new PackageDelivery();
  await delivery.run({
    build: async () => Uint8Array.from([4, 2]),
    prepareDraft: async () => createDraft(),
  });
  const snapshot = delivery.snapshot();
  assert.equal(isPackageDeliverySnapshot(snapshot), true);
  assert.equal(
    isPackageDeliverySnapshot({
      ...snapshot,
      downloadUrl: "blob:chrome-extension://other/file",
    }),
    false,
  );
  assert.equal(
    isPackageDeliverySnapshot({ ...snapshot, downloadId: -1 }),
    false,
  );
  const reopened = new PackageDelivery();
  reopened.restore(snapshot);
  reopened.markOpenPermissionsGranted();
  let insideCallback = false;
  const opened = [];
  globalThis.chrome.downloads.search = (query, callback) => {
    queries.push(query);
    insideCallback = true;
    callback([{ ...completedItem(42), url: tracker.url }]);
    insideCallback = false;
  };
  globalThis.chrome.downloads.open = async (id) => {
    assert.equal(
      insideCallback,
      true,
      "open must retain the search callback user gesture",
    );
    opened.push(id);
  };
  assert.equal(await reopened.open(), "accepted");
  assert.equal(reopened.canOpen, true);
  assert.deepEqual(queries, [{ url: tracker.url }]);
  assert.deepEqual(opened, [42]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertTrackerClean(tracker);
});

test("untracked opening fails closed for missing, ambiguous, unsafe, and unfinished files", async (context) => {
  const tracker = installTrackedDownload(context, {
    click() {},
    search: async () => [],
    url: "blob:exact-package",
  });
  const valid = { ...completedItem(42), url: tracker.url };
  const cases = [
    { items: [], outcome: "missing", canOpen: false },
    {
      items: [valid, { ...valid, id: 43 }],
      outcome: "missing",
      canOpen: false,
    },
    {
      items: [{ ...valid, url: "blob:other" }],
      outcome: "missing",
      canOpen: false,
    },
    {
      items: [{ ...valid, exists: false }],
      outcome: "missing",
      canOpen: false,
    },
    {
      items: [{ ...valid, danger: "uncommon" }],
      outcome: "rejected",
      canOpen: false,
    },
    {
      items: [{ ...valid, state: "interrupted" }],
      outcome: "rejected",
      canOpen: false,
    },
    {
      items: [{ ...valid, state: "in_progress" }],
      outcome: "pending",
      canOpen: true,
    },
  ];
  let opens = 0;
  globalThis.chrome.downloads.open = async () => {
    opens++;
  };
  for (const { items, outcome, canOpen } of cases) {
    const delivery = new PackageDelivery();
    delivery.restore({
      downloadUrl: tracker.url,
      downloadId: null,
      draftFingerprint: JSON.stringify(createDraft()),
      draftVideoId: "abcdefghijk",
    });
    globalThis.chrome.downloads.search = (_query, callback) => callback(items);
    assert.equal(await delivery.open(), outcome);
    assert.equal(delivery.canOpen, canOpen);
  }
  assert.equal(opens, 0);
});

test("draft invalidation while exact lookup is pending prevents opening", async (context) => {
  installTrackedDownload(context, {
    click() {},
    search: async () => [],
    url: "blob:exact-package",
  });
  const delivery = new PackageDelivery();
  delivery.restore({
    downloadUrl: "blob:exact-package",
    downloadId: null,
    draftFingerprint: JSON.stringify(createDraft()),
    draftVideoId: "abcdefghijk",
  });
  let finishSearch;
  let opens = 0;
  globalThis.chrome.downloads.search = (_query, callback) => {
    finishSearch = callback;
  };
  globalThis.chrome.downloads.open = async () => {
    opens++;
  };
  const pending = delivery.open();
  delivery.invalidateForUserChange();
  finishSearch([{ ...completedItem(42), url: "blob:exact-package" }]);
  assert.equal(await pending, "superseded");
  assert.equal(opens, 0);
});

test("starts the existing anchor download when the open capability is unavailable", async (context) => {
  const originalDocument = globalThis.document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  context.after(() => {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });
  const clicked = [];
  const revoked = [];
  let packageBlob;
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, "a");
      return {
        click() {
          clicked.push({ download: this.download, href: this.href });
        },
        download: "",
        href: "",
      };
    },
  };
  URL.createObjectURL = (blob) => {
    packageBlob = blob;
    return "blob:exact-package";
  };
  URL.revokeObjectURL = (url) => revoked.push(url);

  const result = await downloadPackage(
    Uint8Array.from([1, 2, 3]),
    createDraft(),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(result, { downloadId: null, url: "blob:exact-package" });
  assert.deepEqual(clicked, [
    {
      download: "Fixture video - abcdefghijk.apkg",
      href: "blob:exact-package",
    },
  ]);
  assert.equal(packageBlob.type, "application/octet-stream");
  assert.deepEqual(
    [...new Uint8Array(await packageBlob.arrayBuffer())],
    [1, 2, 3],
  );
  assert.deepEqual(revoked, ["blob:exact-package"]);
});

test("keeps the readable filename while tracking an anchor download", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "complete",
        url,
      });
    },
    search: async () => [],
    url: "blob:tracked-package",
  });

  assert.deepEqual(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    { downloadId: 42, url: tracker.url },
  );
  assert.deepEqual(tracker.starts, [
    {
      download: "Fixture video - abcdefghijk.apkg",
      url: "blob:tracked-package",
    },
  ]);
  assertTrackerClean(tracker);
});

test("tracks only the exact Blob download and closes the completion race", async (context) => {
  const searches = [];
  const tracker = installTrackedDownload(context, {
    click({ onChanged, onCreated, url }) {
      assert.equal(onCreated.listenerCount(), 1);
      assert.equal(onChanged.listenerCount(), 1);
      onCreated.emit({
        danger: "safe",
        id: 9,
        state: "in_progress",
        url: "blob:unrelated-package",
      });
      onChanged.emit({ id: 9, state: { current: "complete" } });
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
    },
    search: async (query) => {
      searches.push(query);
      return [completedItem(query.id)];
    },
    url: "blob:exact-id-package",
  });

  assert.deepEqual(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    { downloadId: 42, url: tracker.url },
  );
  assert.deepEqual(searches, [{ id: 42 }]);
  assertTrackerClean(tracker);
});

test("refuses a download Chrome flags as dangerous", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "uncommon",
        id: 42,
        state: "in_progress",
        url,
      });
    },
    search: async () => [{ danger: "uncommon", id: 42, state: "in_progress" }],
    url: "blob:dangerous-package",
  });

  assert.equal(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    "interrupted",
  );
  assertTrackerClean(tracker);
});

test("refuses an exact download that turns dangerous after creation", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onChanged, onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
      queueMicrotask(() =>
        onChanged.emit({ danger: { current: "uncommon" }, id: 42 }),
      );
    },
    search: async () => [{ danger: "safe", id: 42, state: "in_progress" }],
    url: "blob:turns-dangerous-package",
  });

  assert.equal(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    "interrupted",
  );
  assertTrackerClean(tracker);
});

test("reports an interrupted exact download and cleans up tracking", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onChanged, onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
      queueMicrotask(() =>
        onChanged.emit({ id: 42, state: { current: "interrupted" } }),
      );
    },
    search: async () => [{ danger: "safe", id: 42, state: "in_progress" }],
    url: "blob:interrupted-package",
  });

  assert.equal(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    "interrupted",
  );
  assertTrackerClean(tracker);
});

test("ignores unrelated erasure and stops when the exact download is erased", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onCreated, onErased, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
      queueMicrotask(() => {
        onErased.emit(9);
        assert.equal(onErased.listenerCount(), 1);
        onErased.emit(42);
      });
    },
    search: async () => [{ danger: "safe", id: 42, state: "in_progress" }],
    url: "blob:erased-package",
  });

  assert.equal(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    "interrupted",
  );
  assertTrackerClean(tracker);
});

test("normalizes an exact-download lookup failure and cleans up tracking", async (context) => {
  const tracker = installTrackedDownload(context, {
    click({ onCreated, url }) {
      onCreated.emit({
        danger: "safe",
        id: 42,
        state: "in_progress",
        url,
      });
    },
    search: async () => [],
    url: "blob:missing-package",
  });

  assert.equal(
    await downloadPackage(Uint8Array.from([4, 2]), createDraft(), true),
    "interrupted",
  );
  assertTrackerClean(tracker);
});

test("stops tracking when the exact download is never created", async (context) => {
  const tracker = installTrackedDownload(context, {
    click() {},
    search: async () => [],
    timer: true,
    url: "blob:not-created-package",
  });

  const pending = downloadPackage(Uint8Array.from([4, 2]), createDraft(), true);
  tracker.fireCreationTimeout();

  assert.equal(await pending, "interrupted");
  assertTrackerClean(tracker);
  assert.deepEqual(tracker.clearedTimeouts, [42]);
});

function installTrackedDownload(
  context,
  { click, search, timer = false, url },
) {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  context.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  const tracker = {
    clearedTimeouts: [],
    creationTimeout: null,
    onChanged: chromeEvent(),
    onCreated: chromeEvent(),
    onErased: chromeEvent(),
    revoked: [],
    starts: [],
    url,
  };
  globalThis.chrome = {
    runtime: {},
    downloads: {
      onChanged: tracker.onChanged,
      onCreated: tracker.onCreated,
      onErased: tracker.onErased,
      open: async () => undefined,
      search(query, callback) {
        if (!callback) return search(query);
        void search(query).then(callback);
      },
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
  };
  URL.createObjectURL = () => url;
  URL.revokeObjectURL = (value) => tracker.revoked.push(value);
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, "a");
      return {
        click() {
          tracker.starts.push({ download: this.download, url: this.href });
          click(tracker);
        },
        download: "",
        href: "",
      };
    },
  };
  if (timer) {
    globalThis.setTimeout = (callback, delay) => {
      assert.equal(delay, 10_000);
      tracker.creationTimeout = callback;
      return 42;
    };
    globalThis.clearTimeout = (timeoutId) =>
      tracker.clearedTimeouts.push(timeoutId);
  }
  tracker.fireCreationTimeout = () => tracker.creationTimeout();
  return tracker;
}

function completedItem(id) {
  return { danger: "safe", exists: true, id, state: "complete" };
}

function assertTrackerClean(tracker, revokeCount = 1) {
  assert.equal(tracker.onCreated.listenerCount(), 0);
  assert.equal(tracker.onChanged.listenerCount(), 0);
  assert.equal(tracker.onErased.listenerCount(), 0);
  assert.deepEqual(tracker.revoked, Array(revokeCount).fill(tracker.url));
}

function chromeEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(value) {
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
    listenerCount() {
      return listeners.size;
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
  };
}
