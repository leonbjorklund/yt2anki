import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Collection } from "ankipack";
import { unzipSync } from "fflate";
import initSqlJs from "sql.js";
import { buildApkg } from "../src/anki/apkg.ts";
import { CHRONOLOGICAL_PRESET_NAME } from "../src/anki/chronology.ts";
import {
  NOTE_TYPE_ID,
  NOTE_TYPE_NAME,
  noteGuid,
  PACKAGE_MTIME,
  PINYIN_NOTE_TYPE_ID,
  PINYIN_NOTE_TYPE_NAME,
  pinyinNoteGuid,
} from "../src/domain/identity.ts";
import { createDraft } from "./fixtures.js";

const wasmPath = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
globalThis.chrome = {
  runtime: {
    getURL: () => wasmPath,
  },
};

test("builds a stable schema-v18 package without media or history", async () => {
  const startedAt = Math.floor(Date.now() / 1000);
  const draft = createDraft({
    target: "Target only",
    targetTrackName: "Chinese",
    title: "Fixture",
  });
  draft.segments[0].pinyin = "mùbiāo";
  const later = {
    ...draft.segments[0],
    endMs: 6_000,
    identity: "v4_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    startMs: 4_000,
    target: "Bilingual target",
    translation: "Bilingual translation",
    pinyin: "shuāngyǔ mùbiāo",
  };
  draft.segments.push(later);
  const first = await inspectPackage(
    await buildApkg({
      deckName: "Fixture",
      draft,
      segments: [later, draft.segments[0]],
    }),
  );
  draft.segments[0].target = "edited package text";
  const repeat = await inspectPackage(
    await buildApkg({
      deckName: "Fixture",
      draft,
      segments: draft.segments,
    }),
  );

  assert.equal(first.schemaVersion, 18);
  assert.equal(first.noteType, PINYIN_NOTE_TYPE_NAME);
  assert.equal(first.noteTypeId, PINYIN_NOTE_TYPE_ID);
  assert.deepEqual(first.noteFields, [
    "SegmentIdentity",
    "VideoId",
    "StartMs",
    "EndMs",
    "Target",
    "Translation",
    "TranslationFirst",
    "Pinyin",
    "PinyinUnderTranslation",
  ]);
  assert.equal(first.noteMod, PACKAGE_MTIME);
  assert.equal(repeat.noteMod, PACKAGE_MTIME);
  assert.deepEqual(first.metadataMtimes, [PACKAGE_MTIME]);
  assert.deepEqual(repeat.metadataMtimes, [PACKAGE_MTIME]);
  for (const exported of [first, repeat]) {
    assert.deepEqual(exported.cardTemplates, ["Listening"]);
    assert.equal(exported.templateMtimes.length, 1);
    assert.ok(exported.templateMtimes[0] >= startedAt);
    assert.ok(exported.templateMtimes[0] <= Math.floor(Date.now() / 1000));
  }
  assert.deepEqual(
    first.notes.map(({ fields, guid }) => ({ fields, guid })),
    [
      {
        fields: [
          draft.segments[0].identity,
          draft.video.videoId,
          "1000",
          "3000",
          "Target only",
          "",
          "",
          "mùbiāo",
          "",
        ],
        guid: pinyinNoteGuid(draft.segments[0].identity),
      },
      {
        fields: [
          later.identity,
          draft.video.videoId,
          "4000",
          "6000",
          "Bilingual target",
          "Bilingual translation",
          "",
          "shuāngyǔ mùbiāo",
          "",
        ],
        guid: pinyinNoteGuid(later.identity),
      },
    ],
  );
  assert.deepEqual(
    first.notes.map(({ guid }) => guid),
    repeat.notes.map(({ guid }) => guid),
  );
  assert.equal(first.revlogCount, 0);
  assert.deepEqual(first.cardOrder, [
    { due: 1_001, startMs: 1_000 },
    { due: 4_001, startMs: 4_000 },
  ]);
  assert.deepEqual(first.deckConfigs, [CHRONOLOGICAL_PRESET_NAME]);
  assert.deepEqual(first.decks, ["Fixture"]);
  assert.deepEqual(first.files.sort(), ["collection.anki21b", "media", "meta"]);
});

test("package export requires a selected Segment with Target text", async () => {
  const draft = createDraft({ translation: "Optional Translation" });
  await assert.rejects(
    buildApkg({ deckName: "Fixture", draft, segments: [] }),
    /Select at least one Segment before export\./u,
  );

  draft.segments[0].selected = false;
  await assert.rejects(
    buildApkg({ deckName: "Fixture", draft, segments: draft.segments }),
    /Select at least one Segment before export\./u,
  );

  draft.segments[0].selected = true;
  draft.segments[0].target = " \n ";
  await assert.rejects(
    buildApkg({ deckName: "Fixture", draft, segments: draft.segments }),
    /Every selected Segment needs Target text\./u,
  );
});

