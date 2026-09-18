import {
  Collection,
  Deck,
  DeckConfig,
  Note,
  Notetype,
  Package,
} from "ankipack";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { PACKAGE_MTIME, stableNumericId } from "../domain/identity.ts";
import type { Draft, Segment } from "../domain/types.ts";
import {
  CHRONOLOGICAL_PRESET_NAME,
  sortSegmentsChronologically,
} from "./chronology.ts";
import { selectedSegmentsForExport } from "./export-validation.ts";
import { ankiNoteFieldValues, selectAnkiNoteType } from "./note-type.ts";
import { CARD_TEMPLATE_NAME, QUESTION_TEMPLATE } from "./templates.ts";

let sqlPromise: Promise<SqlJsStatic> | null = null;

export async function buildApkg(input: {
  deckName: string;
  draft: Draft;
  segments: Segment[];
}): Promise<Uint8Array> {
  const selectedSegments = selectedSegmentsForExport(input.segments);
  const { chineseField, noteType } = selectAnkiNoteType(
    input.draft.targetTrack,
    input.draft.translationTrack,
  );

  const SQL = await getSql();
  const orderedSegments = sortSegmentsChronologically(selectedSegments);
  const chronologicalConfig = new DeckConfig({
    id: await stableNumericId("deck-config\0yt2anki-chronological-v4"),
    name: CHRONOLOGICAL_PRESET_NAME,
    newCardGatherPriority: "lowestPosition",
    newCardInsertOrder: "due",
    newCardSortOrder: "noSort",
  });
  const notetype = new Notetype({
    css: noteType.css,
    fields: noteType.fields.map((name) => ({ name })),
    id: noteType.id,
    name: noteType.name,
    sortFieldIndex: 0,
    templates: [
      {
        answerFormat: noteType.answerTemplate,
        name: CARD_TEMPLATE_NAME,
        questionFormat: QUESTION_TEMPLATE,
      },
    ],
  });
  const deck = new Deck({
    config: chronologicalConfig,
    id: await stableNumericId(
      `video-deck\0yt2anki-v4\0${input.draft.video.videoId}`,
    ),
    name: input.deckName,
  });

  for (const segment of orderedSegments) {
    const fieldValues = ankiNoteFieldValues(input.draft, segment, chineseField);
    deck.addNote(
      new Note({
        fields: noteType.fields.map((name) => fieldValues[name] ?? ""),
        guid: noteType.noteGuid(segment.identity),
        notetype,
        tags: ["yt2anki"],
      }),
    );
  }

  const pkg = new Package();
  pkg.addDeck(deck);
  const collection = await pkg.toCollection();
  const positionsByGuid = new Map(
    orderedSegments.map((segment) => [
      noteType.noteGuid(segment.identity),
      Math.max(1, Math.round(segment.startMs) + 1),
    ]),
  );
  const positionsByNoteId = new Map<number, number>();

  for (const note of collection.notes) {
    const position = positionsByGuid.get(note.guid);
    if (position === undefined) {
      throw new Error("Generated Anki package contained an unexpected Note.");
    }
    note.mod = PACKAGE_MTIME;
    positionsByNoteId.set(note.id, position);
  }
  for (const card of collection.cards) {
    const position = positionsByNoteId.get(card.nid);
    if (position === undefined) {
      throw new Error("Generated Anki package contained an unexpected Card.");
    }
    card.due = position;
    card.mod = PACKAGE_MTIME;
  }
  for (const row of [...collection.decks, ...collection.deckConfig]) {
    row.mtimeSecs = PACKAGE_MTIME;
  }
  // Anki refreshes same-schema Note Types only when the package is newer.
  // Notes keep their old timestamp so default imports preserve local edits.
  const templateMtime = Math.floor(Date.now() / 1000);
  for (const row of [...collection.notetypes, ...collection.templates]) {
    row.mtimeSecs = templateMtime;
  }

  return Collection.fromData(collection).toUint8Array(SQL);
}

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: () => chrome.runtime.getURL("sql-wasm-browser.wasm"),
  });
  return sqlPromise;
}
