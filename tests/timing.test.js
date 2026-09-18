import assert from "node:assert/strict";
import test from "node:test";
import {
  ankiNoteFieldValues,
  selectAnkiNoteType,
} from "../src/anki/note-type.ts";
import { QUESTION_TEMPLATE } from "../src/anki/templates.ts";
import { previewPlaybackCommand } from "../src/editor/preview.ts";
import { createDraft } from "./fixtures.js";

test("editor preview and Anki Card use identical Segment bounds", () => {
  const draft = createDraft();
  const segment = draft.segments[0];
  segment.startMs = 30_591.4;
  segment.endMs = 32_421.6;

  const [{ startSeconds, endSeconds }] = previewPlaybackCommand(
    draft.video.videoId,
    segment,
  ).args;
  const { chineseField } = selectAnkiNoteType(
    draft.targetTrack,
    draft.translationTrack,
  );
  const fields = ankiNoteFieldValues(draft, segment, chineseField);

  assert.deepEqual(
    { endSeconds, startSeconds },
    {
      endSeconds: Number(fields.EndMs) / 1_000,
      startSeconds: Number(fields.StartMs) / 1_000,
    },
  );
  assert.match(QUESTION_TEMPLATE, /data-start-ms="\{\{StartMs\}\}"/u);
  assert.match(QUESTION_TEMPLATE, /data-end-ms="\{\{EndMs\}\}"/u);
});
