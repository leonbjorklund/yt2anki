import assert from "node:assert/strict";
import test from "node:test";
import {
  alignNativeCaptions,
  buildTargetSegments,
  mergeCaptionCues,
  parseJson3Captions,
} from "../src/domain/captions.ts";

test("parses JSON3 and removes empty, repeated, and non-speech cues", () => {
  const cues = parseJson3Captions({
    events: [
      event(0, 500, " "),
      event(500, 500, "[Music]"),
      event(1_000, 800, "你好。"),
      event(1_800, 800, "你好。"),
      event(2_600, 800, "可以。"),
    ],
  });
  assert.deepEqual(cues, [
    { endMs: 1_800, startMs: 1_000, text: "你好。" },
    { endMs: 3_400, startMs: 2_600, text: "可以。" },
  ]);
});

test("merges cue fragments without inserting spaces inside Chinese", () => {
  const merged = mergeCaptionCues([
    { endMs: 700, startMs: 0, text: "你" },
    { endMs: 1_400, startMs: 700, text: "好。" },
    { endMs: 2_100, startMs: 1_400, text: "Yes." },
  ]);
  assert.deepEqual(merged, [
    { endMs: 1_400, startMs: 0, text: "你好。" },
    { endMs: 2_100, startMs: 1_400, text: "Yes." },
  ]);
});

test("deduplicates rolling text only when cue times overlap", () => {
  assert.deepEqual(
    mergeCaptionCues([
      { endMs: 1_000, startMs: 0, text: "I really like" },
      { endMs: 1_500, startMs: 500, text: "like this." },
    ]),
    [{ endMs: 1_500, startMs: 0, text: "I really like this." }],
  );

  assert.deepEqual(
    mergeCaptionCues([
      { endMs: 1_000, startMs: 0, text: "That is a format" },
      { endMs: 2_000, startMs: 1_000, text: "at odds with the rest." },
    ]),
    [
      {
        endMs: 2_000,
        startMs: 0,
        text: "That is a format at odds with the rest.",
      },
    ],
  );
});

test("splits multiple complete sentences inside one cue", () => {
  const merged = mergeCaptionCues([
    { endMs: 4_000, startMs: 0, text: "你好。再见！" },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(({ text }) => text), ["你好。", "再见！"]);
  assert.equal(merged[0].startMs, 0);
  assert.equal(merged[1].endMs, 4_000);
});

test("uses clear pauses and speaker changes as boundaries", () => {
  const merged = mergeCaptionCues([
    { endMs: 500, startMs: 0, text: "Alice: hello" },
    { endMs: 1_000, startMs: 500, text: "there" },
    { endMs: 1_600, startMs: 1_000, text: "Bob: yes" },
    { endMs: 3_000, startMs: 2_300, text: "Next thought" },
  ]);
  assert.deepEqual(merged.map(({ text }) => text), [
    "Alice: hello there",
    "Bob: yes",
    "Next thought",
  ]);
});

test("keeps unpunctuated caption runs intact beyond the soft maximum", () => {
  const merged = mergeCaptionCues([
    { endMs: 4_000, startMs: 0, text: "第一段" },
    { endMs: 8_000, startMs: 4_000, text: "第二段" },
    { endMs: 12_000, startMs: 8_000, text: "第三段" },
    { endMs: 16_000, startMs: 12_000, text: "第四段" },
    { endMs: 20_000, startMs: 16_000, text: "第五段" },
  ]);
  assert.deepEqual(
    merged.map(({ endMs, startMs }) => ({ endMs, startMs })),
    [{ endMs: 20_000, startMs: 0 }],
  );
});

test("builds padded stable Segments and keeps short replies", async () => {
  const captions = [
    { endMs: 1_200, startMs: 800, text: "对。" },
  ];
  const input = {
    captions,
    durationMs: 2_000,
    track: track(".zh-Hans", "zh-Hans"),
    videoId: "abcdefghijk",
  };
  const [first] = await buildTargetSegments(input);
  const [second] = await buildTargetSegments(input);
  assert.equal(first.identity, second.identity);
  assert.equal(first.startMs, 550);
  assert.equal(first.endMs, 1_450);
  assert.equal(first.target, "对。");
  assert.equal(first.selected, true);
});

test("aligns Native captions by overlap and flags weak or missing matches", async () => {
  const segments = await buildTargetSegments({
    captions: [
      { endMs: 2_000, startMs: 0, text: "一。" },
      { endMs: 4_000, startMs: 2_000, text: "二。" },
      { endMs: 8_000, startMs: 6_000, text: "三。" },
    ],
    durationMs: 8_000,
    track: track(".zh-Hans", "zh-Hans"),
    videoId: "abcdefghijk",
  });
  const aligned = alignNativeCaptions(segments, [
    { endMs: 2_000, startMs: 0, text: "One." },
    { endMs: 2_200, startMs: 2_050, text: "Two." },
  ]);
  assert.deepEqual(
    aligned.map(({ alignmentQuality, translation }) => ({
      alignmentQuality,
      translation,
    })),
    [
      { alignmentQuality: "matched", translation: "One." },
      { alignmentQuality: "weak", translation: "Two." },
      { alignmentQuality: "missing", translation: "" },
    ],
  );
});

test("measures Native-caption coverage as a time union", async () => {
  const [segment] = await buildTargetSegments({
    captions: [{ endMs: 1_000, startMs: 0, text: "一。" }],
    durationMs: 1_000,
    track: track(".zh-Hans", "zh-Hans"),
    videoId: "abcdefghijk",
  });
  const [aligned] = alignNativeCaptions([segment], [
    { endMs: 200, startMs: 0, text: "One" },
    { endMs: 200, startMs: 0, text: "First" },
  ]);

  assert.equal(aligned.alignmentQuality, "weak");
  assert.equal(aligned.translation, "One First");
});

test("rejects non-JSON3 caption responses", () => {
  assert.throws(
    () => parseJson3Captions({ transcript: [] }),
    /valid JSON3/u,
  );
});

function event(tStartMs, dDurationMs, utf8) {
  return { dDurationMs, segs: [{ utf8 }], tStartMs };
}

function track(id, languageCode) {
  return { id, kind: null, languageCode, name: languageCode };
}
