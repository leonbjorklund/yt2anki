import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApkg } from "../src/anki/apkg.ts";
import { createDraft } from "../tests/fixtures.js";

const ankiRoot = join(
  process.env.LOCALAPPDATA ?? "",
  "AnkiProgramFiles",
);
const python = join(ankiRoot, ".venv", "Scripts", "python.exe");
await access(python);

const root = await mkdtemp(join(tmpdir(), "yt2anki-apkg-import-"));
const firstPath = join(root, "first.apkg");
const repeatPath = join(root, "repeat.apkg");
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
  translation: "Hello.",
});
const first = await buildApkg({
  deckName: "yt2anki::Import fixture",
  draft: firstDraft,
  segments: firstDraft.segments,
});
await writeFile(firstPath, first);

const repeatDraft = structuredClone(firstDraft);
repeatDraft.segments[0].target = "packaged replacement";
repeatDraft.segments.push({
  ...repeatDraft.segments[0],
  endMs: 6_250,
  identity: "v1_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
  sourceEndMs: 6_000,
  sourceStartMs: 4_000,
  startMs: 3_750,
  target: "再见。",
  translation: "Goodbye.",
});
const repeat = await buildApkg({
  deckName: "yt2anki::Import fixture",
  draft: repeatDraft,
  segments: repeatDraft.segments,
});
await writeFile(repeatPath, repeat);

try {
  const result = spawnSync(
    python,
    [
      resolve("scripts/verify_apkg_import.py"),
      collectionPath,
      firstPath,
      repeatPath,
      firstDraft.segments[0].identity,
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
    report.first.new !== 1 ||
    report.repeat.new !== 1 ||
    report.repeat.duplicate !== 1 ||
    report.noteCount !== 2 ||
    report.cardCount !== 2 ||
    report.existingTarget !== "local edit" ||
    !report.schedulingPreserved ||
    report.noteTypeCount !== 1 ||
    report.deckCount !== 1 ||
    report.rootDeckCount !== 1 ||
    !report.cardsInVideoDeck
  ) {
    throw new Error(`Unexpected Anki import report: ${result.stdout}`);
  }
  console.log(
    "Verified final .apkg repeat import in disposable Anki 25.09.5.",
  );
} finally {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedRoot.startsWith(`${resolvedTemp}\\`)) {
    throw new Error("Refusing to remove a non-temporary integration path.");
  }
  await rm(resolvedRoot, { force: true, recursive: true });
}
