import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Collection } from "ankipack";
import initSqlJs from "sql.js";
import { buildApkg } from "../../src/anki/apkg.ts";
import { ANKI_NOTE_TYPES } from "../../src/anki/note-type.ts";
import { QUESTION_TEMPLATE } from "../../src/anki/templates.ts";
import { createDraft } from "../fixtures.js";

const ankiRoot = join(process.env.LOCALAPPDATA ?? "", "AnkiProgramFiles");
const python = join(ankiRoot, ".venv", "Scripts", "python.exe");
await access(python);

const root = await mkdtemp(join(tmpdir(), "yt2anki-apkg-import-"));
const firstPath = join(root, "first.apkg");
const repeatPath = join(root, "repeat.apkg");
const standardPath = join(root, "standard.apkg");
const expectedPath = join(root, "expected.json");
const collectionPath = join(root, "collection.anki2");
const wasmPath = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
globalThis.chrome = {
  runtime: {
    getURL: () => wasmPath,
  },
};

const firstDraft = createDraft({
  target: "packaged original",
  title: "Import fixture",
  translation: "",
});
firstDraft.translationFirst = true;
firstDraft.segments[0].pinyin = "packaged original pinyin";
firstDraft.segments.push({
  ...firstDraft.segments[0],
  endMs: 10_000,
  identity: "v4_CBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
  startMs: 8_000,
  target: "晚安。",
  translation: "Good night.",
  pinyin: "wǎn'ān.",
});
const pinyinType = ANKI_NOTE_TYPES[1];
const currentPinyin = {
  css: pinyinType.css,
  answerTemplate: pinyinType.answerTemplate,
};
pinyinType.css = ".card { background: #292929; font-size: 48px; }";
pinyinType.answerTemplate =
  "<div>{{Translation}}</div><div>{{Target}}</div>{{#Pinyin}}<small>{{Pinyin}}</small>{{/Pinyin}}";
const first = await buildApkg({
  deckName: "Import fixture",
  draft: firstDraft,
  segments: firstDraft.segments,
});
Object.assign(pinyinType, currentPinyin);
const SQL = await initSqlJs({ locateFile: () => wasmPath });
const initialCollection = Collection.open(first, SQL).data;
for (const type of initialCollection.notetypes) {
  type.mtimeSecs -= 1;
}
for (const template of initialCollection.templates) {
  template.mtimeSecs -= 1;
}
// Seed an older presentation without depending on package build timing.
await writeFile(
  firstPath,
  await Collection.fromData(initialCollection).toUint8Array(SQL),
);
await writeFile(
  expectedPath,
  JSON.stringify(
    ANKI_NOTE_TYPES.map((type) => ({
      name: type.name,
      css: type.css,
      front: QUESTION_TEMPLATE,
      back: type.answerTemplate,
    })),
  ),
);

const repeatDraft = structuredClone(firstDraft);
repeatDraft.segments[0].target = "packaged replacement";
repeatDraft.segments[0].pinyin = "packaged replacement pinyin";
repeatDraft.segments.push({
  ...repeatDraft.segments[0],
  endMs: 6_000,
  identity: "v4_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
  startMs: 4_000,
  target: "再见。",
  translation: "Goodbye.",
  pinyin: "zàijiàn.",
});
const repeat = await buildApkg({
  deckName: "Import fixture",
  draft: repeatDraft,
  segments: repeatDraft.segments,
});
await writeFile(repeatPath, repeat);

const standardDraft = createDraft({
  target: "standard original",
  targetTrackName: "English",
  title: "Import fixture",
  translation: "standard translation",
  translationTrackName: "Swedish",
});
standardDraft.translationFirst = true;
standardDraft.targetTrack.id = ".en";
standardDraft.targetTrack.languageCode = "en";
standardDraft.translationTrack.id = ".sv";
standardDraft.translationTrack.languageCode = "sv";
standardDraft.segments[0].identity = firstDraft.segments[0].identity;
standardDraft.segments[0].pinyin = "must not be packaged";
const standard = await buildApkg({
  deckName: "Import fixture",
  draft: standardDraft,
  segments: standardDraft.segments,
});
await writeFile(standardPath, standard);

try {
  const result = spawnSync(
    python,
    [
      resolve("tests/integration/verify_apkg_import.py"),
      collectionPath,
      firstPath,
      repeatPath,
      firstDraft.segments[0].identity,
      standardPath,
      expectedPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        "Disposable Anki package import failed.",
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const report = JSON.parse(result.stdout);
  if (
    report.first.new !== 2 ||
    report.repeat.new !== 1 ||
    report.repeat.duplicate !== 2 ||
    report.noteCount !== 3 ||
    report.cardCount !== 3 ||
    report.existingTarget !== "local edit" ||
    report.existingPinyin !== "local pinyin edit" ||
    report.existingPinyinUnderTranslation !== "1" ||
    JSON.stringify(report.answerFields) !==
      JSON.stringify([
        [1_000, "local edit", "", "local pinyin edit", "1"],
        [4_000, "再见。", "Goodbye.", "zàijiàn.", ""],
        [8_000, "晚安。", "Good night.", "wǎn&#39;ān.", ""],
      ]) ||
    !report.targetOnlyOmitsTranslation ||
    !report.pinyinPreservedAndRendered ||
    !report.bilingualAnswerOrder ||
    !report.schedulingPreserved ||
    report.noteTypeCount !== 1 ||
    report.standard.first.new !== 1 ||
    report.standard.repeat.duplicate !== 1 ||
    report.standard.repeat.new !== 0 ||
    report.standard.noteCount !== 1 ||
    report.standard.fieldCount !== 7 ||
    report.standard.target !== "standard original" ||
    report.standard.hasPinyinFields ||
    JSON.stringify(report.ownedNoteTypeNames) !==
      JSON.stringify(["yt2anki", "yt2anki-pinyin"]) ||
    report.suffixedNoteTypeCount !== 0 ||
    report.deckCount !== 1 ||
    report.rootDeckCount !== 0 ||
    !report.cardsInVideoDeck ||
    !report.chronologicalNewCards ||
    !report.chronologicalPreset ||
    report.chronologicalPresetCount !== 1 ||
    report.defaultImport.deckConfigName !== "Default" ||
    report.defaultImport.chronologicalPresetCount !== 0 ||
    JSON.stringify(report.defaultImport.newCardPositions) !==
      JSON.stringify([
        [1_000, 1_001],
        [4_000, 4_001],
        [8_000, 8_001],
      ])
  ) {
    throw new Error(`Unexpected Anki import report: ${result.stdout}`);
  }
  console.log("Verified final .apkg repeat import in disposable Anki 25.09.5.");
} finally {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedRoot.startsWith(`${resolvedTemp}\\`)) {
    // biome-ignore lint/correctness/noUnsafeFinally: refusing to delete a non-disposable path must fail loudly even when the run already failed.
    throw new Error("Refusing to remove a non-temporary integration path.");
  }
  await rm(resolvedRoot, { force: true, recursive: true });
}
