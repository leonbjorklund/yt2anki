import {
  createDraft,
  expect,
  setExtensionStorage,
  test,
} from "./fixtures.js";

const VIDEO_ID = "abcdefghijk";
const DECK_NAME = "yt2anki::Fixture video";
const NOTE_TYPE_NAME = "yt2anki Listening v1";

test.use({ trace: "off" });

test("exports, skips an edited Note, and adds only a new Segment", async ({
  extension,
}) => {
  test.setTimeout(60_000);
  const { context, extensionId, messenger, worker } = extension;
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const firstDraft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: firstDraft,
  });
  const firstEditor = await openEditor(context, extensionId);
  await firstEditor.locator("#send-anki").click();
  await expect(firstEditor.locator("#export-status")).toHaveText(
    "1 added, 0 already existed.",
    { timeout: 30_000 },
  );

  let noteIds = await invokeAnki(messenger, "findNotes", {
    query: `note:"${NOTE_TYPE_NAME}" VideoId:${VIDEO_ID}`,
  });
  expect(noteIds).toHaveLength(1);
  await invokeAnki(messenger, "updateNoteFields", {
    note: {
      fields: { Target: "local edit" },
      id: noteIds[0],
    },
  });

  const repeatDraft = createDraft({ translation: "Hello." });
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
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: repeatDraft,
  });
  const repeatEditor = await openEditor(context, extensionId);
  await repeatEditor.locator("#send-anki").click();
  await expect(repeatEditor.locator("#export-status")).toHaveText(
    "1 added, 1 already existed.",
    { timeout: 30_000 },
  );

  noteIds = await invokeAnki(messenger, "findNotes", {
    query: `note:"${NOTE_TYPE_NAME}" VideoId:${VIDEO_ID}`,
  });
  expect(noteIds).toHaveLength(2);
  const notes = await invokeAnki(messenger, "notesInfo", {
    notes: noteIds,
  });
  const original = notes.find(
    (note) =>
      note.fields.SegmentIdentity.value ===
      firstDraft.segments[0].identity,
  );
  expect(original.fields.Target.value).toBe("local edit");

  const fields = await invokeAnki(messenger, "modelFieldNames", {
    modelName: NOTE_TYPE_NAME,
  });
  expect(fields).toEqual([
    "SegmentIdentity",
    "VideoId",
    "StartMs",
    "EndMs",
    "Target",
    "Translation",
  ]);
  const templates = await invokeAnki(messenger, "modelTemplates", {
    modelName: NOTE_TYPE_NAME,
  });
  expect(Object.keys(templates)).toEqual(["Listening"]);
  expect(templates.Listening.Front).toContain('data-autoplay="true"');
  expect(templates.Listening.Front).not.toContain("{{Target}}");
  expect(templates.Listening.Back).toContain("{{Target}}");
  expect(templates.Listening.Back).toContain("{{Translation}}");
  expect(templates.Listening.Back).toContain('data-autoplay="false"');

  const cards = await invokeAnki(messenger, "findCards", {
    query: `deck:"${DECK_NAME}" note:"${NOTE_TYPE_NAME}"`,
  });
  expect(cards).toHaveLength(2);

  await invokeAnki(messenger, "deleteDecks", {
    cardsToo: true,
    decks: [DECK_NAME],
  });
});

async function openEditor(context, extensionId) {
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#send-anki")).toBeEnabled();
  return editor;
}

async function invokeAnki(page, action, params = {}) {
  return page.evaluate(
    async ({ action, params }) => {
      const response = await fetch("http://127.0.0.1:8765", {
        body: JSON.stringify({ action, params, version: 6 }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok || body.error) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return body.result;
    },
    { action, params },
  );
}
