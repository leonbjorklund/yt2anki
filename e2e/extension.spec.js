import { unzipSync } from "fflate";
import {
  createDraft,
  expect,
  extensionMessage,
  extensionStorage,
  mockAnkiConnect,
  setExtensionStorage,
  test,
} from "./fixtures.js";

const VIDEO_ID = "abcdefghijk";

test("loads the production extension and reports unsupported pages", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await context.newPage();
  const errors = [];
  popup.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  popup.on("pageerror", (error) => errors.push(error.message));

  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  await expect(popup.locator("#status")).toHaveText(
    "Open a YouTube video to continue.",
  );
  await expect(popup.locator("#primary-action")).toBeDisabled();
  expect(errors).toEqual([]);
});

test("scopes the YouTube preview identity to extension embeds", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ body: "<html><body>Fixture preview</body></html>" }));
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );

  const popupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate(
    (url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const popup = await popupPromise;
  await expect(popup.locator("#status")).toHaveText("Manual captions found.");

  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  await popup.locator("#primary-action").click();
  const editor = await editorPromise;

  const rules = await worker.evaluate(() =>
    chrome.declarativeNetRequest.getDynamicRules(),
  );
  expect(rules).toEqual([
    {
      action: {
        requestHeaders: [
          {
            header: "Referer",
            operation: "set",
            value: `https://yt2anki.${extensionId}/`,
          },
        ],
        type: "modifyHeaders",
      },
      condition: {
        initiatorDomains: [extensionId],
        regexFilter: "^https://www\\.youtube\\.com/embed/",
        resourceTypes: ["sub_frame"],
      },
      id: 153,
      priority: 1,
    },
  ]);

  await editor.close();
  await source.close();
});

test("captures manual bilingual tracks and restores the player track", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });
  expect(inspection.ok).toBe(true);
  expect(inspection.data.video).toMatchObject({
    compatibility: {
      embeddable: true,
      hasOpus: true,
      hasVp9: true,
    },
    title: "Fixture video",
    videoId: VIDEO_ID,
  });
  expect(inspection.data.video.tracks).toHaveLength(2);

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    nativeLocale: "en-GB",
    tabId: tab.id,
    targetLocale: "zh-Hans",
    type: "generate",
  });
  const editor = await editorPromise;

  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[
    `draft:${VIDEO_ID}`
  ];
  expect(generatedDraft.segments).toHaveLength(2);
  expect(generatedDraft.segments.map((segment) => segment.translation))
    .toEqual(["Hello world.", "Goodbye."]);
  await expect(editor).toHaveURL(/editor\/editor\.html\?video=abcdefghijk/u);
  await expect(editor.locator("#selection-summary")).toHaveText(
    "2 Segments · 2 selected",
  );
  await expect(editor.locator("#language-pair")).toHaveText(
    "Chinese (Simplified) → English (United Kingdom)",
  );

  const trackState = await source.evaluate(() => ({
    current: window.__currentTrack?.vssId ?? null,
    unloadCount: window.__unloadCount,
  }));
  expect(trackState).toEqual({
    current: ".en-GB",
    unloadCount: 0,
  });
});

