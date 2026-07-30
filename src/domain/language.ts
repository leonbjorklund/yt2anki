import type { CaptionTrack } from "./types.ts";

export type TrackMatch =
  | { status: "ambiguous"; tracks: CaptionTrack[] }
  | { status: "matched"; track: CaptionTrack }
  | { status: "missing" };

export function manualTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  return tracks.filter((track) => track.kind?.toLowerCase() !== "asr");
}

export function matchManualTrack(
  tracks: CaptionTrack[],
  requestedLocale: string,
): TrackMatch {
  const candidates = manualTracks(tracks);
  const requested = parseLocale(requestedLocale);
  if (!requested) {
    return { status: "missing" };
  }

  const exact = candidates.filter(
    (track) => canonicalLocale(track.languageCode) === requested.canonical,
  );
  if (exact.length === 1) {
    return { status: "matched", track: exact[0]! };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", tracks: exact };
  }

  const compatible = candidates.filter((track) => {
    const candidate = parseLocale(track.languageCode);
    return (
      candidate?.language === requested.language &&
      scriptsAreCompatible(requested.script, candidate.script)
    );
  });

  if (compatible.length === 1) {
    return { status: "matched", track: compatible[0]! };
  }
  if (compatible.length > 1) {
    return { status: "ambiguous", tracks: compatible };
  }
  return { status: "missing" };
}

export function canonicalLocale(locale: string): string | null {
  return parseLocale(locale)?.canonical ?? null;
}

interface ParsedLocale {
  canonical: string;
  language: string;
  script: string | null;
}

function parseLocale(locale: string): ParsedLocale | null {
  try {
    const parsed = new Intl.Locale(locale);
    return {
      canonical: parsed.toString(),
      language: parsed.language,
      script: effectiveScript(parsed),
    };
  } catch {
    return null;
  }
}

function effectiveScript(locale: Intl.Locale): string | null {
  if (locale.script) {
    return locale.script;
  }
  if (locale.language !== "zh") {
    return null;
  }

  const region = locale.region?.toUpperCase();
  if (region === "CN" || region === "SG") {
    return "Hans";
  }
  if (region === "HK" || region === "MO" || region === "TW") {
    return "Hant";
  }
  return null;
}

function scriptsAreCompatible(
  requested: string | null,
  candidate: string | null,
): boolean {
  return !requested || !candidate || requested === candidate;
}
