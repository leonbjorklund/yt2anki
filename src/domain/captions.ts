import { createSegmentIdentity } from "./identity.ts";
import type { CaptionCue, CaptionTrack, Segment } from "./types.ts";

const MAX_AGREED_CONTINUATION_MS = 6_000;
const CONTINUATION_COMMA = /[,，]\s*$/u;
// Brackets are required. Uploaders mark sound cues as "[Music]"; the bare word
// is ordinary speech and deleting it would silently drop a Segment.
const NON_SPEECH_ONLY =
  /^[[(（【]\s*(?:music|applause|laughter|laughs|cheering|silence|音乐|音樂|掌声|掌聲|笑声|笑聲|欢呼|歡呼)\s*[\])）】][.!。！]*$/iu;
const MUSIC_NOTES_ONLY = /^[\s♪♫♬♩]+$/u;
// Built from a string so the escapes survive formatting. Written as literal
// characters these are invisible in a diff, and a stray edit would silently
// change which ones get stripped. Bidi marks are deliberately absent: removing
// them would reorder right-to-left caption text.
// biome-ignore lint/complexity/useRegexLiterals: the formatter rewrites the escapes in a literal into raw invisible characters.
const ZERO_WIDTH = new RegExp("[\u200b-\u200d\u2060\ufeff]", "gu");

interface ParsedCaptionCue extends CaptionCue {
  append: boolean;
}

export function parseJson3Captions(input: unknown): CaptionCue[] {
  if (!isRecord(input) || !Array.isArray(input.events)) {
    throw new Error("Caption response is not valid JSON3");
  }

  const parsedCues = input.events
    .map((event): ParsedCaptionCue | null => {
      if (!isRecord(event) || !Array.isArray(event.segs)) {
        return null;
      }
      const startMs = finiteNumber(event.tStartMs);
      const text = normalizeCaptionText(
        event.segs
          .map((segment) =>
            isRecord(segment) && typeof segment.utf8 === "string"
              ? segment.utf8
              : "",
          )
          .join(""),
      );
      if (!text || isNonSpeechOnlyCaption(text)) {
        return null;
      }
      const durationMs = finiteNumber(event.dDurationMs);
      if (
        startMs === null ||
        startMs < 0 ||
        durationMs === null ||
        durationMs <= 0
      ) {
        throw new Error(
          "Precise caption speech events need a non-negative start and explicit positive duration",
        );
      }
      return {
        append: event.aAppend === 1,
        endMs: startMs + durationMs,
        startMs,
        text,
      };
    })
    .filter((cue): cue is ParsedCaptionCue => cue !== null)
    .sort((left, right) => left.startMs - right.startMs);

  const cues: CaptionCue[] = [];
  const exactCues = new Set<string>();
  for (const cue of parsedCues) {
    const previous = cues.at(-1);
    if (
      cue.append &&
      previous &&
      cue.startMs === previous.startMs &&
      cue.endMs === previous.endMs
    ) {
      previous.text = joinCaptionText(previous.text, cue.text);
      exactCues.add(cueKey(previous));
      continue;
    }
    const key = cueKey(cue);
    if (exactCues.has(key)) {
      continue;
    }
    exactCues.add(key);
    cues.push({ endMs: cue.endMs, startMs: cue.startMs, text: cue.text });
  }
  return cues;
}

function cueKey(cue: CaptionCue): string {
  return `${cue.startMs}\0${cue.endMs}\0${cue.text}`;
}

export function mergeAgreedCaptionContinuations(
  targetCaptions: readonly CaptionCue[],
  translationCaptions: readonly CaptionCue[],
): CaptionCue[] {
  // Sorted so the overlap scans below can stop early. Capture already emits
  // ascending cues, so this is a no-op for every production caller.
  const targets = targetCaptions
    .map((caption) => ({ ...caption }))
    .sort(byStartMs);
  const translations = translationCaptions
    .map((caption) => ({ ...caption }))
    .sort(byStartMs);
  const agreedBoundaries = targets
    .slice(0, -1)
    .map((left, index) =>
      isAgreedContinuationBoundary(
        targets,
        translations,
        left,
        targets[index + 1],
      ),
    );
  const merged: CaptionCue[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const isolated =
      agreedBoundaries[index] === true &&
      agreedBoundaries[index - 1] !== true &&
      agreedBoundaries[index + 1] !== true;
    if (!isolated) {
      const caption = targets[index];
      if (caption) {
        merged.push(caption);
      }
      continue;
    }

    const left = targets[index];
    const right = targets[index + 1];
    if (!left || !right) {
      continue;
    }
    merged.push({
      endMs: right.endMs,
      startMs: left.startMs,
      text: joinCaptionText(left.text, right.text),
    });
    index += 1;
  }

  return merged;
}

