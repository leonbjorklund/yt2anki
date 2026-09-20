import type { Segment } from "./types.ts";

export async function mergeSegments(
  first: Segment,
  second: Segment,
): Promise<Segment> {
  const mergeSources: [Segment, Segment] = structuredClone([first, second]);
  const [left, right] = mergeSources;
  const identities: string[] = [];
  const pending = [right, left];
  while (pending.length > 0) {
    const segment = pending.pop();
    if (!segment) break;
    if (segment.mergeSources) {
      pending.push(segment.mergeSources[1], segment.mergeSources[0]);
    } else {
      identities.push(segment.identity);
    }
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify(["yt2anki-merge-v1", ...identities]),
      ),
    ),
  );
  const identity = `v4_${btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
  return {
    endMs: Math.max(left.endMs, right.endMs),
    identity,
    mergeSources,
    pinyin: joinText(left.pinyin, right.pinyin),
    selected: left.selected && right.selected,
    startMs: left.startMs,
    target: joinText(left.target, right.target),
    translation: joinText(left.translation, right.translation),
  };
}

export function revertSegment(segment: Segment): [Segment, Segment] | null {
  return segment.mergeSources ? structuredClone(segment.mergeSources) : null;
}

function joinText(first: string, second: string): string {
  return [first.trim(), second.trim()].filter(Boolean).join(" ");
}
