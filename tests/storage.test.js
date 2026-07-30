import assert from "node:assert/strict";
import test from "node:test";
import { rememberDeckOwner } from "../src/storage.ts";

test("serializes concurrent deck-owner updates", async () => {
  const originalChrome = globalThis.chrome;
  const stored = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(stored[key]) };
        },
        async set(values) {
          Object.assign(stored, structuredClone(values));
        },
      },
    },
  };

  try {
    await Promise.all([
      rememberDeckOwner("yt2anki::First", "first-video"),
      rememberDeckOwner("yt2anki::Second", "second-video"),
    ]);
    assert.deepEqual(stored, {
      "deck-owners": {
        "yt2anki::First": "first-video",
        "yt2anki::Second": "second-video",
      },
    });
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});
