import { DRAFT_SCHEMA_VERSION } from "../src/domain/types.ts";

export function createDraft({
  target = "你好。",
  targetTrackName = "Chinese (Simplified)",
  title = "Fixture video",
  translation = "",
  translationTrackName = translation ? "English (United Kingdom)" : null,
  videoId = "abcdefghijk",
} = {}) {
  const identity = "v4_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  return {
    generationId: "fixture-generation",
    segments: [
      {
        endMs: 3_000,
        identity,
        pinyin: "",
        selected: true,
        startMs: 1_000,
        target,
        translation,
      },
    ],
    sourceTabId: 1,
    targetTrack: {
      id: ".zh-Hans",
      kind: null,
      languageCode: "zh-Hans",
      name: targetTrackName,
    },
    translationTrack: translationTrackName
      ? {
          id: ".en-GB",
          kind: null,
          languageCode: "en-GB",
          name: translationTrackName,
        }
      : null,
    translationFirst: false,
    version: DRAFT_SCHEMA_VERSION,
    video: {
      compatibility: {
        embeddable: true,
        hasOpus: true,
        hasVp9: true,
      },
      durationMs: 10_000,
      title,
      tracks: [],
      videoId,
    },
  };
}