test("package marks Pinyin as belonging under a Chinese Translation", async () => {
  const draft = createDraft({
    target: "Hello.",
    targetTrackName: "English",
    translation: "你好。",
    translationTrackName: "Chinese (Simplified)",
  });
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.languageCode = "zh-Hans";
  draft.segments[0].pinyin = "nǐ hǎo.";

  const pkg = await inspectPackage(
    await buildApkg({
      deckName: "Fixture",
      draft,
      segments: draft.segments,
    }),
  );

  assert.deepEqual(pkg.notes[0].fields.slice(-2), ["nǐ hǎo.", "1"]);
});

test("non-Chinese package keeps the original Note Type and GUID contract", async () => {
  const draft = createDraft({
    target: "Hello.",
    targetTrackName: "English",
    translation: "Hej.",
    translationTrackName: "Swedish",
  });
  draft.targetTrack.id = ".en";
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.id = ".sv";
  draft.translationTrack.languageCode = "sv";
  draft.segments[0].pinyin = "must not be packaged";

  const pkg = await inspectPackage(
    await buildApkg({
      deckName: "Fixture",
      draft,
      segments: draft.segments,
    }),
  );

  assert.equal(pkg.noteType, NOTE_TYPE_NAME);
  assert.equal(pkg.noteTypeId, NOTE_TYPE_ID);
  assert.deepEqual(pkg.noteFields, [
    "SegmentIdentity",
    "VideoId",
    "StartMs",
    "EndMs",
    "Target",
    "Translation",
    "TranslationFirst",
  ]);
  assert.deepEqual(pkg.notes[0], {
    fields: [
      draft.segments[0].identity,
      draft.video.videoId,
      "1000",
      "3000",
      "Hello.",
      "Hej.",
      "",
    ],
    guid: noteGuid(draft.segments[0].identity),
  });
});

async function inspectPackage(bytes) {
  const entries = unzipSync(bytes);
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const collection = Collection.open(bytes, SQL).data;
  const notetype = collection.notetypes[0];
  const notes = [...collection.notes].sort((left, right) => left.id - right.id);
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const metadataMtimes = new Set([
    ...collection.notes.map(({ mod }) => mod),
    ...collection.cards.map(({ mod }) => mod),
    ...collection.decks.map(({ mtimeSecs }) => mtimeSecs),
    ...collection.deckConfig.map(({ mtimeSecs }) => mtimeSecs),
  ]);
  return {
    cardOrder: collection.cards
      .map((card) => ({
        due: card.due,
        startMs: Number(notesById.get(card.nid).flds.split("\u001f")[2]),
      }))
      .sort((left, right) => left.due - right.due),
    cardTemplates: collection.templates
      .filter(({ ntid }) => ntid === notetype.id)
      .sort((left, right) => left.ord - right.ord)
      .map(({ name }) => name),
    deckConfigs: collection.deckConfig.map(({ name }) => name).sort(),
    decks: collection.decks.map(({ name }) => name).sort(),
    files: Object.keys(entries),
    metadataMtimes: [...metadataMtimes],
    templateMtimes: [
      ...new Set([
        ...collection.notetypes.map(({ mtimeSecs }) => mtimeSecs),
        ...collection.templates.map(({ mtimeSecs }) => mtimeSecs),
      ]),
    ],
    noteFields: collection.fields
      .filter(({ ntid }) => ntid === notetype.id)
      .sort((left, right) => left.ord - right.ord)
      .map(({ name }) => name),
    noteMod: notes[0].mod,
    notes: notes.map(({ flds, guid }) => ({
      fields: flds.split("\u001f"),
      guid,
    })),
    noteType: notetype.name,
    noteTypeId: notetype.id,
    revlogCount: collection.revlog.length,
    schemaVersion: collection.col.ver,
  };
}

test("packages the chosen answer order per Note for both Note Types", async () => {
  for (const chinese of [true, false]) {
    const draft = createDraft({ translation: "Hello" });
    if (!chinese) draft.targetTrack.languageCode = "sv";
    for (const translationFirst of [false, true]) {
      draft.translationFirst = translationFirst;
      const pkg = await inspectPackage(
        await buildApkg({ deckName: "Order", draft, segments: draft.segments }),
      );
      const orderIndex = pkg.noteFields.indexOf("TranslationFirst");
      assert.ok(orderIndex >= 0);
      assert.equal(
        pkg.notes[0].fields[orderIndex],
        translationFirst ? "1" : "",
      );
      assert.equal(
        pkg.notes[0].fields[pkg.noteFields.indexOf("Target")],
        draft.segments[0].target,
      );
      assert.equal(
        pkg.notes[0].fields[pkg.noteFields.indexOf("Translation")],
        draft.segments[0].translation,
      );
    }
  }
});
