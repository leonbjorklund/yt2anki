import type { Segment } from "../domain/types.ts";

export const CHRONOLOGICAL_PRESET_NAME = "yt2anki";

export function sortSegmentsChronologically(
  segments: readonly Segment[],
): Segment[] {
  return [...segments].sort(compareSegments);
}

function compareSegments(left: Segment, right: Segment): number {
  if (left.startMs !== right.startMs) {
    return left.startMs - right.startMs;
  }
  if (left.endMs !== right.endMs) {
    return left.endMs - right.endMs;
  }
  // Code-unit order, not localeCompare: collation varies with the runtime's ICU
  // data, and packages must order identically wherever they are built.
  if (left.identity === right.identity) {
    return 0;
  }
  return left.identity < right.identity ? -1 : 1;
}
