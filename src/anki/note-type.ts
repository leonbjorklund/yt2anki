import { escapeAnkiField } from "../domain/html.ts";
import {
  NOTE_TYPE_ID,
  NOTE_TYPE_NAME,
  noteGuid,
  PINYIN_NOTE_TYPE_ID,
  PINYIN_NOTE_TYPE_NAME,
  pinyinNoteGuid,
} from "../domain/identity.ts";
import type { ChineseSegmentField } from "../domain/language.ts";
import { chineseSegmentField } from "../domain/language.ts";
import type { CaptionTrack, Draft, Segment } from "../domain/types.ts";
import {
  ANSWER_TEMPLATE,
  CARD_CSS,
  NOTE_FIELDS,
  PINYIN_ANSWER_TEMPLATE,
  PINYIN_CARD_CSS,
  PINYIN_NOTE_FIELDS,
} from "./templates.ts";

export interface AnkiNoteTypeDefinition {
  answerTemplate: string;
  css: string;
  fields: readonly string[];
  id: number;
  name: string;
  noteGuid: (identity: string) => string;
}

export const STANDARD_ANKI_NOTE_TYPE: AnkiNoteTypeDefinition = {
  answerTemplate: ANSWER_TEMPLATE,
  css: CARD_CSS,
  fields: NOTE_FIELDS,
  id: NOTE_TYPE_ID,
  name: NOTE_TYPE_NAME,
  noteGuid,
};

export const PINYIN_ANKI_NOTE_TYPE: AnkiNoteTypeDefinition = {
  answerTemplate: PINYIN_ANSWER_TEMPLATE,
  css: PINYIN_CARD_CSS,
  fields: PINYIN_NOTE_FIELDS,
  id: PINYIN_NOTE_TYPE_ID,
  name: PINYIN_NOTE_TYPE_NAME,
  noteGuid: pinyinNoteGuid,
};

export const ANKI_NOTE_TYPES = [
  STANDARD_ANKI_NOTE_TYPE,
  PINYIN_ANKI_NOTE_TYPE,
] as const;

export function selectAnkiNoteType(
  targetTrack: CaptionTrack,
  translationTrack: CaptionTrack | null,
): {
  chineseField: ChineseSegmentField | null;
  noteType: AnkiNoteTypeDefinition;
} {
  const chineseField = chineseSegmentField(targetTrack, translationTrack);
  return {
    chineseField,
    noteType: chineseField ? PINYIN_ANKI_NOTE_TYPE : STANDARD_ANKI_NOTE_TYPE,
  };
}

export function ankiNoteFieldValues(
  draft: Draft,
  segment: Segment,
  chineseField: ChineseSegmentField | null,
): Record<string, string> {
  const fields: Record<string, string> = {
    EndMs: Math.round(segment.endMs).toString(),
    SegmentIdentity: segment.identity,
    StartMs: Math.round(segment.startMs).toString(),
    Target: escapeAnkiField(segment.target),
    Translation: escapeAnkiField(segment.translation),
    TranslationFirst: draft.translationFirst ? "1" : "",
    VideoId: draft.video.videoId,
  };
  if (chineseField) {
    fields.Pinyin = escapeAnkiField(segment.pinyin);
    fields.PinyinUnderTranslation = chineseField === "translation" ? "1" : "";
  }
  return fields;
}
