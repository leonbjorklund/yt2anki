import assert from "node:assert/strict";
import test from "node:test";
import { validateCapturedCues } from "../src/domain/capture.ts";

test("normalizes captured cues and removes exact duplicates and sound-only text", () => {
  assert.deepEqual(
    validateCapturedCues(
      [
        { endMs: 2_000, startMs: 1_000, text: " Hello\nworld " },
        { endMs: 2_000, startMs: 1_000, text: "Hello world" },
        { endMs: 3_000, startMs: 2_000, text: "[Music]" },
        { endMs: 4_000, startMs: 3_000, text: "Goodbye" },
      ],
      { durationMs: 4_000 },
    ),
    [
      { endMs: 2_000, startMs: 1_000, text: "Hello world" },
      { endMs: 4_000, startMs: 3_000, text: "Goodbye" },
    ],
  );
});

test("rejects unordered, non-finite, and out-of-bounds captured cues", () => {
  for (const cues of [
    [
      { endMs: 3_000, startMs: 2_000, text: "Later" },
      { endMs: 2_000, startMs: 1_000, text: "Earlier" },
    ],
    [{ endMs: Number.POSITIVE_INFINITY, startMs: 1_000, text: "Infinite" }],
    [{ endMs: 1_000, startMs: -1, text: "Negative" }],
    [{ endMs: 1_000, startMs: 1_000, text: "Empty interval" }],
    [{ endMs: 15_001, startMs: 5_000, text: "Past tolerance" }],
  ]) {
    assert.equal(validateCapturedCues(cues, { durationMs: 5_000 }), null);
  }
});

test("accepts a source cue that ends shortly after rounded video duration", () => {
  assert.deepEqual(
    validateCapturedCues(
      [{ endMs: 821_120, startMs: 818_000, text: "Final cue" }],
      { durationMs: 819_000 },
    ),
    [{ endMs: 821_120, startMs: 818_000, text: "Final cue" }],
  );
});

test("caps raw text before normalization and filtering", () => {
  assert.equal(
    validateCapturedCues(
      [
        { endMs: 1_000, startMs: 0, text: "OK" },
        { endMs: 2_000, startMs: 1_000, text: " ".repeat(5_000_000) },
      ],
      { durationMs: 2_000 },
    ),
    null,
  );
});

test("caps the raw cue count before removing duplicates", () => {
  const cue = { endMs: 2_000, startMs: 1_000, text: "One" };
  const cues = Array(50_000).fill(cue);
  assert.deepEqual(validateCapturedCues(cues, { durationMs: 2_000 }), [cue]);
  cues.push(cue);
  assert.equal(validateCapturedCues(cues, { durationMs: 2_000 }), null);
});
