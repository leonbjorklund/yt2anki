import { isNonSpeechOnlyCaption, normalizeCaptionText } from "./captions.ts";
import type { CaptionCue } from "./types.ts";

const MAX_CAPTURE_CUES = 50_000;
const MAX_CAPTURE_TEXT_CHARACTERS = 5_000_000;
export const CAPTURE_END_TOLERANCE_MS = 10_000;
export const CAPTURE_RATE_LIMIT_MESSAGE =
  "YouTube blocked caption loading (HTTP 429). yt2anki stopped and did not retry. Try again later.";

export function validateCapturedCues(
  value: unknown,
  { durationMs }: { durationMs: number },
): CaptionCue[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CAPTURE_CUES ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }

  const captions: CaptionCue[] = [];
  const exactCues = new Set<string>();
  let previousStartMs = -1;
  let rawTextCharacters = 0;
  for (const candidate of value) {
    const cue = capturedCue(candidate, durationMs);
    if (!cue || cue.startMs < previousStartMs) {
      return null;
    }
    previousStartMs = cue.startMs;
    rawTextCharacters += cue.text.length;
    if (rawTextCharacters > MAX_CAPTURE_TEXT_CHARACTERS) {
      return null;
    }

    const text = normalizeCaptionText(cue.text);
    if (!text || isNonSpeechOnlyCaption(text)) {
      continue;
    }
    const key = `${cue.startMs}\0${cue.endMs}\0${text}`;
    if (!exactCues.has(key)) {
      exactCues.add(key);
      captions.push({ endMs: cue.endMs, startMs: cue.startMs, text });
    }
  }
  return captions.length > 0 ? captions : null;
}

function capturedCue(value: unknown, durationMs: number): CaptionCue | null {
  if (
    !isRecord(value) ||
    typeof value.startMs !== "number" ||
    !Number.isFinite(value.startMs) ||
    value.startMs < 0 ||
    typeof value.endMs !== "number" ||
    !Number.isFinite(value.endMs) ||
    value.endMs <= value.startMs ||
    (durationMs > 0 && value.endMs > durationMs + CAPTURE_END_TOLERANCE_MS) ||
    typeof value.text !== "string"
  ) {
    return null;
  }
  return {
    endMs: value.endMs,
    startMs: value.startMs,
    text: value.text,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
