import { pinyin } from "pinyin-pro";
import { chineseSegmentField } from "./language.ts";
import type { Draft } from "./types.ts";

const HAN_RUN = /\p{Script=Han}+/gu;
const HAN_CHARACTER = /\p{Script=Han}/u;

export function generateMandarinPinyin(text: string): string {
  return text.replace(HAN_RUN, (characters) =>
    // These match pinyin-pro's current defaults and are stated so a library
    // default change cannot silently alter packaged Card text.
    pinyin(characters, {
      separator: " ",
      toneSandhi: true,
      toneType: "symbol",
      type: "string",
    }),
  );
}

export function fillBlankPinyin(draft: Draft): {
  generated: number;
  kept: number;
} {
  const source = chineseSegmentField(draft.targetTrack, draft.translationTrack);
  let generated = 0;
  let kept = 0;

  for (const segment of draft.segments) {
    if (segment.mergeSources) {
      fillBlankPinyin({ ...draft, segments: segment.mergeSources });
    }
    if (segment.pinyin.trim()) {
      kept += 1;
      continue;
    }
    if (!source || !HAN_CHARACTER.test(segment[source])) {
      continue;
    }
    segment.pinyin = generateMandarinPinyin(segment[source]);
    generated += 1;
  }

  return { generated, kept };
}
