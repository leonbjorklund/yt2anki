import { Deck, Model, Note, Package } from "ankipack";
import { unzipSync, zipSync } from "fflate";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { packageFilename } from "../domain/deck.ts";
import { escapeAnkiField } from "../domain/html.ts";
import {
  NOTE_TYPE_ID,
  NOTE_TYPE_NAME,
  PACKAGE_MTIME,
  noteGuid,
  stableNumericId,
} from "../domain/identity.ts";
import type { Draft, Segment } from "../domain/types.ts";
import {
  ANSWER_TEMPLATE,
  CARD_CSS,
  CARD_TEMPLATE_NAME,
  NOTE_FIELDS,
  QUESTION_TEMPLATE,
} from "./templates.ts";

let sqlPromise: Promise<SqlJsStatic> | null = null;

export async function buildApkg(input: {
  deckName: string;
  draft: Draft;
  segments: Segment[];
}): Promise<Uint8Array> {
  if (input.segments.length === 0) {
    throw new Error("Select at least one Segment before export.");
  }

  const SQL = await getSql();
  const model = new Model({
    css: CARD_CSS,
    fields: NOTE_FIELDS.map((name) => ({ name })),
    id: NOTE_TYPE_ID,
    name: NOTE_TYPE_NAME,
    sortFieldIndex: 0,
    templates: [
      {
        answerFormat: ANSWER_TEMPLATE,
        name: CARD_TEMPLATE_NAME,
        questionFormat: QUESTION_TEMPLATE,
      },
    ],
  });
  const deck = new Deck({
    config: null,
    id: await stableNumericId(`video-deck\0${input.draft.video.videoId}`),
    name: input.deckName.replaceAll("::", "\u001f"),
  });
  const rootDeck = new Deck({
    config: null,
    id: await stableNumericId("root-deck\0yt2anki"),
    name: "yt2anki",
  });

  for (const segment of input.segments) {
    deck.addNote(
      new Note({
        fields: [
          segment.identity,
          input.draft.video.videoId,
          Math.round(segment.startMs).toString(),
          Math.round(segment.endMs).toString(),
          escapeAnkiField(segment.target),
          escapeAnkiField(segment.translation),
        ],
        guid: noteGuid(segment.identity),
        model,
        tags: ["yt2anki"],
      }),
    );
  }

  const pkg = new Package();
  pkg.addDeck(rootDeck);
  pkg.addDeck(deck);
  const entries = unzipSync(await pkg.toUint8Array(SQL));
  const collection = entries["collection.anki2"];
  if (!collection) {
    throw new Error("Generated Anki package omitted its collection.");
  }

  const database = new SQL.Database(collection);
  try {
    database.run("UPDATE notes SET mod = ?", [PACKAGE_MTIME]);
    database.run("UPDATE cards SET mod = ?", [PACKAGE_MTIME]);
    database.run("UPDATE notetypes SET mtime_secs = ?", [PACKAGE_MTIME]);
    database.run("UPDATE templates SET mtime_secs = ?", [PACKAGE_MTIME]);
    database.run("UPDATE decks SET mtime_secs = ?", [PACKAGE_MTIME]);
    database.run("UPDATE deck_config SET mtime_secs = ?", [PACKAGE_MTIME]);
    entries["collection.anki2"] = database.export();
  } finally {
    database.close();
  }
  return zipSync(entries, { level: 0 });
}

export function downloadApkg(
  bytes: Uint8Array,
  draft: Draft,
): void {
  const blob = new Blob([new Uint8Array(bytes)], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = packageFilename(draft.video.title, draft.video.videoId);
  anchor.href = url;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs({
    locateFile: () => chrome.runtime.getURL("sql-wasm-browser.wasm"),
  });
  return sqlPromise;
}
