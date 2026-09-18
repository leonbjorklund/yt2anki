import assert from "node:assert/strict";
import test from "node:test";
import { selectedSegmentsForExport } from "../src/anki/export-validation.ts";
import {
  alignTranslationCaptions,
  buildTargetSegments,
  mergeAgreedCaptionContinuations,
  parseJson3Captions,
} from "../src/domain/captions.ts";

test("parses precise JSON3 and removes empty, duplicate, and common sound cues", () => {
  const cues = parseJson3Captions({
    events: [
      event(0, 500, " "),
      event(500, 500, "[Music]"),
      event(700, 200, "[Musik]"),
      event(900, 100, "（笑い）"),
      event(1_000, 800, "你好。"),
      event(1_000, 800, "你好。"),
      event(2_600, 800, "可以。"),
    ],
  });

  assert.deepEqual(cues, [
    { endMs: 900, startMs: 700, text: "[Musik]" },
    { endMs: 1_000, startMs: 900, text: "（笑い）" },
    { endMs: 1_800, startMs: 1_000, text: "你好。" },
    { endMs: 3_400, startMs: 2_600, text: "可以。" },
  ]);
});

test("rejects speech events without an explicit positive duration", () => {
  for (const invalid of [
    event(1_000, 0, "Zero"),
    { segs: [{ utf8: "Missing" }], tStartMs: 1_000 },
    event(-1, 500, "Negative start"),
  ]) {
    assert.throws(
      () => parseJson3Captions({ events: [invalid] }),
      /explicit positive duration/u,
    );
  }
});

test("removes only bracketed sound cues, never the bare spoken word", () => {
  const cues = parseJson3Captions({
    events: [
      event(0, 500, "[Music]"),
      event(500, 500, "（掌声）"),
      event(1_000, 500, "音乐"),
      event(1_500, 500, "Music"),
      event(2_000, 500, "[Music"),
    ],
  });

  assert.deepEqual(cues, [
    { endMs: 1_500, startMs: 1_000, text: "音乐" },
    { endMs: 2_000, startMs: 1_500, text: "Music" },
    { endMs: 2_500, startMs: 2_000, text: "[Music" },
  ]);
});

test("strips control and zero-width characters from uploader caption text", () => {
  const cues = parseJson3Captions({
    events: [event(0, 1_000, "Separator​ and control")],
  });

  assert.deepEqual(cues, [
    { endMs: 1_000, startMs: 0, text: "Separator and control" },
  ]);
});

test("preserves punctuation, overlaps, and repeated speech as source events", () => {
  const cues = parseJson3Captions({
    events: [
      event(0, 1_000, "I really like,"),
      event(900, 600, "like this"),
      event(2_000, 500, "Yes."),
      event(3_000, 500, "Yes."),
    ],
  });

  assert.deepEqual(cues, [
    { endMs: 1_000, startMs: 0, text: "I really like," },
    { endMs: 1_500, startMs: 900, text: "like this" },
    { endMs: 2_500, startMs: 2_000, text: "Yes." },
    { endMs: 3_500, startMs: 3_000, text: "Yes." },
  ]);
});

test("collapses only explicitly marked same-interval JSON3 rolling updates", () => {
  const cues = parseJson3Captions({
    events: [
      event(0, 1_000, "I really"),
      { ...event(0, 1_000, " like this."), aAppend: 1 },
      event(900, 600, "this is separate"),
    ],
  });

  assert.deepEqual(cues, [
    { endMs: 1_000, startMs: 0, text: "I really like this." },
    { endMs: 1_500, startMs: 900, text: "this is separate" },
  ]);
});

test("builds stable selected Target-only Segments", async () => {
  const input = {
    captions: [{ endMs: 1_200, startMs: 800, text: "对。" }],
    durationMs: 2_000,
    track: track(".zh-Hans", "zh-Hans"),
    videoId: "abcdefghijk",
  };
  const [first] = await buildTargetSegments(input);
  const [second] = await buildTargetSegments(input);

  assert.equal(first.identity, second.identity);
  assert.match(first.identity, /^v4_/u);
  assert.deepEqual(
    {
      endMs: first.endMs,
      pinyin: first.pinyin,
      selected: first.selected,
      startMs: first.startMs,
      target: first.target,
      translation: first.translation,
    },
    {
      endMs: 1_200,
      pinyin: "",
      selected: true,
      startMs: 800,
      target: "对。",
      translation: "",
    },
  );
  assert.deepEqual(selectedSegmentsForExport([first]), [first]);
});

