import type { Segment } from "../domain/types.ts";

export const PLAYBACK_FAILURE_MESSAGE =
  "This Source Video cannot play in Anki.";

export function selectedSegmentsForExport(
  segments: readonly Segment[],
): Segment[] {
  const selected = segments.filter((segment) => segment.selected);
  if (selected.length === 0) {
    throw new Error("Select at least one Segment before export.");
  }
  if (selected.some((segment) => !segment.target.trim())) {
    throw new Error("Every selected Segment needs Target text.");
  }
  return selected;
}