test("uses only the active video's distinct manual tracks after navigation", async ({
  extension,
}) => {
  const { context, extensionId, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  const currentVideoId = "lmnopqrstuv";
  await source.evaluate((videoId) => {
    const current = structuredClone(window.__fixtureResponse);
    current.videoDetails.videoId = videoId;
    current.videoDetails.title = "Current fixture";
    current.captions.playerCaptionsTracklistRenderer.captionTracks = [
      {
        ...current.captions.playerCaptionsTracklistRenderer.captionTracks[0],
        languageCode: "zh",
        name: { simpleText: "Chinese" },
        vssId: ".zh",
      },
    ];
    window.ytInitialPlayerResponse = current;
    history.replaceState({}, "", `/watch?v=${videoId}`);
  }, currentVideoId);
  await setExtensionStorage(worker, {
    settings: {
      nativeLocale: "zh",
      targetLocale: "zh-Hans",
    },
  });

  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });
  expect(inspection.ok).toBe(true);
  expect(inspection.data.video).toMatchObject({
    title: "Current fixture",
    tracks: [
      expect.objectContaining({
        languageCode: "zh",
      }),
    ],
    videoId: currentVideoId,
  });

  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );
  const popupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate(
    (url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const popup = await popupPromise;
  await expect(popup.locator("#target-locale option")).toHaveText([
    "Chinese",
  ]);
  await expect(popup.locator("#target-locale")).toHaveValue("zh");
  await expect(popup.locator("#native-locale option")).toHaveText([
    "No native captions",
  ]);
  await expect(popup.locator("#native-locale")).toHaveValue("zh");
  await expect(popup.locator("#native-locale")).toBeDisabled();
  await expect(popup.locator("#status")).toHaveText(
    "Manual Target captions found. Gemini will translate.",
  );

  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  const generation = await extensionMessage(messenger, {
    nativeLocale: "zh",
    tabId: tab.id,
    targetLocale: "zh",
    type: "generate",
  });
  const editor = await editorPromise;
  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[
    `draft:${currentVideoId}`
  ];
  expect(generatedDraft.nativeTrack).toBeNull();
  expect(
    generatedDraft.segments.every(
      (segment) => segment.translation === "",
    ),
  ).toBe(true);
  await editor.close();
});

test("preserves the Native locale when the Target locale changes", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context);
  await source.evaluate(() => {
    const current = structuredClone(window.__fixtureResponse);
    current.captions.playerCaptionsTracklistRenderer.captionTracks.push({
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr",
      languageCode: "fr",
      name: { simpleText: "French" },
      vssId: ".fr",
    });
    window.__fixtureResponse = current;
    window.__playerResponse = current;
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );

  const popupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate(
    (url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const popup = await popupPromise;
  await expect(popup.locator("#native-locale")).toHaveValue("en-GB");

  await popup.locator("#native-locale").selectOption("fr");
  await popup.locator("#target-locale").selectOption("en-GB");

  await expect(popup.locator("#native-locale")).toHaveValue("fr");
  await popup.close();
  await source.close();
});

test("uses the active watch page transcript panel response", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    transcriptPanel: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    nativeLocale: "en-GB",
    tabId: tab.id,
    targetLocale: "zh-Hans",
    type: "generate",
  });
  const editor = await editorPromise;

  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[
    `draft:${VIDEO_ID}`
  ];
  expect(generatedDraft.segments).toHaveLength(1);
  expect(generatedDraft.segments[0]).toMatchObject({
    endMs: 3_250,
    startMs: 750,
    target: "面板字幕。",
    translation: "Panel captions.",
  });
  expect(
    await source.evaluate(() => window.__currentTrack?.vssId),
  ).toBe(".en-GB");
  await editor.close();
});

test("falls back from malformed transcript-panel timing", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, {
    malformedTranscriptTime: true,
    transcriptPanel: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    nativeLocale: "en-GB",
    tabId: tab.id,
    targetLocale: "zh-Hans",
    type: "generate",
  });
  const editor = await editorPromise;

  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[
    `draft:${VIDEO_ID}`
  ];
  expect(generatedDraft.segments[0]).toMatchObject({
    endMs: 3_250,
    startMs: 750,
  });
  await editor.close();
});

test("ignores a manual caption track with no stable identity", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { missingManualTrackId: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });

  expect(inspection.ok).toBe(true);
  expect(inspection.data.video.tracks).toEqual([
    {
      id: ".en-GB",
      kind: null,
      languageCode: "en-GB",
      name: "English (United Kingdom)",
    },
  ]);
});

test("fails closed when embeddability metadata is missing", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { includeEmbedFlag: false });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });
  expect(inspection.ok).toBe(true);
  expect(inspection.data.video.compatibility.embeddable).toBe(false);
});

test("rejects capture after the Source Video tab becomes inactive", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await context.newPage();

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });
  expect(inspection).toEqual({
    error: {
      code: "TAB_UNAVAILABLE",
      message: "The Source Video tab is no longer active.",
    },
    ok: false,
  });
});

