import assert from "node:assert/strict";
import test from "node:test";
import {
  loadDraft,
  reserveVideoDeckName,
  StaleDraftError,
  saveDraft,
  withCurrentDraft,
} from "../src/storage.ts";
import { createDraft } from "./fixtures.js";

test("reserves stable collision-safe Video Deck names atomically", async () => {
  const { restore } = installStorage();
  try {
    const [first, second] = await Promise.all([
      reserveVideoDeckName("Shared title", "abcdefghijk"),
      reserveVideoDeckName("Shared title", "different01"),
    ]);
    assert.notEqual(first, second);
    assert.ok([first, second].includes("Shared title"));
    const renamed = await reserveVideoDeckName("Changed title", "abcdefghijk");
    assert.equal(renamed, first);
  } finally {
    restore();
  }
});

test("refuses to overwrite a literal title matching a collision suffix", async () => {
  const { restore } = installStorage();
  try {
    await reserveVideoDeckName("Lesson", "owner000001");
    await reserveVideoDeckName("Lesson [abcdefghijk]", "owner000002");
    await assert.rejects(
      reserveVideoDeckName("Lesson", "abcdefghijk"),
      /already reserved both collision-safe deck names/u,
    );
  } finally {
    restore();
  }
});

test("rejects stale editor saves and exports after its Draft is replaced", async () => {
  const { restore, stored } = installStorage();
  try {
    const stale = createDraft();
    stored[`draft:${stale.video.videoId}`] = structuredClone(stale);
    stored[`draft:${stale.video.videoId}`].generationId = "new-generation";
    await assert.rejects(saveDraft(stale), StaleDraftError);
    let exported = false;
    await assert.rejects(
      withCurrentDraft(stale, async () => {
        exported = true;
      }),
      StaleDraftError,
    );
    assert.equal(exported, false);
    assert.equal(
      stored[`draft:${stale.video.videoId}`].generationId,
      "new-generation",
    );
  } finally {
    restore();
  }
});

test("loads the current Draft schema and ignores incompatible records without changing them", async () => {
  const { local, restore } = installStorage();
  try {
    const draft = createDraft();
    local["draft:abcdefghijk"] = structuredClone(draft);
    assert.deepEqual(await loadDraft("abcdefghijk"), draft);
    const incompatible = { ...draft, version: draft.version + 1 };
    local["draft:abcdefghijk"] = structuredClone(incompatible);
    assert.equal(await loadDraft("abcdefghijk"), null);
    assert.deepEqual(local["draft:abcdefghijk"], incompatible);
  } finally {
    restore();
  }
});

test("keeps package Drafts local without creating a session copy", async () => {
  const { local, restore, session } = installStorage();
  try {
    const draft = createDraft();
    local["draft:abcdefghijk"] = structuredClone(draft);
    const outcome = await withCurrentDraft(draft, async () => "package");

    assert.equal(outcome, "package");
    assert.deepEqual(local["draft:abcdefghijk"], draft);
    assert.equal(session["draft:abcdefghijk"], undefined);
  } finally {
    restore();
  }
});

test("creates no session copy when the Draft action fails", async () => {
  const { local, operations, restore, session } = installStorage();
  try {
    const draft = createDraft();
    local["draft:abcdefghijk"] = structuredClone(draft);
    await assert.rejects(
      withCurrentDraft(draft, async () => {
        throw new Error("action failed");
      }),
      /action failed/u,
    );

    assert.deepEqual(local["draft:abcdefghijk"], draft);
    assert.equal(session["draft:abcdefghijk"], undefined);
    assert.equal(
      operations.some((operation) => operation.startsWith("session.set:")),
      false,
    );
  } finally {
    restore();
  }
});

function installStorage() {
  const originalChrome = globalThis.chrome;
  const local = {};
  const session = {};
  const operations = [];
  const area = (name, stored) => ({
    async get(key) {
      return { [key]: structuredClone(stored[key]) };
    },
    async remove(key) {
      operations.push(`${name}.remove:${String(key)}`);
      delete stored[key];
    },
    async set(values) {
      operations.push(`${name}.set:${Object.keys(values).join(",")}`);
      Object.assign(stored, structuredClone(values));
    },
  });
  globalThis.chrome = {
    storage: {
      local: area("local", local),
      session: area("session", session),
    },
  };
  return {
    local,
    operations,
    restore() {
      if (originalChrome === undefined) {
        delete globalThis.chrome;
      } else {
        globalThis.chrome = originalChrome;
      }
    },
    session,
    stored: local,
  };
}
