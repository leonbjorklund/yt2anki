import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  alignTranslationCaptions,
  buildTargetSegments,
  mergeAgreedCaptionContinuations,
} from "../src/domain/captions.ts";

// Source-derived timing and punctuation with synthetic text. This preserves
// the full-track regression where 97 events become 93 Segments without
// redistributing the original transcript.
const { chinese, english } = JSON.parse(
  await readFile(new URL("fixtures/bilingual-captions.json", import.meta.url)),
);

const EXPECTED_MERGES = [
  {
    endMs: 92_485,
    startMs: 89_318,
    target: "Sample line 30, Sample line 31.",
    translation: "示例字幕30行，示例字幕31行。",
  },
  {
    endMs: 135_350,
    startMs: 131_673,
    target: "Sample line 46, Sample line 47.",
    translation: "示例字幕46行，示例字幕47行。",
  },
  {
    endMs: 211_158,
    startMs: 207_294,
    target: "Sample line 72, Sample line 73.",
    translation: "示例字幕72行，示例字幕73行。",
  },
  {
    endMs: 224_203,
    startMs: 219_353,
    target: "Sample line 77, Sample line 78.",
    translation: "示例字幕77行，示例字幕78行。",
  },
];

for (const [name, target, translation, languageCode] of [
  ["Chinese", chinese, english, "zh-Hans"],
  ["English", english, chinese, "en-GB"],
]) {
  test(`a full caption track merges four ${name} Target pairs`, async () => {
    assert.equal(target.length, 97);
    const originals = new Set(
      target.map(({ endMs, startMs, text }) => `${startMs}\0${endMs}\0${text}`),
    );
    const merged = mergeAgreedCaptionContinuations(target, translation);
    assert.equal(merged.length, 93);

    const mergedBounds = new Set(
      merged
        .filter(
          ({ endMs, startMs, text }) =>
            !originals.has(`${startMs}\0${endMs}\0${text}`),
        )
        .map(({ endMs, startMs }) => `${startMs}\0${endMs}`),
    );
    const segments = alignTranslationCaptions(
      await buildTargetSegments({
        captions: merged,
        track: { id: `.${languageCode}`, kind: null, languageCode, name },
        videoId: "abcdefghijk",
      }),
      translation,
    );

    assert.deepEqual(
      segments
        .filter(({ endMs, startMs }) =>
          mergedBounds.has(`${startMs}\0${endMs}`),
        )
        .map(
          ({ endMs, startMs, target: mergedTarget, translation: aligned }) => ({
            endMs,
            startMs,
            target: mergedTarget,
            translation: aligned,
          }),
        ),
      // Both directions agree on the same four boundaries, with the languages
      // swapped, because an Agreed Continuation needs both tracks to match.
      EXPECTED_MERGES.map(
        ({ endMs, startMs, target: en, translation: zh }) => ({
          endMs,
          startMs,
          target: name === "English" ? en : zh,
          translation: name === "English" ? zh : en,
        }),
      ),
    );
  });
}
