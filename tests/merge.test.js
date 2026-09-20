import assert from "node:assert/strict";
import test from "node:test";
import { noteGuid, pinyinNoteGuid } from "../src/domain/identity.ts";
import { mergeSegments, revertSegment } from "../src/domain/merge.ts";

function segment(identity, overrides = {}) {
  return {
    identity,
    startMs: 1234,
    endMs: 2567,
    target: "First target",
    translation: "First translation",
    pinyin: "First pronunciation",
    selected: true,
    ...overrides,
  };
}

test("merge preserves exact outer bounds and joins each field separately", async () => {
  const first = segment("first");
  const second = segment("second", {
    startMs: 2701,
    endMs: 4999,
    target: "Second target",
    translation: "Second translation",
    pinyin: "Second pronunciation",
  });
  const originals = structuredClone([first, second]);
  const merged = await mergeSegments(first, second);
  assert.equal(merged.startMs, 1234);
  assert.equal(merged.endMs, 4999);
  assert.equal(merged.target, "First target Second target");
  assert.equal(merged.translation, "First translation Second translation");
  assert.equal(merged.pinyin, "First pronunciation Second pronunciation");
  assert.equal(merged.selected, true);
  assert.deepEqual([first, second], originals);
  assert.deepEqual(revertSegment(merged), originals);
});

test("single-track merge skips blank fields and keeps unchecked content excluded", async () => {
  const first = segment("first", { translation: "", pinyin: "  " });
  const second = segment("second", {
    target: "  ",
    translation: "",
    pinyin: "spoken",
    selected: false,
  });
  const merged = await mergeSegments(first, second);
  assert.equal(merged.target, first.target);
  assert.equal(merged.translation, "");
  assert.equal(merged.pinyin, "spoken");
  assert.equal(merged.selected, false);
  assert.equal((await mergeSegments(second, first)).selected, false);
});

test("nested merges retain the latest end time of overlapping sources", async () => {
  const first = segment("first", { endMs: 9123 });
  const second = segment("second", { startMs: 2701, endMs: 4999 });
  const third = segment("third", { startMs: 5600, endMs: 7891 });
  const pair = await mergeSegments(first, second);
  assert.equal(pair.startMs, first.startMs);
  assert.equal(pair.endMs, first.endMs);
  const merged = await mergeSegments(pair, third);
  assert.equal(merged.startMs, first.startMs);
  assert.equal(merged.endMs, first.endMs);
  assert.deepEqual(revertSegment(merged), [pair, third]);
  assert.deepEqual(revertSegment(pair), [first, second]);
});

test("revert restores only the latest merge and discards subsequent edits", async () => {
  const first = segment("first", { target: "Edited before merge" });
  const second = segment("second", { selected: false });
  const third = segment("third");
  const pair = await mergeSegments(first, second);
  pair.translation = "Edited before next merge";
  const originalPair = structuredClone(pair);
  const merged = await mergeSegments(pair, third);
  merged.target = "Discard this edit";
  merged.selected = true;
  pair.target = "Mutation outside snapshot";
  third.translation = "Mutation outside snapshot";
  const restored = revertSegment(merged);
  assert.deepEqual(restored[0], originalPair);
  assert.equal(restored[1].translation, "First translation");
  assert.deepEqual(revertSegment(restored[0]), [first, second]);
  restored[0].target = "Independent restored copy";
  assert.deepEqual(revertSegment(merged)[0], originalPair);
  assert.equal(revertSegment(first), null);
});

test("merged identity follows ordered original identities regardless of grouping or edits", async () => {
  const first = segment("first");
  const second = segment("second");
  const third = segment("third");
  const leftGrouped = await mergeSegments(
    await mergeSegments(first, second),
    third,
  );
  const rightGrouped = await mergeSegments(
    first,
    await mergeSegments(second, third),
  );
  assert.equal(leftGrouped.identity, rightGrouped.identity);
  const edited = await mergeSegments(
    { ...first, target: "Changed", pinyin: "Changed", selected: false },
    { ...second, translation: "Changed" },
  );
  const pair = await mergeSegments(first, second);
  assert.equal(edited.identity, pair.identity);
  assert.notEqual(pair.identity, first.identity);
  assert.notEqual(pair.identity, second.identity);
  assert.notEqual(pair.identity, leftGrouped.identity);
  assert.notEqual(pair.identity, (await mergeSegments(second, first)).identity);
  assert.match(pair.identity, /^v4_[A-Za-z0-9_-]{43}$/u);
  assert.match(noteGuid(pair.identity), /^y4a_[A-Za-z0-9_-]{22}$/u);
  assert.match(pinyinNoteGuid(pair.identity), /^y4p_[A-Za-z0-9_-]{22}$/u);
});
