import assert from "node:assert/strict";
import test from "node:test";
import {
  ankiNoteFieldValues,
  selectAnkiNoteType,
} from "../src/anki/note-type.ts";
import { createDraft } from "./fixtures.js";

test("Anki fields escape Pinyin and mark a Chinese Translation", () => {
  const draft = createDraft({ target: "Hello.", translation: "你好。" });
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.languageCode = "zh-Hans";
  draft.segments[0].pinyin = "nǐ <hǎo>\n";

  const { chineseField } = selectAnkiNoteType(
    draft.targetTrack,
    draft.translationTrack,
  );
  assert.deepEqual(
    ankiNoteFieldValues(draft, draft.segments[0], chineseField),
    {
      EndMs: "3000",
      Pinyin: "nǐ &lt;hǎo&gt;<br>",
      PinyinUnderTranslation: "1",
      SegmentIdentity: draft.segments[0].identity,
      StartMs: "1000",
      Target: "Hello.",
      TranslationFirst: "",
      Translation: "你好。",
      VideoId: draft.video.videoId,
    },
  );
});

test("Anki fields keep the standard fields without Chinese tracks", () => {
  const draft = createDraft({ target: "Hello.", translation: "Hej." });
  draft.targetTrack.id = ".en";
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.id = ".sv";
  draft.translationTrack.languageCode = "sv";
  draft.segments[0].pinyin = "must not be exported";

  const { chineseField } = selectAnkiNoteType(
    draft.targetTrack,
    draft.translationTrack,
  );
  assert.deepEqual(
    ankiNoteFieldValues(draft, draft.segments[0], chineseField),
    {
      EndMs: "3000",
      SegmentIdentity: draft.segments[0].identity,
      StartMs: "1000",
      Target: "Hello.",
      TranslationFirst: "",
      Translation: "Hej.",
      VideoId: draft.video.videoId,
    },
  );
});
