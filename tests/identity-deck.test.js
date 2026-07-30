import assert from "node:assert/strict";
import test from "node:test";
import {
  baseVideoDeckName,
  packageFilename,
  resolveVideoDeckName,
} from "../src/domain/deck.ts";
import { escapeAnkiField } from "../src/domain/html.ts";
import {
  createSegmentIdentity,
  noteGuid,
  stableNumericId,
} from "../src/domain/identity.ts";

test("Segment Identity is deterministic and independent of Draft edits", async () => {
  const source = {
    endMs: 3_000,
    originalText: "你好。",
    startMs: 1_000,
    trackId: ".zh-Hans",
    videoId: "abcdefghijk",
  };
  const identity = await createSegmentIdentity(source);
  assert.equal(await createSegmentIdentity(source), identity);
  assert.notEqual(
    await createSegmentIdentity({ ...source, startMs: 1_001 }),
    identity,
  );
  assert.match(identity, /^v1_[A-Za-z0-9_-]{43}$/u);
  assert.match(noteGuid(identity), /^y2a_[A-Za-z0-9_-]{22}$/u);
});

test("stable numeric IDs remain safe integers", async () => {
  const first = await stableNumericId("video-deck\0abcdefghijk");
  assert.equal(await stableNumericId("video-deck\0abcdefghijk"), first);
  assert.equal(Number.isSafeInteger(first), true);
  assert.notEqual(await stableNumericId("different"), first);
});

test("deck names collapse whitespace, neutralize separators, and resolve collisions", () => {
  const base = baseVideoDeckName("  Lesson ::  one  ");
  assert.equal(base, "yt2anki::Lesson - one");
  assert.equal(
    resolveVideoDeckName("Lesson :: one", "abcdefghijk", {
      [base]: "different01",
    }),
    `${base} [abcdefghijk]`,
  );
  assert.equal(
    resolveVideoDeckName("Lesson :: one", "abcdefghijk", {
      [base]: "abcdefghijk",
    }),
    base,
  );
});

test("deck title portion is at most 80 characters", () => {
  const name = baseVideoDeckName("word ".repeat(40));
  assert.ok(name.slice("yt2anki::".length).length <= 80);
});

test("title truncation preserves complete Unicode code points", () => {
  assert.equal(
    baseVideoDeckName(`${"a".repeat(79)}😀more`),
    `yt2anki::${"a".repeat(79)}😀`,
  );
  assert.equal(
    packageFilename(`${"b".repeat(69)}😀more`, "abcdefghijk"),
    `${"b".repeat(69)}😀 - abcdefghijk.apkg`,
  );
});

test("package filenames remove Windows-reserved characters", () => {
  assert.equal(
    packageFilename('A <bad>: "title"?', "abcdefghijk"),
    "A bad title - abcdefghijk.apkg",
  );
});

test("Anki fields are escaped as plain text", () => {
  assert.equal(
    escapeAnkiField("<b>A&B</b>\nnext"),
    "&lt;b&gt;A&amp;B&lt;/b&gt;<br>next",
  );
});