test("offers Try again after the watch-page capture contract recovers", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context, {
    brokenInitially: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), tab.id);

  const popupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate((url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`);
  const popup = await popupPromise;

  await expect(popup.locator("#primary-action")).toHaveText("Try again");
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await source.evaluate(() => {
    window.__playerResponse = window.__fixtureResponse;
  });
  await popup.locator("#primary-action").click();
  await expect(popup.locator("#status")).toHaveText(
    "Manual captions found.",
  );
  await expect(popup.locator("#primary-action")).toHaveText(
    "Generate cards",
  );
  await expect(popup.locator("#primary-action")).toBeEnabled();
});

test("autosaves edits and translates missing text with a separate secret", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  draft.segments.push({
    ...draft.segments[0],
    alignmentQuality: "matched",
    endMs: 6_250,
    identity: "v1_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    sourceEndMs: 6_000,
    sourceStartMs: 4_000,
    startMs: 3_750,
    target: "再见。",
    translation: "Goodbye.",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Preview</title>" }),
  );
  await context.route(
    "https://generativelanguage.googleapis.com/**",
    async (route) => {
      const request = route.request();
      expect(request.headers()["x-goog-api-key"]).toBe("test-gemini-key");
      expect(request.url()).not.toContain("test-gemini-key");
      const body = request.postDataJSON();
      const prompt = body.contents[0].parts[0].text;
      expect(prompt).toContain(draft.segments[0].identity);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      translations: [
                        {
                          id: draft.segments[0].identity,
                          translation: "Hello.",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    },
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#language-pair")).toHaveText(
    "Chinese (Simplified) → No native captions",
  );
  await editor.locator(".cue-button").nth(1).click();
  await expect(editor.locator("#save-state")).toHaveText("Saved");
  await editor.reload();
  await expect(editor.locator(".segment-row").nth(1)).toHaveClass(
    /active/u,
  );

  const target = editor.locator('textarea[data-field="target"]').first();
  await target.fill("你好呀。");
  await expect(editor.locator("#save-state")).toHaveText("Saved");

  await editor.locator("#gemini-key").fill("test-gemini-key");
  await editor.locator("#translate").click();
  await expect(editor.locator("#translation-status")).toHaveText(
    "Translations complete.",
  );
  await expect(
    editor.locator('textarea[data-field="translation"]').first(),
  ).toHaveValue("Hello.");

  const stored = await extensionStorage(worker);
  expect(stored[`draft:${VIDEO_ID}`].activeSegmentIdentity).toBe(
    draft.segments[1].identity,
  );
  expect(stored["secret:gemini"]).toBe("test-gemini-key");
  expect(stored[`draft:${VIDEO_ID}`].segments[0]).toMatchObject({
    target: "你好呀。",
    translation: "Hello.",
  });
  expect(JSON.stringify(stored[`draft:${VIDEO_ID}`])).not.toContain(
    "test-gemini-key",
  );
  await expect(editor.locator("#forget-gemini")).toBeVisible();
  await editor.locator("#forget-gemini").click();
  await expect(editor.locator("#gemini-panel")).toBeHidden();
  expect((await extensionStorage(worker))["secret:gemini"]).toBeUndefined();
});

test("activates a clicked Segment without reduced-motion animation", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.segments.push({
    ...draft.segments[0],
    endMs: 6_250,
    identity: "v1_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    sourceEndMs: 6_000,
    sourceStartMs: 4_000,
    startMs: 3_750,
    target: "再见。",
    translation: "Goodbye.",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await editor.addInitScript(() => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      window.__scrollBehavior = options?.behavior;
      return scrollIntoView.call(this, options);
    };
  });
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await editor
    .locator('textarea[data-field="translation"]')
    .nth(1)
    .click();
  await expect(editor.locator(".segment-row").nth(1)).toHaveClass(/active/u);
  await expect(editor.locator("#save-state")).toHaveText("Saved");
  expect(await editor.evaluate(() => window.__scrollBehavior)).toBe("auto");
  expect(
    (await extensionStorage(worker))[`draft:${VIDEO_ID}`]
      .activeSegmentIdentity,
  ).toBe(draft.segments[1].identity);

  await editor.locator("#discard").click();
  const buttonColors = await editor.evaluate(() => {
    const primary = getComputedStyle(document.querySelector("#send-anki"));
    const danger = getComputedStyle(document.querySelector("#confirm-discard"));
    return {
      danger: [danger.color, danger.backgroundColor],
      primary: [primary.color, primary.backgroundColor],
    };
  });
  expect(buttonColors).toEqual({
    danger: ["rgb(17, 19, 23)", "rgb(253, 162, 155)"],
    primary: ["rgb(17, 19, 23)", "rgb(96, 165, 250)"],
  });
  await editor.getByRole("button", { name: "Keep draft" }).click();
});

test("sends the immutable note through AnkiConnect and removes the Draft", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  let releaseAddNotes;
  const addNotesGate = new Promise((resolveGate) => {
    releaseAddNotes = resolveGate;
  });
  const actions = await mockAnkiConnect(
    context,
    async (request, response) => {
      if (request.action === "addNotes") {
        await addNotesGate;
      }
      return response;
    },
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#send-anki")).toBeEnabled();
  await editor.locator("#send-anki").click();
  await expect
    .poll(() => actions.some((request) => request.action === "addNotes"))
    .toBe(true);
  expect(
    await editor.locator("#segment-list").evaluate((element) => element.inert),
  ).toBe(true);
  await expect(editor.locator("#discard")).toBeDisabled();
  releaseAddNotes();
  await expect(editor.locator("#export-status")).toHaveText(
    "1 added, 0 already existed.",
  );

  expect(actions.map((request) => request.action)).toEqual([
    "requestPermission",
    "version",
    "modelNames",
    "createModel",
    "createDeck",
    "findNotes",
    "addNotes",
  ]);
  expect(actions.at(-1).params.notes[0]).toMatchObject({
    deckName: "yt2anki::Fixture video",
    fields: {
      EndMs: "3250",
      SegmentIdentity: draft.segments[0].identity,
      StartMs: "750",
      Target: "你好。",
      Translation: "Hello.",
      VideoId: VIDEO_ID,
    },
    modelName: "yt2anki Listening v1",
  });
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("prompts for and sends the configured AnkiConnect API key", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const requests = await mockAnkiConnect(context, (request, response) =>
    request.action === "requestPermission"
      ? {
          ...response,
          result: { permission: "granted", requireApikey: true },
        }
      : response,
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#anki-key-panel")).toBeHidden();
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#anki-key-panel")).toBeVisible();
  await expect(editor.locator("#export-status")).toHaveText(
    "Enter the API key configured in AnkiConnect, then try again.",
  );
  await expect(editor.locator("#anki-key")).toBeFocused();
  await expect(editor.locator("#save-anki-key")).toBeVisible();

  await editor.locator("#anki-key").fill("test-anki-key");
  await editor.locator("#save-anki-key").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "1 added, 0 already existed.",
  );
  expect(requests[0]).not.toHaveProperty("key");
  expect(requests[1]).not.toHaveProperty("key");
  expect(
    requests
      .slice(2)
      .every((request) => request.key === "test-anki-key"),
  ).toBe(true);
  expect((await extensionStorage(worker))["secret:anki-connect"]).toBe(
    "test-anki-key",
  );
});

test("lets the user replace a rejected stored AnkiConnect key", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
    "secret:anki-connect": "old-key",
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await mockAnkiConnect(context, (request, response) => {
    if (request.action === "requestPermission") {
      return {
        ...response,
        result: { permission: "granted", requireApikey: true },
      };
    }
    return request.key === "old-key"
      ? { error: "valid api key must be provided", result: null }
      : response;
  });

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#anki-key-panel")).toBeHidden();
  await expect(editor.locator("#forget-anki")).toBeVisible();
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "Enter the API key configured in AnkiConnect, then try again.",
  );
  await expect(editor.locator("#anki-key-panel")).toBeVisible();
  await expect(editor.locator("#forget-anki")).toBeVisible();

  await editor.locator("#forget-anki").click();
  await expect(editor.locator("#anki-key-panel")).toBeHidden();
  expect(
    (await extensionStorage(worker))["secret:anki-connect"],
  ).toBeUndefined();
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#anki-key-panel")).toBeVisible();
  await editor.locator("#anki-key").fill("new-key");
  await editor.locator("#save-anki-key").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "1 added, 0 already existed.",
  );
  expect((await extensionStorage(worker))["secret:anki-connect"]).toBe(
    "new-key",
  );
});

test("does not submit an Anki key after export becomes invalid", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  const requests = await mockAnkiConnect(context, (request, response) =>
    request.action === "requestPermission"
      ? {
          ...response,
          result: { permission: "granted", requireApikey: true },
        }
      : response,
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#anki-key-panel")).toBeVisible();
  await editor.locator('textarea[data-field="target"]').fill("");
  await expect(editor.locator("#send-anki")).toBeDisabled();
  await editor.locator("#anki-key").fill("must-not-save");
  await editor.locator("#anki-key").press("Enter");
  await editor.waitForTimeout(100);

  expect(requests).toHaveLength(1);
  expect(
    (await extensionStorage(worker))["secret:anki-connect"],
  ).toBeUndefined();
});

test("keeps the Draft after a partial AnkiConnect add", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.segments.push({
    ...draft.segments[0],
    endMs: 6_250,
    identity: "v1_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    sourceEndMs: 6_000,
    sourceStartMs: 4_000,
    startMs: 3_750,
    target: "再见。",
    translation: "Goodbye.",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await mockAnkiConnect(context, (request, response) =>
    request.action === "addNotes"
      ? { ...response, result: [123, null] }
      : response,
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "1 added before AnkiConnect stopped. The Draft was kept.",
  );
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("reports successful Anki batches before a later batch fails", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.segments = Array.from({ length: 51 }, (_value, index) => ({
    ...draft.segments[0],
    identity: `v1_${index.toString().padStart(43, "0")}`,
  }));
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  let addCalls = 0;
  await mockAnkiConnect(context, (request, response) => {
    if (request.action !== "addNotes") {
      return response;
    }
    addCalls += 1;
    return {
      ...response,
      result:
        addCalls === 1
          ? Array.from({ length: 50 }, (_value, index) => index + 1)
          : null,
    };
  });

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "50 added before AnkiConnect stopped. The Draft was kept.",
  );
  expect(addCalls).toBe(2);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("keeps the Draft after a malformed AnkiConnect add result", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.segments.push({
    ...draft.segments[0],
    endMs: 6_250,
    identity: "v1_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    sourceEndMs: 6_000,
    sourceStartMs: 4_000,
    startMs: 3_750,
    target: "再见。",
    translation: "Goodbye.",
  });
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: draft,
    "secret:anki-connect": "stored-key",
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await mockAnkiConnect(context, (request, response) =>
    request.action === "addNotes"
      ? { ...response, result: [123] }
      : response,
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "AnkiConnect returned an invalid addNotes result.",
  );
  await expect(editor.locator("#anki-key-panel")).toBeHidden();
  await expect(editor.locator("#forget-anki")).toBeVisible();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("downloads a browser-built package and removes the Draft", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor
    .locator('textarea[data-field="target"]')
    .fill("edited immediately before export");
  const downloadPromise = editor.waitForEvent("download");
  await editor.locator("#download-apkg").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const entries = unzipSync(Buffer.concat(chunks));

  expect(download.suggestedFilename()).toBe(
    "Fixture video - abcdefghijk.apkg",
  );
  expect(Object.keys(entries).sort()).toEqual(["collection.anki2", "media"]);
  await expect(editor.locator("#export-status")).toHaveText(
    "Package downloaded.",
  );
  await editor.waitForTimeout(500);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("reports autosave failure without replacing the stored Draft", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.evaluate(() => {
    chrome.storage.local.set = async () => {
      throw new Error("forced save failure");
    };
  });
  await editor
    .locator('textarea[data-field="target"]')
    .fill("unsaved edit");
  await expect(editor.locator("#save-state")).toHaveText("Save failed");

  const stored = await extensionStorage(worker);
  expect(stored[`draft:${VIDEO_ID}`].segments[0].target).toBe("你好。");
});

test("keeps a Draft after malformed Gemini output", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft(),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await context.route(
    "https://generativelanguage.googleapis.com/**",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "{not json" }] } },
          ],
        }),
      }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#gemini-key").fill("test-only");
  await editor.locator("#translate").click();
  await expect(editor.locator("#translation-status")).not.toHaveText(
    "Translations complete.",
  );
  await expect(editor.locator("#translate")).toBeEnabled();

  const stored = await extensionStorage(worker);
  expect(stored[`draft:${VIDEO_ID}`].segments[0].translation).toBe("");
});

test("requires manual repair for a missing Native-caption alignment", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  draft.nativeTrack = {
    id: ".en-GB",
    kind: null,
    languageCode: "en-GB",
    name: "English (United Kingdom)",
  };
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#gemini-panel")).toBeHidden();
  await expect(editor.locator(".row-status")).toHaveText("Needs text");
  await expect(editor.locator("#export-status")).toHaveText(
    "Every selected Segment needs Target and Translation text.",
  );
  await expect(editor.locator("#send-anki")).toBeDisabled();
  await expect(editor.locator("#download-apkg")).toBeDisabled();
});

test("blocks export when the playback preflight fails", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.video.compatibility.hasOpus = false;
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#export-status")).toHaveText(
    "Export is blocked because this video failed a playback check.",
  );
  await expect(editor.locator("#send-anki")).toBeDisabled();
  await expect(editor.locator("#download-apkg")).toBeDisabled();
});

test("requires confirmation before discarding a Draft", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#discard").click();
  await expect(editor.locator("#discard-dialog")).toBeVisible();
  await editor.getByRole("button", { name: "Keep draft" }).click();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();

  await editor.locator("#discard").click();
  await editor.locator("#confirm-discard").click();
  await expect
    .poll(async () =>
      Boolean((await extensionStorage(worker))[`draft:${VIDEO_ID}`]),
    )
    .toBe(false);
});

test("keeps the Draft and fallback when AnkiConnect is unavailable", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await context.route("http://127.0.0.1:8765/**", (route) => route.abort());

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#send-anki")).toBeEnabled();
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "AnkiConnect is unavailable. Open Anki Desktop and check the add-on.",
  );
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("keeps the Draft when AnkiConnect permission is denied", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft({ translation: "Hello." }),
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await mockAnkiConnect(
    context,
    (_request, response) => ({
      ...response,
      result: {
        permission: "denied",
        requireApikey: false,
      },
    }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await editor.locator("#send-anki").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "AnkiConnect permission was denied.",
  );
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

async function openYouTubeFixture(
  context,
  {
    brokenInitially = false,
    includeEmbedFlag = true,
    malformedTranscriptTime = false,
    missingManualTrackId = false,
    transcriptPanel = false,
  } = {},
) {
  const targetJson = {
    events: [
      {
        dDurationMs: 1_500,
        segs: [{ utf8: "你好，" }],
        tStartMs: 1_000,
      },
      {
        dDurationMs: 1_500,
        segs: [{ utf8: "世界。" }],
        tStartMs: 2_500,
      },
      {
        dDurationMs: 1_000,
        segs: [{ utf8: "再见。" }],
        tStartMs: 6_000,
      },
    ],
  };
  const nativeJson = {
    events: [
      {
        dDurationMs: 3_000,
        segs: [{ utf8: "Hello world." }],
        tStartMs: 1_000,
      },
      {
        dDurationMs: 1_000,
        segs: [{ utf8: "Goodbye." }],
        tStartMs: 6_000,
      },
    ],
  };
  const tracks = [
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hans",
      languageCode: "zh-Hans",
      name: { simpleText: "Chinese (Simplified)" },
      ...(missingManualTrackId ? {} : { vssId: ".zh-Hans" }),
    },
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-GB",
      languageCode: "en-GB",
      name: { simpleText: "English (United Kingdom)" },
      vssId: ".en-GB",
    },
  ];
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
      },
    },
    playabilityStatus: {
      ...(includeEmbedFlag ? { playableInEmbed: true } : {}),
      status: "OK",
    },
    streamingData: {
      adaptiveFormats: [
        { mimeType: 'video/webm; codecs="vp9"' },
        { mimeType: 'audio/webm; codecs="opus"' },
      ],
    },
    videoDetails: {
      lengthSeconds: "10",
      title: "Fixture video",
      videoId: VIDEO_ID,
    },
  };

  const page = await context.newPage();
  if (transcriptPanel) {
    await page.route(
      "https://www.youtube.com/youtubei/v1/get_panel**",
      (route) => {
        const language = route.request().postDataJSON().context.client.hl;
        const captions =
          language === "en-GB"
            ? [{ startMs: 1_000, text: "Panel captions." }]
            : [{ startMs: 1_000, text: "面板字幕。" }];
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            transcriptPanelResponse(captions, malformedTranscriptTime),
          ),
        });
      },
    );
  }
  await page.route("https://www.youtube.com/api/timedtext**", (route) => {
    const language = new URL(route.request().url()).searchParams.get("lang");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(language === "en-GB" ? nativeJson : targetJson),
    });
  });
  await page.route("https://www.youtube.com/watch**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <title>Fixture video - YouTube</title>
        <div id="movie_player"></div>
        <script>
          const response = ${JSON.stringify(playerResponse)};
          window.__fixtureResponse = response;
          window.__playerResponse = ${brokenInitially ? "null" : "response"};
          const player = document.querySelector("#movie_player");
          ${
            transcriptPanel
              ? `window.ytInitialData = {
                  endpoint: {
                    showEngagementPanelEndpoint: {
                      globalConfiguration: { params: "fixture-params" },
                      identifier: { tag: "PAmodern_transcript_view" }
                    }
                  }
                };
                window.ytcfg = {
                  get: (key) => ({
                    INNERTUBE_API_KEY: "fixture-key",
                    INNERTUBE_CONTEXT: {
                      client: {
                        clientVersion: "fixture-version",
                        visitorData: "fixture-visitor"
                      }
                    },
                    INNERTUBE_CONTEXT_CLIENT_NAME: 1
                  })[key]
                };`
              : ""
          }
          window.__currentTrack = response.captions
            .playerCaptionsTracklistRenderer.captionTracks[1];
          window.__unloadCount = 0;
          Object.assign(player, {
            getOptions: () => ["captions"],
            getOption: () => window.__currentTrack,
            getPlayerResponse: () => window.__playerResponse,
            loadModule: () => {},
            setOption: (_namespace, option, value) => {
              if (option !== "track") return;
              window.__currentTrack = value;
              if (value && value.baseUrl) {
                setTimeout(() => fetch(value.baseUrl + "&fmt=json3"), 0);
              }
            },
            unloadModule: () => { window.__unloadCount += 1; },
          });
        </script>`,
    }),
  );
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  return page;
}

function transcriptPanelResponse(captions, malformedTranscriptTime) {
  return {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: captions.map(({ startMs, text }) => ({
                    macroMarkersPanelItemViewModel: {
                      item: {
                        timelineItemViewModel: {
                          contentItems: [
                            {
                              transcriptSegmentViewModel: {
                                simpleText: text,
                              },
                            },
                          ],
                        },
                      },
                      onTap: {
                        innertubeCommand: {
                          watchEndpoint: {
                            startTimeSeconds: startMs / 1_000,
                          },
                        },
                      },
                    },
                  })),
                },
              },
            ],
          },
        },
      },
    },
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          {
            payload: {
              timedMarkersListSyncEntity: {
                timedListData: {
                  sections: [
                    {
                      timedSyncDataList: captions.map(({ startMs }) => ({
                        videoTimeMs: malformedTranscriptTime ? null : startMs,
                      })),
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}
