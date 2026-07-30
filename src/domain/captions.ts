import { createSegmentIdentity } from "./identity.ts";
import type {
  CaptionCue,
  CaptionTrack,
  MergedCaption,
  Segment,
} from "./types.ts";

const EDGE_PADDING_MS = 250;
const CLEAR_PAUSE_MS = 600;
const PREFERRED_MAX_MS = 10_000;
const NEAREST_ALIGNMENT_MS = 750;
const SENTENCE_END = /[.!?。！？…]["'”’」』）)\]]*$/u;
const SOFT_BOUNDARY = /[,;:，；：]["'”’」』）)\]]*$/u;
const SPEAKER_LABEL = /^(?:\[[^\]]{1,40}\]|[^:：\n]{1,24}[:：])/u;
const NON_SPEECH_ONLY =
  /^(?:[\[(（【]\s*)?(?:music|applause|laughter|laughs|cheering|silence|音乐|音樂|掌声|掌聲|笑声|笑聲|欢呼|歡呼)(?:\s*[\])）】])?[.!。！]*$/iu;
const MUSIC_NOTES_ONLY = /^[\s♪♫♬♩]+$/u;

export function parseJson3Captions(input: unknown): CaptionCue[] {
  if (!isRecord(input) || !Array.isArray(input.events)) {
    throw new Error("Caption response is not valid JSON3");
  }

  const raw = input.events
    .map((event): CaptionCue | null => {
      if (!isRecord(event) || !Array.isArray(event.segs)) {
        return null;
      }
      const startMs = finiteNumber(event.tStartMs);
      if (startMs === null) {
        return null;
      }
      const duration = Math.max(0, finiteNumber(event.dDurationMs) ?? 0);
      const text = normalizeCaptionText(
        event.segs
          .map((segment) =>
            isRecord(segment) && typeof segment.utf8 === "string"
              ? segment.utf8
              : "",
          )
          .join(""),
      );
      if (!text || isNonSpeechOnly(text)) {
        return null;
      }
      return {
        endMs: startMs + duration,
        startMs,
        text,
      };
    })
    .filter((cue): cue is CaptionCue => cue !== null)
    .sort((left, right) => left.startMs - right.startMs);

  for (let index = 0; index < raw.length; index += 1) {
    const cue = raw[index]!;
    if (cue.endMs <= cue.startMs) {
      const next = raw[index + 1];
      cue.endMs = next
        ? Math.max(cue.startMs + 1, next.startMs)
        : cue.startMs + 2_000;
    }
  }

  return raw.filter(
    (cue, index) =>
      index === 0 || cue.text !== raw[index - 1]?.text,
  );
}

export function mergeCaptionCues(cues: CaptionCue[]): MergedCaption[] {
  const pieces = cues.flatMap(splitCue);
  const merged: MergedCaption[] = [];
  let buffer: MergedCaption | null = null;
  let bufferSpeaker: string | null = null;

  const flush = () => {
    if (buffer?.text) {
      merged.push(buffer);
    }
    buffer = null;
    bufferSpeaker = null;
  };

  for (const piece of pieces) {
    const speaker = speakerLabel(piece.text);
    const gap = buffer ? piece.startMs - buffer.endMs : 0;
    const projectedDuration = buffer
      ? piece.endMs - buffer.startMs
      : 0;
    if (
      buffer &&
      (gap >= CLEAR_PAUSE_MS ||
        (speaker && bufferSpeaker && speaker !== bufferSpeaker) ||
        (projectedDuration > PREFERRED_MAX_MS &&
          (gap >= CLEAR_PAUSE_MS / 2 ||
            SOFT_BOUNDARY.test(buffer.text))))
    ) {
      flush();
    }

    if (!buffer) {
      buffer = {
        endMs: piece.endMs,
        startMs: piece.startMs,
        text: piece.text,
      };
      bufferSpeaker = speaker;
    } else {
      const rangesOverlap = piece.startMs < buffer.endMs;
      buffer.endMs = Math.max(buffer.endMs, piece.endMs);
      buffer.text = joinCaptionText(buffer.text, piece.text, rangesOverlap);
      bufferSpeaker ??= speaker;
    }

    if (piece.complete) {
      flush();
    }
  }
  flush();
  return merged;
}

export async function buildTargetSegments(input: {
  captions: MergedCaption[];
  durationMs: number;
  track: CaptionTrack;
  videoId: string;
}): Promise<Segment[]> {
  return Promise.all(
    input.captions.map(async (caption) => ({
      alignmentQuality: "missing" as const,
      endMs: Math.min(input.durationMs, caption.endMs + EDGE_PADDING_MS),
      identity: await createSegmentIdentity({
        endMs: caption.endMs,
        originalText: caption.text,
        startMs: caption.startMs,
        trackId: input.track.id,
        videoId: input.videoId,
      }),
      selected: true,
      sourceEndMs: caption.endMs,
      sourceStartMs: caption.startMs,
      startMs: Math.max(0, caption.startMs - EDGE_PADDING_MS),
      target: caption.text,
      translation: "",
    })),
  );
}

export function alignNativeCaptions(
  segments: Segment[],
  nativeCaptions: MergedCaption[],
): Segment[] {
  return segments.map((segment) => {
    const overlapping = nativeCaptions.filter(
      (caption) =>
        Math.min(segment.sourceEndMs, caption.endMs) >
        Math.max(segment.sourceStartMs, caption.startMs),
    );

    if (overlapping.length > 0) {
      const coveredMs = coveredDuration(
        segment.sourceStartMs,
        segment.sourceEndMs,
        overlapping,
      );
      const duration = Math.max(
        1,
        segment.sourceEndMs - segment.sourceStartMs,
      );
      return {
        ...segment,
        alignmentQuality:
          Math.min(1, coveredMs / duration) >= 0.35 ? "matched" : "weak",
        translation: joinUniqueCaptions(overlapping),
      };
    }

    const targetCenter =
      (segment.sourceStartMs + segment.sourceEndMs) / 2;
    const nearest = nativeCaptions
      .map((caption) => ({
        caption,
        distance: Math.abs(
          targetCenter - (caption.startMs + caption.endMs) / 2,
        ),
      }))
      .filter(({ distance }) => distance <= NEAREST_ALIGNMENT_MS)
      .sort((left, right) => left.distance - right.distance)[0];

    return nearest
      ? {
          ...segment,
          alignmentQuality: "weak" as const,
          translation: nearest.caption.text,
        }
      : segment;
  });
}

export function normalizeCaptionText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitCue(cue: CaptionCue): CaptionPiece[] {
  const boundaries: number[] = [];
  const matcher = /[.!?。！？…]+["'”’」』）)\]]*/gu;
  for (const match of cue.text.matchAll(matcher)) {
    boundaries.push((match.index ?? 0) + match[0].length);
  }
  if (boundaries.length === 0 || boundaries.at(-1) !== cue.text.length) {
    boundaries.push(cue.text.length);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    const text = cue.text.slice(cursor, boundary).trim();
    if (text) {
      parts.push(text);
    }
    cursor = boundary;
  }
  if (parts.length <= 1) {
    return [
      {
        ...cue,
        complete: SENTENCE_END.test(cue.text),
      },
    ];
  }

  const totalWeight = parts.reduce(
    (total, part) => total + Array.from(part).length,
    0,
  );
  const duration = Math.max(1, cue.endMs - cue.startMs);
  let elapsedWeight = 0;

  return parts.map((text, index) => {
    const startMs =
      cue.startMs + (duration * elapsedWeight) / totalWeight;
    elapsedWeight += Array.from(text).length;
    const endMs =
      index === parts.length - 1
        ? cue.endMs
        : cue.startMs + (duration * elapsedWeight) / totalWeight;
    return {
      complete: SENTENCE_END.test(text),
      endMs,
      startMs,
      text,
    };
  });
}

interface CaptionPiece extends CaptionCue {
  complete: boolean;
}

function joinUniqueCaptions(captions: MergedCaption[]): string {
  const unique = captions.filter(
    (caption, index, all) =>
      all.findIndex(({ text }) => text === caption.text) === index,
  );
  let result = "";
  let coveredUntil = -Infinity;
  for (const caption of unique) {
    result = joinCaptionText(
      result,
      caption.text,
      caption.startMs < coveredUntil,
    );
    coveredUntil = Math.max(coveredUntil, caption.endMs);
  }
  return result;
}

function joinCaptionText(
  left: string,
  right: string,
  rangesOverlap: boolean,
): string {
  if (!left) {
    return right;
  }
  if (!right || left === right) {
    return left;
  }

  const overlap = rangesOverlap ? longestOverlap(left, right) : 0;
  if (overlap > 0) {
    return left + right.slice(overlap);
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

function longestOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let length = max; length >= 2; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function coveredDuration(
  startMs: number,
  endMs: number,
  captions: MergedCaption[],
): number {
  const intervals = captions
    .map((caption) => ({
      endMs: Math.min(endMs, caption.endMs),
      startMs: Math.max(startMs, caption.startMs),
    }))
    .sort((left, right) => left.startMs - right.startMs);
  let coveredMs = 0;
  let coveredUntil = startMs;
  for (const interval of intervals) {
    if (interval.endMs > coveredUntil) {
      coveredMs += interval.endMs - Math.max(coveredUntil, interval.startMs);
      coveredUntil = interval.endMs;
    }
  }
  return coveredMs;
}

function isNonSpeechOnly(text: string): boolean {
  return NON_SPEECH_ONLY.test(text) || MUSIC_NOTES_ONLY.test(text);
}

function speakerLabel(text: string): string | null {
  return text.match(SPEAKER_LABEL)?.[0].toLocaleLowerCase() ?? null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
