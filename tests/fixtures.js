export function createDraft({
  target = "你好。",
  targetTrackName = "Chinese (Simplified)",
  title = "Fixture video",
  translation = "",
  videoId = "abcdefghijk",
} = {}) {
  const identity = "v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  return {
    activeSegmentIdentity: identity,
    nativeLocale: "en-GB",
    nativeTrack: null,
    segments: [
      {
        alignmentQuality: translation ? "matched" : "missing",
        endMs: 3_250,
        identity,
        selected: true,
        sourceEndMs: 3_000,
        sourceStartMs: 1_000,
        startMs: 750,
        target,
        translation,
      },
    ],
    sourceTabId: 1,
    targetLocale: "zh-Hans",
    targetTrack: {
      id: ".zh-Hans",
      kind: null,
      languageCode: "zh-Hans",
      name: targetTrackName,
    },
    version: 1,
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
