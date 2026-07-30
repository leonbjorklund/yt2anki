import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import initSqlJs from "sql.js";
import { buildApkg } from "../src/anki/apkg.ts";
import {
  NOTE_TYPE_NAME,
  PACKAGE_MTIME,
} from "../src/domain/identity.ts";
import { createDraft } from "./fixtures.js";

const wasmPath = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
globalThis.chrome = {
  runtime: {
    getURL: () => wasmPath,
  },
};

test("builds a stable schema-v18 package without media or history", async () => {
  const draft = createDraft({
    targetTrackName: "Chinese",
    title: "Fixture",
    translation: "Hello.",
  });
  const first = await inspectPackage(
    await buildApkg({
      deckName: "yt2anki::Fixture",
      draft,
      segments: draft.segments,
    }),
  );
  draft.segments[0].target = "edited package text";
  const repeat = await inspectPackage(
    await buildApkg({
      deckName: "yt2anki::Fixture",
      draft,
      segments: draft.segments,
    }),
  );

  assert.equal(first.schemaVersion, 18);
  assert.equal(first.noteType, NOTE_TYPE_NAME);
  assert.equal(first.noteMod, PACKAGE_MTIME);
  assert.equal(repeat.noteMod, PACKAGE_MTIME);
  assert.equal(first.guid, repeat.guid);
  assert.equal(first.revlogCount, 0);
  assert.deepEqual(first.decks, [
    "yt2anki",
    "yt2anki\u001fFixture",
  ]);
  assert.deepEqual(first.files.sort(), ["collection.anki2", "media"]);
});

async function inspectPackage(bytes) {
  const entries = unzipSync(bytes);
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(entries["collection.anki2"]);
  try {
    const note = firstRow(db, "select guid, mod from notes");
    const col = firstRow(db, "select ver from col");
    const notetype = firstRow(db, "select name from notetypes");
    const revlog = firstRow(db, "select count(*) as count from revlog");
    const decks = db.exec("select name from decks order by name")[0];
    return {
      decks: decks.values.map(([name]) => name),
      files: Object.keys(entries),
      guid: note.guid,
      noteMod: note.mod,
      noteType: notetype.name,
      revlogCount: revlog.count,
      schemaVersion: col.ver,
    };
  } finally {
    db.close();
  }
}

function firstRow(db, sql) {
  const [result] = db.exec(sql);
  return Object.fromEntries(
    result.columns.map((column, index) => [column, result.values[0][index]]),
  );
}