test("forms an Agreed Continuation before Translation alignment", async () => {
  const targetCaptions = [
    cue(0, 1_500, "This is Grandpa Pig's shed,"),
    cue(1_500, 3_200, "where he makes things."),
  ];
  const translationCaptions = [
    cue(0, 1_500, "这里是猪爷爷的小屋，"),
    cue(1_500, 3_200, "他在这里做东西。"),
  ];
  const mergedCaptions = mergeAgreedCaptionContinuations(
    targetCaptions,
    translationCaptions,
  );
  const segments = alignTranslationCaptions(
    await buildTargetSegments({
      captions: mergedCaptions,
      track: track(".en", "en"),
      videoId: "abcdefghijk",
    }),
    translationCaptions,
  );
  const originalSegments = await buildTargetSegments({
    captions: targetCaptions,
    track: track(".en", "en"),
    videoId: "abcdefghijk",
  });

  assert.deepEqual(mergedCaptions, [
    cue(0, 3_200, "This is Grandpa Pig's shed, where he makes things."),
  ]);
  assert.deepEqual(
    segments.map(({ endMs, startMs, target, translation }) => ({
      endMs,
      startMs,
      target,
      translation,
    })),
    [
      {
        endMs: 3_200,
        startMs: 0,
        target: "This is Grandpa Pig's shed, where he makes things.",
        translation: "这里是猪爷爷的小屋，他在这里做东西。",
      },
    ],
  );
  assert.notEqual(segments[0].identity, originalSegments[0].identity);
  assert.equal(
    segments[0].identity,
    (
      await buildTargetSegments({
        captions: mergedCaptions,
        track: track(".en", "en"),
        videoId: "abcdefghijk",
      })
    )[0].identity,
  );
});

test("joins a Simplified Chinese Target without inserting a space", () => {
  assert.deepEqual(
    mergeAgreedCaptionContinuations(
      [cue(0, 1_500, "第一圈结束了，"), cue(1_500, 3_900, "乔治在最前面。")],
      [
        cue(0, 1_500, "That's the end of lap one,"),
        cue(1_500, 3_900, "and George is in the lead."),
      ],
    ),
    [cue(0, 3_900, "第一圈结束了，乔治在最前面。")],
  );
});

test("requires exact two-track interval and comma agreement", () => {
  const target = [
    cue(0, 2_000, "这个比赛马上就要结束了，"),
    cue(2_000, 4_900, "快把电视打开。"),
  ];
  const agreeingTranslation = [
    cue(0, 2_000, "The race was almost finished,"),
    cue(2_000, 4_900, "switch it back on."),
  ];
  const cases = [
    [],
    [
      cue(0, 2_000, "The race was almost finished."),
      cue(2_000, 4_900, "Switch it back on!"),
    ],
    [
      cue(0, 2_001, "The race was almost finished,"),
      cue(2_001, 4_900, "switch it back on."),
    ],
    [...agreeingTranslation, cue(500, 4_000, "An extra overlapping event.")],
  ];

  for (const translation of cases) {
    assert.deepEqual(
      mergeAgreedCaptionContinuations(target, translation),
      target,
    );
  }

  const englishTarget = cases[1];
  assert.deepEqual(
    mergeAgreedCaptionContinuations(englishTarget, target),
    englishTarget,
  );
});

test("requires an unambiguous Target pair", () => {
  const target = [
    cue(0, 2_100, "An overlapping event."),
    cue(100, 1_000, "Clear,"),
    cue(1_000, 2_000, "continuation."),
  ];
  const translation = [cue(100, 1_000, "清楚，"), cue(1_000, 2_000, "继续。")];

  assert.deepEqual(
    mergeAgreedCaptionContinuations(target, translation),
    target,
  );
});

test("keeps long pairs and adjacent merge chains separate", () => {
  const exactLimitTarget = [
    cue(0, 3_000, "Exact limit,"),
    cue(3_000, 6_000, "pair."),
  ];
  const exactLimitTranslation = [
    cue(0, 3_000, "正好六秒，"),
    cue(3_000, 6_000, "片段。"),
  ];
  assert.deepEqual(
    mergeAgreedCaptionContinuations(exactLimitTarget, exactLimitTranslation),
    [cue(0, 6_000, "Exact limit, pair.")],
  );

  const longTarget = [cue(0, 3_000, "Long,"), cue(3_000, 6_001, "pair.")];
  const longTranslation = [
    cue(0, 3_000, "很长，"),
    cue(3_000, 6_001, "片段。"),
  ];
  assert.deepEqual(
    mergeAgreedCaptionContinuations(longTarget, longTranslation),
    longTarget,
  );

  const chainTarget = [
    cue(0, 1_000, "One,"),
    cue(1_000, 2_000, "two,"),
    cue(2_000, 3_000, "three."),
  ];
  const chainTranslation = [
    cue(0, 1_000, "一，"),
    cue(1_000, 2_000, "二，"),
    cue(2_000, 3_000, "三。"),
  ];
  assert.deepEqual(
    mergeAgreedCaptionContinuations(chainTarget, chainTranslation),
    chainTarget,
  );
});

