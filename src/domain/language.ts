import type { CaptionTrack } from "./types.ts";

export type ChineseSegmentField = "target" | "translation";

export function baseLanguage(languageCode: string): string {
  try {
    return new Intl.Locale(languageCode).language;
  } catch {
    return languageCode.toLowerCase().split("-")[0] ?? languageCode;
  }
}

// pinyin-pro ships an empty traditional dictionary, so a Traditional track reads
// as Simplified and produces wrong Pinyin (我們 as "wǒ mén", 銀行 as "yín xíng").
// Offer Pinyin only where the reading is right. A bare `zh` track is treated as
// Simplified, which is how YouTube uses it.
const TRADITIONAL_REGIONS = new Set(["hk", "mo", "tw"]);

function isSimplifiedChinese(languageCode: string): boolean {
  if (baseLanguage(languageCode) !== "zh") {
    return false;
  }
  const subtags = languageCode.toLowerCase().split("-").slice(1);
  return !subtags.some(
    (subtag) => subtag === "hant" || TRADITIONAL_REGIONS.has(subtag),
  );
}

export function chineseSegmentField(
  targetTrack: CaptionTrack,
  translationTrack: CaptionTrack | null,
): ChineseSegmentField | null {
  if (isSimplifiedChinese(targetTrack.languageCode)) {
    return "target";
  }
  return translationTrack && isSimplifiedChinese(translationTrack.languageCode)
    ? "translation"
    : null;
}

export function normalizeCaptionTrackKind(value: string | null): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "" || normalized === "standard"
    ? "standard"
    : normalized;
}

export function supportedCaptionTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  return tracks.filter(
    (track) => normalizeCaptionTrackKind(track.kind) === "standard",
  );
}