function isAgreedContinuationBoundary(
  targets: readonly CaptionCue[],
  translations: readonly CaptionCue[],
  left: CaptionCue,
  right: CaptionCue | undefined,
): boolean {
  if (
    !right ||
    left.endMs !== right.startMs ||
    right.endMs - left.startMs > MAX_AGREED_CONTINUATION_MS ||
    !CONTINUATION_COMMA.test(left.text)
  ) {
    return false;
  }

  const overlappingTargets = positivelyOverlappingCaptions(
    targets,
    left.startMs,
    right.endMs,
  );
  if (
    overlappingTargets.length !== 2 ||
    overlappingTargets[0] !== left ||
    overlappingTargets[1] !== right
  ) {
    return false;
  }

  const overlappingTranslations = positivelyOverlappingCaptions(
    translations,
    left.startMs,
    right.endMs,
  );
  const translationLeft = overlappingTranslations[0];
  const translationRight = overlappingTranslations[1];
  return (
    overlappingTranslations.length === 2 &&
    translationLeft?.startMs === left.startMs &&
    translationLeft.endMs === left.endMs &&
    translationRight?.startMs === right.startMs &&
    translationRight.endMs === right.endMs &&
    CONTINUATION_COMMA.test(translationLeft.text)
  );
}

// Captions ascend by startMs, so the scan can stop at the first one that starts
// at or after the window. Without the break this is quadratic in cue count.
function positivelyOverlappingCaptions(
  captions: readonly CaptionCue[],
  startMs: number,
  endMs: number,
): CaptionCue[] {
  const overlapping: CaptionCue[] = [];
  for (const caption of captions) {
    if (caption.startMs >= endMs) {
      break;
    }
    if (overlapDuration(startMs, endMs, caption.startMs, caption.endMs) > 0) {
      overlapping.push(caption);
    }
  }
  return overlapping;
}

export async function buildTargetSegments(input: {
  captions: CaptionCue[];
  track: CaptionTrack;
  videoId: string;
}): Promise<Segment[]> {
  return Promise.all(
    input.captions.map(async (caption) => ({
      endMs: caption.endMs,
      identity: await createSegmentIdentity({
        endMs: caption.endMs,
        originalText: caption.text,
        startMs: caption.startMs,
        trackId: input.track.id,
        videoId: input.videoId,
      }),
      pinyin: "",
      selected: true,
      startMs: caption.startMs,
      target: caption.text,
      translation: "",
    })),
  );
}

export function alignTranslationCaptions(
  segments: Segment[],
  translationCaptions: CaptionCue[],
): Segment[] {
  const orderedCaptions = translationCaptions.slice().sort(byStartMs);
  const overlapsBySegment = segments.map(() => [] as CaptionCue[]);

  // Walking Segments in start order lets each caption skip the Segments that
  // already ended and stop at the first one starting past it. Scanning every
  // Segment for every caption is quadratic and stalls the worker on long videos.
  const byStart = segments
    .map((segment, index) => ({ ...segment, index }))
    .sort(byStartMs);
  let firstCandidate = 0;
  for (const caption of orderedCaptions) {
    while (
      firstCandidate < byStart.length &&
      (byStart[firstCandidate]?.endMs ?? 0) <= caption.startMs
    ) {
      firstCandidate += 1;
    }
    for (
      let position = firstCandidate;
      position < byStart.length;
      position += 1
    ) {
      const segment = byStart[position];
      if (!segment || segment.startMs >= caption.endMs) {
        break;
      }
      if (
        overlapDuration(
          segment.startMs,
          segment.endMs,
          caption.startMs,
          caption.endMs,
        ) > 0
      ) {
        overlapsBySegment[segment.index]?.push(caption);
      }
    }
  }

  return segments.map((segment, index) => {
    const captions = overlapsBySegment[index] ?? [];
    return {
      ...segment,
      translation: joinCaptions(captions),
    };
  });
}

export function normalizeCaptionText(value: string): string {
  // Whitespace collapses first so tabs and newlines become spaces. Whatever
  // control characters survive that are dropped: U+001F separates Anki fields,
  // so uploader text must never carry one into a packaged Note.
  return value
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

function joinCaptions(captions: CaptionCue[]): string {
  let text = "";
  for (const caption of captions) {
    text = joinCaptionText(text, caption.text);
  }
  return text;
}

function joinCaptionText(left: string, right: string): string {
  if (!left) {
    return right;
  }

  const needsSpace =
    !/\s$/u.test(left) &&
    !/^\s/u.test(right) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left) &&
    !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana},.!?，。！？；;：:]/u.test(
      right,
    );
  return `${left}${needsSpace ? " " : ""}${right}`;
}

function byStartMs(
  left: { startMs: number },
  right: { startMs: number },
): number {
  return left.startMs - right.startMs;
}

function overlapDuration(
  leftStartMs: number,
  leftEndMs: number,
  rightStartMs: number,
  rightEndMs: number,
): number {
  return Math.max(
    0,
    Math.min(leftEndMs, rightEndMs) - Math.max(leftStartMs, rightStartMs),
  );
}

export function isNonSpeechOnlyCaption(text: string): boolean {
  return NON_SPEECH_ONLY.test(text) || MUSIC_NOTES_ONLY.test(text);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