test("does not mutate caption inputs", () => {
  const target = Object.freeze([
    Object.freeze(cue(0, 1_000, "Safe,")),
    Object.freeze(cue(1_000, 2_000, "pair.")),
  ]);
  const translation = Object.freeze([
    Object.freeze(cue(0, 1_000, "安全，")),
    Object.freeze(cue(1_000, 2_000, "组合。")),
  ]);

  assert.deepEqual(mergeAgreedCaptionContinuations(target, translation), [
    cue(0, 2_000, "Safe, pair."),
  ]);
});

test("preserves source order for non-qualifying events with equal starts", () => {
  const target = [
    cue(0, 2_000, "First source event."),
    cue(0, 1_000, "Second source event,"),
    cue(1_000, 2_000, "third source event."),
  ];
  const translation = [
    cue(0, 1_000, "第二个源事件，"),
    cue(1_000, 2_000, "第三个源事件。"),
  ];

  assert.deepEqual(
    mergeAgreedCaptionContinuations(target, translation),
    target,
  );
});

test("Target text and selection alone determine export validity", () => {
  const targetOnly = segment(0, 1_000, "Target", "");
  const translated = segment(1_000, 2_000, "Translated", "Translation");
  const unselected = {
    ...segment(2_000, 3_000, "Unselected", ""),
    selected: false,
  };
  assert.deepEqual(
    selectedSegmentsForExport([targetOnly, translated, unselected]),
    [targetOnly, translated],
  );
  assert.throws(
    () => selectedSegmentsForExport([unselected]),
    /Select at least one Segment/u,
  );
  assert.throws(
    () => selectedSegmentsForExport([segment(0, 1_000, "  ", "Translation")]),
    /Every selected Segment needs Target text/u,
  );
});

test("aligns Translation captions by timestamp overlap", () => {
  const aligned = alignTranslationCaptions(
    [segment(0, 2_000, "一。"), segment(2_000, 4_000, "二。")],
    [
      { endMs: 1_000, startMs: 0, text: "One A." },
      { endMs: 2_000, startMs: 1_000, text: "One B." },
      { endMs: 4_000, startMs: 2_000, text: "Two." },
    ],
  );

  assert.deepEqual(
    aligned.map(({ translation }) => translation),
    ["One A. One B.", "Two."],
  );
});

test("preserves repeated translated speech inside one Segment", () => {
  const [aligned] = alignTranslationCaptions(
    [segment(0, 2_000, "是，是。")],
    [
      { endMs: 1_000, startMs: 0, text: "Yes." },
      { endMs: 2_000, startMs: 1_000, text: "Yes." },
    ],
  );

  assert.equal(aligned.translation, "Yes. Yes.");
});

test("keeps partial Translation matches and leaves missing matches empty", () => {
  const aligned = alignTranslationCaptions(
    [segment(0, 2_000, "一。"), segment(3_000, 5_000, "二。")],
    [
      { endMs: 200, startMs: 0, text: "One." },
      { endMs: 2_900, startMs: 2_500, text: "Nearby but not overlapping." },
    ],
  );

  assert.deepEqual(
    aligned.map(({ translation }) => translation),
    ["One.", ""],
  );
});

test("shares an overlapping Translation cue across both Segments", () => {
  const aligned = alignTranslationCaptions(
    [segment(0, 2_000, "一。"), segment(2_000, 4_000, "二。")],
    [{ endMs: 3_000, startMs: 1_000, text: "Shared translation." }],
  );

  assert.deepEqual(
    aligned.map(({ translation }) => translation),
    ["Shared translation.", "Shared translation."],
  );
});

test("rejects non-JSON3 caption responses", () => {
  assert.throws(() => parseJson3Captions({ transcript: [] }), /valid JSON3/u);
});

function event(tStartMs, dDurationMs, utf8) {
  return { dDurationMs, segs: [{ utf8 }], tStartMs };
}

function cue(startMs, endMs, text) {
  return { endMs, startMs, text };
}

function track(id, languageCode) {
  return { id, kind: null, languageCode, name: languageCode };
}

function segment(startMs, endMs, target, translation = "") {
  return {
    endMs,
    identity: "v4_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
    pinyin: "",
    selected: true,
    startMs,
    target,
    translation,
  };
}
