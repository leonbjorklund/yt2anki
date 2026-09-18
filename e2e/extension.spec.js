import { unzipSync } from "fflate";
import { DRAFT_SCHEMA_VERSION } from "../src/domain/types.ts";
import { APP_PROTOCOL_VERSION } from "../src/popup-recovery.ts";
import {
  createDraft,
  expect,
  extensionMessage,
  extensionStorage,
  previewPlayerFixture,
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

  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#primary-action")).toHaveText(
    "Open a YouTube video",
  );
  await expect(popup.locator("#download-apkg")).toBeHidden();
  await expect(popup.locator("#primary-action")).toBeDisabled();
  await expect(popup.locator("#primary-action svg")).toBeHidden();
  expect(errors).toEqual([]);
});

test("popup keeps its header, actions, and focus rings inside 360px", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
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
  await popup.setViewportSize({ width: 360, height: 720 });
  await popup.emulateMedia({ colorScheme: "dark" });
  await expect(popup.locator("#download-apkg")).toBeEnabled();
  await expect(popup.locator("main")).toHaveCSS("padding", "16px");

  const layout = await popup.evaluate(() => {
    const rect = (selector) =>
      document.querySelector(selector).getBoundingClientRect();
    const logo = rect("header img");
    const heading = rect("#heading");
    const preview = rect("#primary-action");
    const download = rect("#download-apkg");
    const label = rect("#primary-action-label");
    const icon = rect("#primary-action svg");
    return {
      actionHeights: [preview.height, download.height],
      actionsShareRow: download.y === preview.y,
      downloadAfterPreview: download.x >= preview.right,
      downloadWithinPopup: download.right <= innerWidth,
      headingAfterLogo: heading.x > logo.right,
      iconAfterLabel: icon.x > label.right,
      iconOffCentre: Math.abs(
        icon.y + icon.height / 2 - (label.y + label.height / 2),
      ),
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout).toEqual({
    actionHeights: [32, 32],
    actionsShareRow: true,
    downloadAfterPreview: true,
    downloadWithinPopup: true,
    headingAfterLogo: true,
    iconAfterLabel: true,
    iconOffCentre: expect.closeTo(0, 0),
    pageOverflows: false,
  });

  // The track select carries its own border, so its focus ring sits inside.
  await popup.locator("#target-track").focus();
  await expect(popup.locator("#target-track")).toHaveCSS(
    "outline-width",
    "1px",
  );
  await expect(popup.locator("#target-track")).toHaveCSS(
    "outline-offset",
    "-1px",
  );
  await expect(popup.locator("#target-track")).toHaveCSS("border-width", "1px");
  const idle = await popup
    .locator("#download-apkg")
    .evaluate((button) => getComputedStyle(button).backgroundColor);
  await popup.locator("#download-apkg").hover();
  expect(
    await popup
      .locator("#download-apkg")
      .evaluate((button) => getComputedStyle(button).backgroundColor),
  ).not.toBe(idle);
  await popup.close();
  await source.close();
});

test("toolbar popup shows the active preview title without actions", async ({
  extension,
}) => {
  const draft = createDraft();
  draft.video.title =
    "Chinese Peppa Pig - George's Racing Car 乔治的赛车 - 8 CC SUBS";
  const editor = await openPackageDraftEditor(extension, draft);
  const tab = await editor.evaluate(() => chrome.tabs.getCurrent());
  await extension.worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );
  const popup = await openToolbarPopup(extension);
  try {
    await expect
      .poll(() =>
        popup.evaluate(`({
      heading: document.querySelector('#heading')?.textContent,
      fieldsHidden: document.querySelector('#caption-fields')?.hidden,
      actionsHidden: [...document.querySelectorAll('.popup-actions button')].every(button => button.hidden)
    })`),
      )
      .toEqual({
        heading: draft.video.title,
        fieldsHidden: true,
        actionsHidden: true,
      });
  } finally {
    await popup.close();
  }
});

test("requests first-run YouTube preview permission from Preview", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context, {
    singleStandardTrack: true,
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
  await expect(popup.locator("#heading")).toHaveText("1 caption track");
  await expect(popup.locator("#translation-field")).toBeHidden();
  await expect(popup.locator("#status")).toBeHidden();
  await popup.evaluate(() => {
    chrome.permissions.contains = async () => false;
  });
  await worker.evaluate(() => {
    chrome.permissions.contains = async () => true;
    chrome.permissions.request = async (permission) => {
      await chrome.storage.local.set({
        "test:preview-permission-request": permission,
      });
      return true;
    };
  });

  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  await popup.locator("#primary-action").click();
  const editor = await editorPromise;

  expect(
    (await extensionStorage(worker))["test:preview-permission-request"],
  ).toEqual({ origins: ["https://www.youtube.com/*"] });

  await editor.close();
  await source.close();
});

test("resumes Preview once after permission approval closes the popup", async ({
  extension,
}) => {
  const { context, extensionId, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  await source.bringToFront();
  await installDeferredPopupPermission(worker, false, "preview");
  const popup = await openToolbarPopup({ context, extensionId, worker });
  try {
    await expect
      .poll(() =>
        popup.evaluate("document.querySelector('#primary-action')?.disabled"),
      )
      .toBe(false);
    await popup.evaluate(`(() => {
      const target = document.querySelector('#target-track');
      target.value = '.en-GB';
      target.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#translation-track').value = '';
      chrome.permissions.contains = async () => false;
    })()`);
    await popup.click("#primary-action");
    await expect
      .poll(() =>
        worker.evaluate(() => globalThis.__popupPermissionRequestStarted),
      )
      .toBe(true);
    await popup.close();
    await messenger.bringToFront();
    await worker.evaluate(() =>
      globalThis.__resolvePopupPermissionRequest(true),
    );
    await expect
      .poll(
        () =>
          context
            .pages()
            .filter((page) =>
              page.url().includes(`/editor/editor.html?video=${VIDEO_ID}`),
            ).length,
      )
      .toBe(1);
    const draft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
    expect(draft.targetTrack.id).toBe(".en-GB");
    expect(draft.translationTrack).toBeNull();
    const reopened = await openToolbarPopup({ context, extensionId, worker });
    try {
      await expect
        .poll(() =>
          reopened.evaluate("document.querySelector('#heading')?.textContent"),
        )
        .toBe(draft.video.title);
    } finally {
      await reopened.close();
    }
    expect(
      (await extensionStorage(worker))[`draft:${VIDEO_ID}`].generationId,
    ).toBe(draft.generationId);
    for (const page of context.pages()) {
      if (page.url().includes(`/editor/editor.html?video=${VIDEO_ID}`))
        await page.close();
    }
  } finally {
    await popup.close();
    await source.close();
  }
});

test("scopes the YouTube preview identity to extension embeds", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ body: "<html><body>Fixture preview</body></html>" }),
  );
  const source = await openYouTubeFixture(context, {
    includeAutoGeneratedTrack: true,
    sameLocaleAlternative: true,
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
  await expect(popup.locator("#heading")).toHaveText("3 caption tracks");
  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#video-title")).toHaveCount(0);
  await expect(popup.locator("#download-apkg")).toHaveText("Download .apkg");
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(popup.locator("#target-track")).toHaveValue(".zh-Hans");
  await expect(popup.locator("#translation-track")).toHaveValue(".en-GB");
  await expect(popup.locator("#target-track option")).toHaveText([
    "Chinese (Simplified) 1",
    "English (United Kingdom)",
    "Chinese (Simplified) 2",
  ]);
  await expect(popup.locator("#translation-track option")).toHaveText([
    "–",
    "English (United Kingdom)",
    "Chinese (Simplified) 2",
  ]);
  await expect(popup.locator('option[value=".auto-en"]')).toHaveCount(0);

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

test("keeps popup package delivery scoped to its Draft", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  await installPackageSpies(context);
  await context.addInitScript(() => {
    globalThis.__youtubePermissionChecks = [];
    const contains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = async (permissions) => {
      if (permissions.origins?.includes("https://www.youtube.com/*")) {
        globalThis.__youtubePermissionChecks.push(permissions);
      }
      return contains(permissions);
    };
  });
  const localServiceRequests = [];
  context.on("request", (request) => {
    const { hostname } = new URL(request.url());
    if (["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      localServiceRequests.push(request.url());
    }
  });
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
  await expect(popup.locator("#download-apkg")).toBeEnabled();

  await popup.evaluate(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => {
      if (message.type === "generate-package") {
        return new Promise((resolve) => {
          globalThis.__continueCapture = () => resolve(sendMessage(message));
        });
      }
      if (message.type === "preflight") {
        return new Promise((resolve) => {
          globalThis.__continueBuild = () => {
            chrome.runtime.sendMessage = sendMessage;
            resolve(sendMessage(message));
          };
        });
      }
      return sendMessage(message);
    };
  });
  const downloaded = popup.waitForEvent("download");
  await popup.locator("#download-apkg").click();
  await expect(popup.locator("#download-apkg")).toHaveText("Capturing…");
  await expect(popup.locator("#primary-action")).toHaveText("Editor Preview");
  await expect(popup.locator("#primary-action")).toBeDisabled();
  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#progress")).toHaveText("Capturing captions…");
  expect(await labelOverflow(popup, "#package-action-label")).toBe(0);
  await popup.evaluate(() => globalThis.__continueCapture());
  await expect(popup.locator("#download-apkg")).toHaveText("Building…");
  expect(await labelOverflow(popup, "#package-action-label")).toBe(0);
  await expect(popup.locator("#primary-action")).toHaveText("Editor Preview");
  await expect(popup.locator("#primary-action")).toBeDisabled();
  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#progress")).toHaveText("Building package…");
  await popup.evaluate(() => globalThis.__continueBuild());
  const packageDownload = await downloaded;

  expect(packageDownload.suggestedFilename()).toBe(
    "Fixture video - abcdefghijk.apkg",
  );
  await expect(popup.locator("#status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  expect(
    await popup.evaluate(() => globalThis.__youtubePermissionChecks),
  ).toEqual([]);
  const button = await popup.locator("#download-apkg").boundingBox();
  const status = await popup.locator("#status").boundingBox();
  expect(status.y).toBeGreaterThanOrEqual(button.y + button.height);
  const downloadId = await popup.evaluate(() =>
    globalThis.__packageDownloadIds.at(-1),
  );
  await popup
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  await expect(popup.locator("#status")).toHaveText(
    "Open request sent. Confirm the import in Anki.",
  );
  expect(await popup.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    downloadId,
  ]);
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await expect(popup.locator("#download-apkg")).toBeEnabled();
  await popup
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await expect(popup.locator("#download-apkg")).toBeEnabled();
  expect(await popup.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    downloadId,
    downloadId,
  ]);
  await popup.locator("#target-track").selectOption(".en-GB");
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(popup.locator("#status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  await clickPackageDownload(popup);
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  const erasedDownloadId = await popup.evaluate(() =>
    globalThis.__packageDownloadIds.at(-1),
  );
  await popup.evaluate(
    (downloadId) => chrome.downloads.erase({ id: downloadId }),
    erasedDownloadId,
  );
  await popup
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(popup.locator("#status")).toHaveText(
    "Downloaded package is missing. Download a new .apkg.",
  );
  expect(await popup.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    downloadId,
    downloadId,
  ]);
  await clickPackageDownload(popup);
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  const externallyEdited = (await extensionStorage(worker))[
    `draft:${VIDEO_ID}`
  ];
  externallyEdited.segments[0].target = "Changed outside this popup";
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: externallyEdited,
  });
  await expect(
    popup.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(popup.locator("#status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
  expect(
    (await extensionStorage(worker, "session"))[`draft:${VIDEO_ID}`],
  ).toBeUndefined();
  expect(
    context
      .pages()
      .some((page) =>
        page.url().includes(`/editor/editor.html?video=${VIDEO_ID}`),
      ),
  ).toBe(false);
  expect(localServiceRequests).toEqual([]);
  await clickPackageDownload(popup);
  await expect(popup.locator("#download-apkg")).toHaveText("Open in Anki");
  await popup.evaluate(() => {
    chrome.downloads.open = async () => {
      throw new Error("Chrome-specific failure");
    };
  });
  await popup.locator("#download-apkg").click();
  await expect(popup.locator("#status")).toHaveText(
    "Could not open the downloaded package. Open it from Chrome Downloads or File Explorer.",
  );
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await expect(popup.locator("#download-apkg")).toHaveText("Download .apkg");
  await expect(popup.locator("#download-apkg")).toBeEnabled();
  await clickPackageDownload(popup);
  await expect(popup.locator("#status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  await expect(popup.locator("#download-apkg")).toHaveText("Open in Anki");
  await expect(popup.locator("#download-apkg")).toBeEnabled();
  await source.close();
});

test("downloads and opens a package from the toolbar popup", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );
  const popup = await openToolbarPopup({ context, extensionId, worker });
  try {
    await popup.evaluate(`(() => {
      globalThis.__packageDownloadIds = [];
      globalThis.__packageDownloadNames = [];
      globalThis.__openedPackageIds = [];
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.href.startsWith('blob:')) {
          globalThis.__packageDownloadNames.push(this.download);
        }
        return anchorClick.call(this);
      };
      chrome.downloads.onCreated.addListener((item) => {
        if (item.url.startsWith('blob:')) {
          globalThis.__packageDownloadIds.push(item.id);
        }
      });
      chrome.downloads.open = async (downloadId) => {
        globalThis.__openedPackageIds.push(downloadId);
      };
    })()`);
    await expect
      .poll(() =>
        popup.evaluate("document.querySelector('#download-apkg')?.disabled"),
      )
      .toBe(false);

    await popup.click("#download-apkg");

    await expect
      .poll(() =>
        popup.evaluate(`({
          openHidden: document.querySelector('#download-apkg').textContent.trim() !== 'Open in Anki',
          status: document.querySelector('#status').textContent
        })`),
      )
      .toEqual({
        openHidden: false,
        status: "Package downloaded. Draft kept.",
      });
    const completed = await popup.evaluate(`(async () => {
      const downloadId = globalThis.__packageDownloadIds.at(-1);
      const [item] = await chrome.downloads.search({ id: downloadId });
      return {
        downloadId,
        downloadName: globalThis.__packageDownloadNames.at(-1),
        url: item?.url
      };
    })()`);
    expect(completed.downloadName).toBe("Fixture video - abcdefghijk.apkg");
    expect(completed.url).toMatch(/^blob:/u);

    await popup.click("#download-apkg");

    await expect
      .poll(() =>
        popup.evaluate("document.querySelector('#status').textContent"),
      )
      .toBe("Open request sent. Confirm the import in Anki.");
    expect(await popup.evaluate("globalThis.__openedPackageIds")).toEqual([
      completed.downloadId,
    ]);
  } finally {
    await popup.close();
    await source.close();
  }
});

for (const scenario of [
  {
    action: "preview",
    change: "video",
    expectedStatus: "Source Video changed. Try again.",
    label: "preview Source Video",
  },
  {
    action: "preview",
    change: "track",
    expectedStatus: "Caption Track changed. Choose another caption track.",
    label: "preview Target Caption Track",
  },
]) {
  test(`restores popup actions when the resumed ${scenario.label} changed`, async ({
    extension,
  }) => {
    const { context, extensionId, worker } = extension;
    await installDeferredPopupPermission(worker, false, scenario.action);
    const source = await openYouTubeFixture(context);
    const [tab] = await worker.evaluate(() =>
      chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
    );
    await worker.evaluate(
      (tabId) => chrome.tabs.update(tabId, { active: true }),
      tab.id,
    );
    const popup = await openToolbarPopup({ context, extensionId, worker });
    let recovered;
    try {
      await expect
        .poll(() =>
          popup.evaluate("document.querySelector('#download-apkg')?.disabled"),
        )
        .toBe(false);
      if (scenario.action === "preview") {
        await popup.evaluate("chrome.permissions.contains = async () => false");
      }
      await popup.click(
        scenario.action === "preview" ? "#primary-action" : "#download-apkg",
      );
      await expect
        .poll(() =>
          worker.evaluate(() => globalThis.__popupPermissionRequestStarted),
        )
        .toBe(true);
      await popup.close();
      await source.evaluate((change) => {
        const current = structuredClone(window.__fixtureResponse);
        if (change === "video") {
          current.videoDetails.videoId = "lmnopqrstuv";
          history.replaceState({}, "", "/watch?v=lmnopqrstuv");
        } else {
          current.captions.playerCaptionsTracklistRenderer.captionTracks =
            current.captions.playerCaptionsTracklistRenderer.captionTracks.filter(
              (track) => track.vssId !== ".zh-Hans",
            );
        }
        window.__fixtureResponse = current;
        window.__playerResponse = current;
      }, scenario.change);
      await worker.evaluate(() =>
        globalThis.__resolvePopupPermissionRequest(true),
      );
      recovered = await waitForToolbarPopup({
        context,
        excludedTargetIds: [popup.targetId],
        extensionId,
      });

      await expect
        .poll(() =>
          recovered.evaluate(`({
            actionDisabled: document.querySelector('#primary-action')?.disabled,
            downloadDisabled: document.querySelector('#download-apkg')?.disabled,
            openHidden: document.querySelector('#download-apkg')?.textContent.trim() !== 'Open in Anki',
            status: document.querySelector('#status')?.textContent
          })`),
        )
        .toEqual({
          actionDisabled: false,
          downloadDisabled: false,
          openHidden: true,
          status: scenario.expectedStatus,
        });
      expect(
        (await extensionStorage(worker))[`draft:${VIDEO_ID}`],
      ).toBeUndefined();
    } finally {
      await recovered?.close();
      await popup.close();
      await source.close();
    }
  });
}

test("rejects package capture after the Source Video changes", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const response = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate-package",
    videoId: "lmnopqrstuv",
  });

  expect(response).toEqual({
    error: {
      code: "CAPTURE_FAILED",
      message: "The Source Video changed before package capture. Try again.",
    },
    ok: false,
  });
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
  await source.close();
});

for (const granted of [true, false]) {
  test(`restores the existing popup package after Open permission is ${granted ? "granted" : "denied"}`, async ({
    extension,
  }) => {
    const { context, extensionId, worker } = extension;
    await installDeferredPopupPermission(worker, false, "open-package");
    await worker.evaluate(() => {
      globalThis.__createdPackages = [];
      chrome.downloads.onCreated.addListener((item) => {
        if (item.url.startsWith("blob:"))
          globalThis.__createdPackages.push(item.id);
      });
    });
    const source = await openYouTubeFixture(context);
    const [tab] = await worker.evaluate(() =>
      chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
    );
    await worker.evaluate(
      (tabId) => chrome.tabs.update(tabId, { active: true }),
      tab.id,
    );
    const popup = await openToolbarPopup({ context, extensionId, worker });
    let recovered;
    try {
      await expect
        .poll(() =>
          popup.evaluate("document.querySelector('#download-apkg')?.disabled"),
        )
        .toBe(false);
      await popup.evaluate(`(() => {
        chrome.permissions.contains = async () => false;
        const target = document.querySelector('#target-track');
        target.value = '.en-GB';
        target.dispatchEvent(new Event('change', { bubbles: true }));
        const translation = document.querySelector('#translation-track');
        translation.value = '';
        translation.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await popup.click("#download-apkg");
      await expect
        .poll(() =>
          popup.evaluate("document.querySelector('#status')?.textContent"),
        )
        .toBe("Package download started. Draft kept.");
      expect(
        await worker.evaluate(() => globalThis.__popupPermissionRequestStarted),
      ).toBe(false);
      await expect
        .poll(() => worker.evaluate(() => globalThis.__createdPackages.length))
        .toBe(1);
      const before = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
      const [downloadId] = await worker.evaluate(
        () => globalThis.__createdPackages,
      );
      await popup.click("#download-apkg");
      await expect
        .poll(() =>
          worker.evaluate(() => globalThis.__popupPermissionRequestStarted),
        )
        .toBe(true);
      await popup.close();
      await worker.evaluate(
        (allow) => globalThis.__resolvePopupPermissionRequest(allow),
        granted,
      );
      recovered = await waitForToolbarPopup({
        context,
        excludedTargetIds: [popup.targetId],
        extensionId,
      });
      await expect
        .poll(() =>
          recovered.evaluate("document.querySelector('#status')?.textContent"),
        )
        .toBe(
          granted
            ? "Permission granted. Click Open in Anki."
            : "Package download started. Draft kept. Open the .apkg from Chrome Downloads or File Explorer.",
        );
      await expect
        .poll(() =>
          recovered.evaluate(
            "document.querySelector('#download-apkg')?.textContent.trim()",
          ),
        )
        .toBe("Open in Anki");
      expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toEqual(
        before,
      );
      expect(await worker.evaluate(() => globalThis.__createdPackages)).toEqual(
        [downloadId],
      );
      if (granted) {
        await recovered.evaluate(`(() => {
          globalThis.__openedPackageIds = [];
          chrome.downloads.open = async (id) => { globalThis.__openedPackageIds.push(id); };
        })()`);
        await recovered.click("#download-apkg");
        await expect
          .poll(() => recovered.evaluate("globalThis.__openedPackageIds"))
          .toEqual([downloadId]);
        expect(
          await worker.evaluate(() => globalThis.__createdPackages),
        ).toEqual([downloadId]);
      }
    } finally {
      await recovered?.close();
      await popup.close();
      await source.close();
    }
  });
}

test("disables generation when only auto-generated captions exist", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context, {
    onlyAutoGeneratedTrack: true,
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

  await expect(popup.locator("#heading")).toHaveText("0 caption tracks");
  await expect(popup.locator("#status")).toHaveText("No supported captions");
  await expect(popup.locator("#caption-fields")).toBeHidden();
  await expect(popup.locator("#primary-action")).toBeHidden();
  await source.close();
});

test("accepts a standard track whose URL carries caps=asr", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { standardCapsAsr: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });
  expect(generation.ok, JSON.stringify(generation)).toBe(true);
  const editor = await editorPromise;
  const generatedDraft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(generation.data).toEqual({
    generationId: generatedDraft.generationId,
    videoId: VIDEO_ID,
  });
  expect(generatedDraft.version).toBe(DRAFT_SCHEMA_VERSION);
  expect(generatedDraft.segments).toHaveLength(3);
  expect(
    generatedDraft.segments.map(({ startMs, endMs }) => ({ startMs, endMs })),
  ).toEqual([
    { endMs: 2_500, startMs: 1_000 },
    { endMs: 4_000, startMs: 2_500 },
    { endMs: 7_000, startMs: 6_000 },
  ]);
  await editor.close();
});

test("rejects an ASR marker found only in the timed-text URL", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { targetAsrUrlOnly: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });

  expect(inspection.ok).toBe(true);
  expect(inspection.data.video.tracks.map((track) => track.id)).toEqual([
    ".en-GB",
  ]);
});

test("filters unsupported Caption Track kinds and translations", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, {
    extraUnsupportedTracks: true,
    targetMetadataKind: "standard",
    targetUrlKind: "standard",
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });

  expect(inspection.ok).toBe(true);
  expect(inspection.data.video.tracks.map((track) => track.id)).toEqual([
    ".zh-Hans",
    ".en-GB",
  ]);
  expect(inspection.data.video.tracks[0].kind).toBe("standard");
});

test("captures supported bilingual tracks without controlling the player", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await context.addCookies([
    {
      name: "fixture_session",
      url: "https://www.youtube.com/",
      value: "secret",
    },
  ]);
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
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });
  const editor = await editorPromise;

  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(generatedDraft.segments).toHaveLength(3);
  expect(generatedDraft.segments.map((segment) => segment.translation)).toEqual(
    ["Hello world.", "Hello world.", "Goodbye."],
  );
  expect(source.__yt2ankiPlayerRequests).toEqual([
    {
      body: {
        contentCheckOk: true,
        context: {
          client: {
            clientName: "VISIONOS",
            clientVersion: "1.02",
            deviceMake: "Apple",
            deviceModel: "RealityDevice17,1",
            hl: "en",
            osName: "visionOS",
            osVersion: "26.5.23O471",
            timeZone: "UTC",
            utcOffsetMinutes: 0,
            visitorData: "fixture-visitor",
          },
        },
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
          },
        },
        racyCheckOk: true,
        videoId: VIDEO_ID,
      },
      clientName: "101",
      clientVersion: "1.02",
      cookie: undefined,
      query: "?prettyPrint=false",
      visitorData: "fixture-visitor",
    },
  ]);
  expect(source.__yt2ankiTimedTextRequests).toHaveLength(2);
  expect(
    source.__yt2ankiTimedTextRequests.every(
      (request) => request.cookie === undefined,
    ),
  ).toBe(true);
  await expect(editor).toHaveURL(/editor\/editor\.html\?video=abcdefghijk/u);
  await expect(editor.locator("#selection-summary")).toHaveText("3/3");
  await expect(editor.locator("#select-all")).toHaveAttribute(
    "aria-label",
    "Select all Segments, 3 of 3 selected",
  );
  await expect(editor.locator("#language-pair")).toHaveCount(0);

  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);
});

test("forms an Agreed Continuation before opening the editor", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { agreedContinuation: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });
  const editor = await editorPromise;
  const generatedDraft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];

  expect(generation.ok).toBe(true);
  expect(generatedDraft.segments).toHaveLength(2);
  expect(generatedDraft.segments[0]).toMatchObject({
    endMs: 4_000,
    startMs: 1_000,
    target: "你好，世界。",
    translation: "Hello, world.",
  });
  await expect(editor.locator("#selection-summary")).toHaveText("2/2");
});

test("keeps uncertain Translation alignment selected and exportable", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { translationAlignmentGap: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });
  const editor = await editorPromise;

  expect(generation.ok).toBe(true);
  const generatedDraft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(generatedDraft.segments.map((segment) => segment.translation)).toEqual(
    ["Hello world.", "Hello world.", ""],
  );
  expect(generatedDraft.segments.map((segment) => segment.selected)).toEqual([
    true,
    true,
    true,
  ]);
  for (const segment of generatedDraft.segments) {
    expect(segment).not.toHaveProperty("translationWarning");
  }
  await expect(editor.locator("#selection-summary")).toHaveText("3/3");
  await expect(editor.locator(".row-status")).toHaveCount(0);
  await expect(editor.locator("#export-status")).toBeEmpty();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
});

test("uses only the active video's distinct supported tracks after navigation", async ({
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
        baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=zh`,
        languageCode: "zh",
        name: { simpleText: "Chinese" },
        vssId: ".zh",
      },
    ];
    window.__fixtureResponse = current;
    window.__playerResponse = current;
    window.ytInitialPlayerResponse = current;
    history.replaceState({}, "", `/watch?v=${videoId}`);
  }, currentVideoId);
  await setExtensionStorage(worker, {
    settings: {
      hasPreviousSelection: true,
      targetLanguageCode: "zh-Hans",
      translationLanguageCode: null,
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
  await expect(popup.locator("#heading")).toHaveText("1 caption track");
  await expect(popup.locator("#target-track option")).toHaveText(["Chinese"]);
  await expect(popup.locator("#target-track")).toHaveValue(".zh");
  await expect(popup.locator("#translation-field")).toBeHidden();
  await expect(popup.locator("#status")).toBeHidden();

  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh",
    type: "generate",
  });
  expect(generation.ok, JSON.stringify(generation)).toBe(true);
  const editor = await editorPromise;
  const generatedDraft = (await extensionStorage(worker))[
    `draft:${currentVideoId}`
  ];
  expect(generatedDraft.translationTrack).toBeNull();
  expect(
    generatedDraft.segments.every((segment) => segment.translation === ""),
  ).toBe(true);
  await editor.close();
});

test("binds fresh captions to the selected same-locale track", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, {
    sameLocaleAlternative: true,
  });
  const [{ id }] = await worker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }),
  );
  const editorPromise = context.waitForEvent("page");
  const response = await extensionMessage(messenger, {
    tabId: id,
    targetTrackId: ".zh-Hans-alt",
    translationTrackId: ".en-GB",
    type: "generate",
  });
  const editor = await editorPromise;
  expect(response.ok).toBe(true);
  const draft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(draft.targetTrack.id).toBe(".zh-Hans-alt");
  expect(draft.segments[0].target).toBe("选中的字幕。");
  await editor.close();
});

test("rejects a Source Video navigation during capture and offers retry", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context, {
    navigateDuringCapture: true,
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
  await popup.evaluate(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => {
      if (message.type === "generate") {
        return new Promise((resolve) => {
          globalThis.__continueCapture = () => {
            chrome.runtime.sendMessage = sendMessage;
            resolve(sendMessage(message));
          };
        });
      }
      return sendMessage(message);
    };
  });
  await popup.locator("#primary-action").click();
  await expect(popup.locator("#primary-action")).toBeDisabled();
  await expect(popup.locator("#progress")).toHaveText("Capturing captions…");
  await expect(popup.locator("#status")).toBeHidden();
  await popup.evaluate(() => globalThis.__continueCapture());

  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#primary-action")).toHaveText(
    "Try capture again",
  );
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await expect(popup.locator("#progress")).toBeEmpty();
  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
  await source.close();
});

test("rejects a selected track that changes during capture", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { changeTrackDuringCapture: true });
  const [{ id }] = await worker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }),
  );

  const response = await extensionMessage(messenger, {
    tabId: id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(response.ok).toBe(false);
  expect(response.error.message).toContain("Caption Track changed");
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("binds capture to the inspected track language and kind", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, {
    changeTrackAfterInspection: true,
    singleStandardTrack: true,
  });
  const [{ id }] = await worker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }),
  );

  const response = await extensionMessage(messenger, {
    tabId: id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(response.ok).toBe(false);
  expect(response.error.message).toContain("Caption Track changed");
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("preserves a direct Translation choice when Target changes", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const source = await openYouTubeFixture(context);
  await source.evaluate(() => {
    const current = structuredClone(window.__fixtureResponse);
    current.captions.playerCaptionsTracklistRenderer.captionTracks.push({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr",
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
  await expect(popup.locator("#translation-track")).toHaveValue(".en-GB");

  await popup.locator("#translation-track").selectOption(".fr");
  await popup.locator("#target-track").selectOption(".en-GB");

  await expect(popup.locator("#translation-track")).toHaveValue(".fr");
  await popup.close();
  await source.close();
});

test("omits Track two when the popup selects no second caption track", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
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
  await expect(popup.locator("#translation-track")).toHaveValue(".en-GB");
  await expect(
    popup.getByRole("option", { name: "No second track", exact: true }),
  ).toHaveAttribute("value", "");
  await popup.locator("#translation-track").selectOption("");
  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  await popup.locator("#primary-action").click();
  const editor = await editorPromise;
  await expect(editor.locator("#editor")).toBeVisible();
  const draft = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(draft.translationTrack).toBeNull();
  expect(draft.segments.every((segment) => segment.translation === "")).toBe(
    true,
  );
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
  await expect(editor.locator("#translation-heading-label")).toBeHidden();
  await expect(
    editor.locator('#segment-list textarea[data-field="translation"]'),
  ).toHaveCount(0);
  await expect(editor.locator("#preview-translation")).toBeHidden();
  await expect(editor.locator(".field-order-actions:visible")).toHaveCount(0);
  await editor.locator("#generate-pinyin").click();
  await expect(editor.locator("#preview-pinyin")).toBeVisible();
  await expect(editor.locator("#generate-pinyin")).toBeHidden();
  const singleTrackEdges = await editor.evaluate(() => {
    const right = (selector) =>
      document.querySelector(selector).getBoundingClientRect().right;
    return [right("#preview-target"), right("#preview-pinyin")];
  });
  expect(singleTrackEdges[0]).toBe(singleTrackEdges[1]);
  await expect(
    editor.locator('#segment-list textarea[data-field="translation"]'),
  ).toHaveCount(0);
  await editor.reload();
  await expect(editor.locator("#preview-translation")).toBeHidden();
  await editor.close();
  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    tab.id,
  );
  const nextPopupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate(
    (url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const nextPopup = await nextPopupPromise;
  await expect(nextPopup.locator("#target-track")).toHaveValue(".zh-Hans");
  await expect(nextPopup.locator("#translation-track")).toHaveValue("");
  await nextPopup.close();
  await source.close();
});

test("generates from fresh caption metadata without controlling the player", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });

  expect(generation.ok).toBe(true);
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
    "/api/timedtext?lang=en-GB&fmt=json3",
  ]);
  expect(
    source.__yt2ankiTimedTextUrls.map((value) => {
      const url = new URL(value);
      return {
        fmt: url.searchParams.get("fmt"),
        signature: url.searchParams.get("signature"),
        xosf: url.searchParams.has("xosf"),
      };
    }),
  ).toEqual([
    { fmt: "json3", signature: "target-signed", xosf: false },
    { fmt: "json3", signature: "translation-signed", xosf: false },
  ]);
  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);
  expect(
    (await extensionStorage(worker))[`draft:${VIDEO_ID}`]?.segments,
  ).toHaveLength(3);
});

test("reuses validated captions without another YouTube request", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context);
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  const request = {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  };

  const firstEditor = context.waitForEvent("page");
  expect((await extensionMessage(messenger, request)).ok).toBe(true);
  await (await firstEditor).close();
  const firstRequests = [...source.__yt2ankiRequests];

  await source.evaluate(() => {
    history.replaceState({}, "", `${location.pathname}${location.search}&t=2`);
  });

  const secondEditor = context.waitForEvent("page");
  expect((await extensionMessage(messenger, request)).ok).toBe(true);
  await (await secondEditor).close();

  expect(source.__yt2ankiRequests).toEqual(firstRequests);
});

for (const destination of ["/watch?v=lmnopqrstuv", "/"]) {
  test(`discards cached captions after visiting ${destination} and returning`, async ({
    extension,
  }) => {
    const { context, messenger, worker } = extension;
    const source = await openYouTubeFixture(context, {
      singleStandardTrack: true,
    });
    const [tab] = await worker.evaluate(() =>
      chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
    );
    const request = {
      tabId: tab.id,
      targetTrackId: ".zh-Hans",
      type: "generate",
    };

    const firstEditor = context.waitForEvent("page");
    expect((await extensionMessage(messenger, request)).ok).toBe(true);
    await (await firstEditor).close();
    const firstRequests = [...source.__yt2ankiRequests];

    await source.evaluate(
      (path) => history.pushState({}, "", path),
      destination,
    );
    await source.goBack();
    await expect(source).toHaveURL(
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    );

    const secondEditor = context.waitForEvent("page");
    expect((await extensionMessage(messenger, request)).ok).toBe(true);
    await (await secondEditor).close();
    expect(source.__yt2ankiRequests).toEqual([
      ...firstRequests,
      ...firstRequests,
    ]);
  });
}

test("discards an invalid page-memory caption cache entry", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    singleStandardTrack: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  const request = {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  };

  const firstEditor = context.waitForEvent("page");
  expect((await extensionMessage(messenger, request)).ok).toBe(true);
  await (await firstEditor).close();
  await source.evaluate(() => {
    const key = JSON.stringify([".zh-Hans", "zh-Hans", "standard"]);
    window.__yt2ankiCaptionCache.captions[key] = [
      { endMs: 500, startMs: 1_000, text: "invalid" },
    ];
  });

  const secondEditor = context.waitForEvent("page");
  expect((await extensionMessage(messenger, request)).ok).toBe(true);
  await (await secondEditor).close();

  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
});

test("rejects a concurrent Generate for the same Source Video", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    singleStandardTrack: true,
    timedTextDelayMs: 250,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  const request = {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  };
  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );

  const firstPromise = extensionMessage(messenger, request);
  await expect
    .poll(() =>
      source.__yt2ankiRequests.includes(
        "/api/timedtext?lang=zh-Hans&fmt=json3",
      ),
    )
    .toBe(true);
  const second = await extensionMessage(messenger, request);
  const first = await firstPromise;
  await (await editorPromise).close();

  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(second).toEqual({
    error: {
      code: "CAPTURE_FAILED",
      message: "Caption capture is already running for this Source Video.",
    },
    ok: false,
  });
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
});

test("treats absent and standard caption kinds as the same sole track", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    canonicalizeStandardKindDuringCapture: true,
    singleStandardTrack: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const editorPromise = context.waitForEvent("page");
  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });
  await (await editorPromise).close();

  expect(generation.ok, JSON.stringify(generation)).toBe(true);
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
});

test("does not cache a mixed capture when Translation capture fails", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    timedTextUnavailableLanguages: ["en-GB"],
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const failed = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });

  expect(failed.ok).toBe(false);
  expect(failed.error.message).toContain(
    "Precise captions are unavailable for English (United Kingdom)",
  );
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
    "/api/timedtext?lang=en-GB&fmt=json3",
  ]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);

  const requestsAfterFailure = source.__yt2ankiRequests.length;
  const editorPromise = context.waitForEvent("page");
  const targetOnly = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });
  await (await editorPromise).close();

  expect(targetOnly.ok, JSON.stringify(targetOnly)).toBe(true);
  expect(source.__yt2ankiRequests.slice(requestsAfterFailure)).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
});

test("fails when timed text needs a missing PO token", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    missingPoToken: true,
    singleStandardTrack: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(generation.ok).toBe(false);
  expect(generation.error.message).toContain(
    "Precise captions are unavailable for Chinese (Simplified)",
  );
  expect(source.__yt2ankiRequests).toEqual(["/youtubei/v1/player"]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("fails when fresh metadata loses the selected track", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    freshTrackMismatch: true,
    singleStandardTrack: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(generation.ok).toBe(false);
  expect(generation.error.message).toContain(
    "Fresh caption metadata did not contain the selected track: Chinese (Simplified)",
  );
  expect(source.__yt2ankiRequests).toEqual(["/youtubei/v1/player"]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("fails explicitly when the private player request is rejected", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    freshPlayerFailure: true,
    singleStandardTrack: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(generation.ok).toBe(false);
  expect(generation.error.message).toContain(
    "Fresh YouTube caption metadata is unavailable",
  );
  expect(source.__yt2ankiRequests).toEqual(["/youtubei/v1/player"]);
  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

for (const captureAction of ["#primary-action", "#download-apkg"]) {
  test(`stops caption capture on HTTP 429 and disables retry from ${captureAction}`, async ({
    extension,
  }) => {
    const { context, extensionId, worker } = extension;
    const source = await openYouTubeFixture(context, {
      captionRateLimited: true,
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
    await expect(popup.locator("#status")).toBeHidden();

    await popup.locator(captureAction).click();

    await expect(popup.locator("#status")).toHaveText(
      "YouTube blocked caption loading (HTTP 429). yt2anki stopped and did not retry. Try again later.",
      { timeout: 15_000 },
    );
    // #status carries no role, so the failure has to reach the live region or
    // a screen reader user hears nothing at all.
    await expect(popup.locator("#progress")).toContainText("HTTP 429");
    await expect(popup.locator("#status")).not.toHaveAttribute("role");
    await expect(popup.locator("#primary-action")).toHaveText(
      "Try again later",
    );
    await expect(popup.locator("#primary-action")).toBeDisabled();
    await expect(popup.locator("#download-apkg")).toBeDisabled();
    for (const [selector, value] of [
      ["#translation-track", ""],
      ["#target-track", ".en-GB"],
    ]) {
      await popup.locator(selector).selectOption(value);
      await expect(popup.locator("#primary-action")).toBeDisabled();
      await expect(popup.locator("#download-apkg")).toBeDisabled();
      await expect(popup.locator("#status")).toContainText("HTTP 429");
    }
    expect(source.__yt2ankiRequests).toEqual([
      "/youtubei/v1/player",
      "/api/timedtext?lang=zh-Hans&fmt=json3",
    ]);
    expect(await source.evaluate(() => window.__playerControlCalls)).toEqual(
      [],
    );
    expect(
      (await extensionStorage(worker))[`draft:${VIDEO_ID}`],
    ).toBeUndefined();
    await popup.reload();
    await expect(popup.locator("#primary-action")).toBeEnabled();
    await expect(popup.locator("#download-apkg")).toBeEnabled();
  });
}

for (const [mode, label] of [
  ["empty", "an empty body"],
  ["malformed", "malformed JSON3"],
  ["missing-duration", "missing timing"],
  ["invalid-append", "an invalid rolling-update marker"],
  ["oversized", "an oversized body"],
]) {
  test(`rejects ${label} from the fresh response`, async ({ extension }) => {
    const { context, messenger, worker } = extension;
    const source = await openYouTubeFixture(context, {
      singleStandardTrack: true,
      targetPayloadMode: mode,
    });
    const [tab] = await worker.evaluate(() =>
      chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
    );

    const generation = await extensionMessage(messenger, {
      tabId: tab.id,
      targetTrackId: ".zh-Hans",
      type: "generate",
    });

    expect(generation.ok).toBe(false);
    expect(generation.error.message).toContain(
      "Precise captions are unavailable for Chinese (Simplified)",
    );
    expect(source.__yt2ankiRequests).toEqual([
      "/youtubei/v1/player",
      "/api/timedtext?lang=zh-Hans&fmt=json3",
    ]);
    expect(
      (await extensionStorage(worker))[`draft:${VIDEO_ID}`],
    ).toBeUndefined();
  });
}

test("fails after timed text times out", async ({ extension }) => {
  const { context, messenger, worker } = extension;
  const source = await openYouTubeFixture(context, {
    singleStandardTrack: true,
    timedTextTimeout: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    type: "generate",
  });

  expect(generation.ok).toBe(false);
  expect(generation.error.message).toContain(
    "Precise captions are unavailable for Chinese (Simplified)",
  );
  expect(source.__yt2ankiRequests).toEqual([
    "/youtubei/v1/player",
    "/api/timedtext?lang=zh-Hans&fmt=json3",
  ]);
  expect(await source.evaluate(() => window.__playerControlCalls)).toEqual([]);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("fails the whole Draft when Translation routes are invalid", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { invalidTranslationDuration: true });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const generation = await extensionMessage(messenger, {
    tabId: tab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });

  expect(generation.ok).toBe(false);
  expect(generation.error.message).toContain(
    "Precise captions are unavailable for English (United Kingdom)",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeUndefined();
});

test("ignores a supported Caption Track with no stable identity", async ({
  extension,
}) => {
  const { context, messenger, worker } = extension;
  await openYouTubeFixture(context, { missingSupportedTrackId: true });
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

test("explains when the watch page returns no player metadata", async ({
  extension,
}) => {
  const { messenger, worker } = extension;
  await openYouTubeFixture(extension.context, {
    discardInspectionResult: true,
  });
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );

  const inspection = await extensionMessage(messenger, {
    tabId: tab.id,
    type: "inspect",
  });

  expect(inspection).toEqual({
    error: {
      code: "CAPTURE_FAILED",
      message:
        "YouTube player metadata could not be read because the page returned no data.",
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

  await expect(popup.locator("#primary-action")).toHaveText("Try again");
  await expect(popup.locator("#primary-action")).toBeEnabled();
  await expect(popup.locator("#status")).toBeHidden();
  await source.evaluate(() => {
    window.__playerResponse = window.__fixtureResponse;
  });
  await popup.locator("#primary-action").click();
  await expect(popup.locator("#status")).toBeHidden();
  await expect(popup.locator("#primary-action")).toHaveText("Editor Preview");
  await expect(popup.locator("#primary-action")).toBeEnabled();
});

for (const mismatch of ["protocol", "draft-schema", "missing-draft-schema"]) {
  const label = mismatch.replaceAll("-", " ");
  test(`reloads a background with a ${label} mismatch before enabling generation`, async ({
    extension,
  }) => {
    const { context, extensionId, worker } = extension;
    await openYouTubeFixture(context);
    const [tab] = await worker.evaluate(() =>
      chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
    );
    await worker.evaluate(
      (tabId) => chrome.tabs.update(tabId, { active: true }),
      tab.id,
    );
    await context.addInitScript(
      ({ boundary, draftSchemaVersion, protocolVersion }) => {
        if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") {
          return;
        }
        const originalSendMessage = chrome.runtime.sendMessage.bind(
          chrome.runtime,
        );
        chrome.runtime.sendMessage = async (message) => {
          const response = await originalSendMessage(message);
          if (message.type !== "inspect" || !response?.ok) {
            return response;
          }
          const data = { ...response.data };
          if (boundary === "protocol") {
            data.protocolVersion = protocolVersion - 1;
          } else if (boundary === "draft-schema") {
            data.draftSchemaVersion = draftSchemaVersion - 1;
          } else {
            delete data.draftSchemaVersion;
          }
          return {
            ...response,
            data,
          };
        };
        chrome.runtime.reload = () => {
          void chrome.storage.session.clear().then(() => {
            localStorage.setItem("yt2anki-test-reload", "requested");
          });
        };
      },
      {
        boundary: mismatch,
        draftSchemaVersion: DRAFT_SCHEMA_VERSION,
        protocolVersion: APP_PROTOCOL_VERSION,
      },
    );

    const popupPromise = context.waitForEvent("page", (page) =>
      page.url().includes("/popup/popup.html"),
    );
    await worker.evaluate(
      (url) => chrome.tabs.create({ active: false, url }),
      `chrome-extension://${extensionId}/popup/popup.html`,
    );
    const popup = await popupPromise;

    await expect(popup.locator("#status")).toBeHidden();
    await expect(popup.locator("#primary-action")).toHaveText(
      "Updating extension…",
    );
    await expect(popup.locator("#primary-action")).toBeDisabled();
    await expect
      .poll(() =>
        popup.evaluate(() => localStorage.getItem("yt2anki-test-reload")),
      )
      .toBe("requested");
    const stored = await extensionStorage(worker);
    expect(stored["pending-popup-recovery"]).toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });
  });
}

test("keeps Target-only Segments exportable", async ({ extension }) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await expect(editor.locator("#language-pair")).toHaveCount(0);
  await expect(editor.locator("#preview-translation")).toHaveValue("");
  await expect(editor.locator(".field-order-actions:visible")).toHaveCount(0);
  await expect(editor.locator("#export-status")).toBeEmpty();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
});

test("autosaves compact fields and validates Target without row statuses", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello?" });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await expect(editor.locator(".segment-row textarea")).toHaveCount(2);
  await expect(editor.locator("#segment-table")).toHaveJSProperty(
    "tagName",
    "TABLE",
  );
  await expect
    .poll(() =>
      editor
        .locator("#editor")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(2);
  await editor.setViewportSize({ width: 600, height: 800 });
  await expect
    .poll(() =>
      editor
        .locator("#editor")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(1);
  expect(
    await editor.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const translation = editor.locator(
    '.segment-row textarea[data-field="translation"]',
  );
  await expect(editor.locator(".row-status")).toHaveCount(0);
  await expect(translation).not.toHaveAttribute("aria-describedby");
  await expect(editor.locator(".translation-warning")).toHaveCount(0);

  await translation.fill("Hello.");
  await expect(editor.locator(".row-status")).toHaveCount(0);
  const target = editor.locator('.segment-row textarea[data-field="target"]');
  await target.fill("");
  await expect(target).toHaveAttribute("aria-invalid", "true");
  await expect(target).not.toHaveAttribute("aria-describedby");
  await expect(editor.locator(".row-status")).toHaveCount(0);

  await target.fill("你好呀。");
  await expect(target).toHaveAttribute("aria-invalid", "false");
  await editor.locator(".segment-checkbox").check();
  await expect(editor.locator("#save-state")).toBeEmpty();
  await expect
    .poll(async () => {
      const saved = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
      return saved.segments[0].target;
    })
    .toBe("你好呀。");
  const stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.segments[0]).toMatchObject({
    target: "你好呀。",
    translation: "Hello.",
  });
});

test("reveals generated Pinyin and preserves existing values", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  draft.segments.push({
    ...draft.segments[0],
    endMs: 5_875,
    identity: "v4_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    pinyin: "",
    startMs: 4_250,
    target: "再见。",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  const generate = editor.locator("#generate-pinyin");
  await expect(generate).toBeVisible();
  await expect(generate).toBeEnabled();
  await expect(
    editor.locator('.segment-row textarea[data-field="pinyin"]'),
  ).toHaveCount(0);
  await expect(editor.locator("#preview-pinyin-field")).toBeHidden();
  await generate.click();

  const pinyin = editor.locator('.segment-row textarea[data-field="pinyin"]');
  await expect(pinyin).toHaveCount(2);
  await expect(pinyin.nth(0)).toHaveValue("nǐ hǎo。");
  await expect(pinyin.nth(1)).toHaveValue("zài jiàn。");
  await expect(editor.locator("#preview-pinyin")).toHaveValue("nǐ hǎo。");
  await expect(editor.locator("#pinyin-status")).toHaveText(
    "Generated Pinyin for 2 Segments. Kept 0 existing values.",
  );
  await expect(editor.locator("#selection-summary")).toHaveText("2/2");
  await expect(editor.locator("#download-apkg")).toBeEnabled();

  await pinyin.nth(0).fill("custom pronunciation");
  await expect(generate).toBeHidden();
  await expect(pinyin.nth(0)).toHaveValue("custom pronunciation");
  await expect(pinyin.nth(1)).toHaveValue("zài jiàn。");

  await expect(editor.locator("#save-state")).toBeEmpty();

  const stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.segments.map((segment) => segment.pinyin)).toEqual([
    "custom pronunciation",
    "zài jiàn。",
  ]);

  await editor.reload();
  const reloadedPinyin = editor.locator(
    '.segment-row textarea[data-field="pinyin"]',
  );
  await expect(generate).toBeHidden();
  await expect(reloadedPinyin).toHaveCount(2);
  await expect(reloadedPinyin.nth(0)).toHaveValue("custom pronunciation");
});

test("shows generated Pinyin in the table and synchronized preview", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({
    target: "Hello.",
    targetTrackName: "English",
    translation: "你好。",
    translationTrackName: "Chinese (Traditional)",
  });
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.languageCode = "zh-Hans";
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(
    editor.locator("#translation-heading #generate-pinyin"),
  ).toBeVisible();
  await editor.locator("#generate-pinyin").click();

  const tablePinyin = editor.locator(
    '.segment-row textarea[data-field="pinyin"]',
  );
  await expect(tablePinyin).toHaveValue("nǐ hǎo。");
  await editor
    .getByRole("button", { name: "Move Chinese up", exact: true })
    .click();
  const chineseGroup = editor.locator(".preview-language").first();
  await expect(chineseGroup).toHaveAttribute("data-language", "translation");
  await expect(chineseGroup.locator("#preview-pinyin")).toHaveValue("nǐ hǎo。");
  await expect(editor.locator("#preview-pinyin")).toHaveValue("nǐ hǎo。");
  await expect(editor.locator("#pinyin-heading")).toBeVisible();
  await expect(
    editor.getByText("Pinyin (optional)", { exact: true }),
  ).toHaveCount(0);

  await editor.setViewportSize({ width: 600, height: 800 });
  await expect
    .poll(() =>
      editor
        .locator("#editor")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(1);
  expect(
    await editor.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("hides Pinyin generation when neither caption track is Chinese", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ target: "Hello.", targetTrackName: "English" });
  draft.targetTrack.languageCode = "en";
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await expect(editor.locator("#generate-pinyin")).toBeHidden();
  await expect(
    editor.locator('.segment-row textarea[data-field="pinyin"]'),
  ).toHaveCount(0);
  await expect(editor.locator("#download-apkg")).toBeEnabled();
});

test("keeps exact long cues selected without row statuses", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  draft.segments[0].endMs = draft.segments[0].startMs + 6_001;
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await expect(editor.locator(".row-status")).toHaveCount(0);
  await expect(
    editor.locator(".segment-row input[type=checkbox]"),
  ).toBeChecked();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
});

test("previews without persisting preview state or changing export selection", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.segments.push({
    ...draft.segments[0],
    endMs: 5_875,
    identity: "v4_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    startMs: 4_250,
    target: "再见。",
    translation: "Goodbye.",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: previewPlayerFixture,
    }),
  );

  const editor = await context.newPage();
  const pageErrors = [];
  editor.on("pageerror", (error) => pageErrors.push(error.message));
  await editor.emulateMedia({ reducedMotion: "reduce" });
  await editor.addInitScript(() => {
    if (window !== window.top) return;
    window.__draftSaveCount = 0;
    window.__previewCommands = [];
    window.__playerCommands = [];
    const setStorage = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items) => {
      if (Object.keys(items).some((key) => key.startsWith("draft:"))) {
        window.__draftSaveCount += 1;
      }
      return setStorage(items);
    };
    window.addEventListener("message", (event) => {
      if (event.data?.type === "yt2anki-preview-command") {
        const { id, channel, ...command } = JSON.parse(event.data.payload);
        window.__playerCommands.push(command);
        if (command.func === "loadVideoById")
          window.__previewCommands.push(command);
      }
    });
  });
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  const preview = editor.locator("#preview");
  await expect(editor.locator(".segment-row.active")).toHaveCount(1);
  await expect(editor.locator("#preview-controls")).toBeVisible();
  const initialPreview = await preview.getAttribute("src");
  expect(new URL(initialPreview).searchParams.get("autoplay")).toBe("0");
  expect(initialPreview).not.toContain("start=");
  expect(initialPreview).not.toContain("end=");
  const params = new URL(initialPreview).searchParams;
  for (const [key, value] of Object.entries({
    controls: "0",
    fs: "0",
    iv_load_policy: "3",
    rel: "0",
    disablekb: "0",
  }))
    expect(params.get(key)).toBe(value);
  const captionCommand = {
    event: "command",
    func: "setOption",
    args: ["captions", "track", {}],
  };
  await expect
    .poll(() =>
      editor.evaluate(() =>
        window.__playerCommands.filter(
          (command) => command.func === "setOption",
        ),
      ),
    )
    .toEqual([captionCommand]);
  expect(await editor.evaluate(() => window.__previewCommands)).toEqual([]);
  const videoFrame = editor
    .frames()
    .find((frame) => frame.url().startsWith("https://www.youtube.com/embed/"));
  for (const event of ["onApiChange", "onStateChange"]) {
    await videoFrame.evaluate(
      (event) => parent.postMessage(JSON.stringify({ event }), "*"),
      event,
    );
  }
  await expect
    .poll(() =>
      editor.evaluate(
        () =>
          window.__playerCommands.filter(
            (command) => command.func === "setOption",
          ).length,
      ),
    )
    .toBe(3);
  await editor.evaluate(() => {
    window.postMessage(JSON.stringify({ event: "onStateChange" }), "*");
  });
  await videoFrame.evaluate(() => {
    parent.postMessage("invalid JSON", "*");
    parent.postMessage(JSON.stringify({ event: "onStateChange" }), "*");
  });
  await expect
    .poll(() =>
      editor.evaluate(
        () =>
          window.__playerCommands.filter(
            (command) => command.func === "setOption",
          ).length,
      ),
    )
    .toBe(4);
  expect(pageErrors).toEqual([]);
  expect(await editor.evaluate(() => window.__previewCommands)).toEqual([]);

  const firstCheckbox = editor.locator(".segment-checkbox").first();
  await firstCheckbox.uncheck();
  await expect(editor.locator("#save-state")).toBeEmpty();
  const savesAfterSelection = await editor.evaluate(
    () => window.__draftSaveCount,
  );
  await expect(editor.locator(".segment-row").first()).toHaveClass(/active/u);
  await expect(preview).toHaveAttribute("src", initialPreview);
  await expect(editor.locator("#preview-controls")).toBeVisible();

  await editor.locator(".row-preview-button").nth(1).click();
  await expect(editor.locator(".segment-row").nth(1)).toHaveClass(/active/u);
  await expect(editor.locator("#preview-controls")).toBeVisible();
  await expect(editor.locator(".segment-checkbox").nth(1)).toBeChecked();
  const segmentPreview = await preview.getAttribute("src");
  expect(segmentPreview).toBe(initialPreview);
  await expect
    .poll(() => editor.evaluate(() => window.__previewCommands.at(-1)))
    .toEqual({
      args: [
        {
          endSeconds: 5.875,
          startSeconds: 4.25,
          videoId: VIDEO_ID,
        },
      ],
      event: "command",
      func: "loadVideoById",
    });
  await editor.waitForTimeout(400);
  expect(await editor.evaluate(() => window.__draftSaveCount)).toBe(
    savesAfterSelection,
  );

  const stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.segments[0].selected).toBe(false);
  expect(stored.segments[1].selected).toBe(true);
});
test("requests opening permission only after download and announces it accessibly", async ({
  extension,
}) => {
  const { context } = extension;
  await installPackageSpies(context);
  const editor = await openPackageDraftEditor(extension);
  await editor.evaluate(() => {
    chrome.permissions.contains = async () => false;
    globalThis.__permissionRequests = 0;
    chrome.permissions.request = () => {
      globalThis.__permissionRequests++;
      return new Promise((resolve) => {
        globalThis.__finishPermission = resolve;
      });
    };
  });
  await clickPackageDownload(editor);
  await expect(editor.locator("#export-status")).toHaveText(
    "Package download started. Draft kept.",
  );
  expect(await editor.evaluate(() => globalThis.__permissionRequests)).toBe(0);
  await editor.locator("#download-apkg").click();
  await expect(editor.locator("#download-apkg")).toBeDisabled();
  await expect(editor.locator("#package-action-label")).toHaveText(
    "Open in Anki",
  );
  await expect(editor.locator("#export-progress")).toHaveText(
    "Requesting permission…",
  );
  await expect(editor.locator("#export-progress")).toHaveClass(
    /visually-hidden/u,
  );
  expect(await labelOverflow(editor, "#package-action-label")).toBe(0);
  await editor.evaluate(() => globalThis.__finishPermission(true));
  await expect(editor.locator("#export-status")).toHaveText(
    "Permission granted. Click Open in Anki.",
  );
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual(
    [],
  );
  expect(
    await editor.evaluate(() => globalThis.__packageDownloadNames),
  ).toHaveLength(1);
  // The one live region carries the outcome; the visible status is not a
  // second announcer, so it no longer has a status role of its own.
  await expect(editor.locator("#export-progress")).toHaveText(
    "Permission granted. Click Open in Anki.",
  );
  await expect(editor.locator("#export-status")).not.toHaveAttribute("role");
  // The outcome sits under the fields it belongs to and never leaves the
  // window, however narrow the editor gets.
  for (const width of [1280, 900, 390]) {
    await editor.setViewportSize({ width, height: 900 });
    const fields = await editor.locator(".preview-editor").boundingBox();
    const status = await editor.locator("#export-status").boundingBox();
    expect(status.y, `${width}px`).toBeGreaterThanOrEqual(
      fields.y + fields.height,
    );
    expect(status.x, `${width}px`).toBeCloseTo(fields.x, 0);
    expect(status.x + status.width, `${width}px`).toBeLessThanOrEqual(width);
  }
});

test("downloads a browser-built package and keeps the Draft for recovery", async ({
  extension,
}) => {
  const { context, worker } = extension;
  await installPackageSpies(context);
  const editor = await openPackageDraftEditor(extension);
  await editor
    .locator('.segment-row textarea[data-field="target"]')
    .fill("edited immediately before export");
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  const downloadWidth = (await editor.locator("#download-apkg").boundingBox())
    .width;
  const download = await clickPackageDownload(editor);
  const stream = await download.createReadStream();
  const entries = unzipSync(Buffer.concat(await stream.toArray()));

  expect(download.suggestedFilename()).toBe("Fixture video - abcdefghijk.apkg");
  expect(Object.keys(entries).sort()).toEqual([
    "collection.anki21b",
    "media",
    "meta",
  ]);
  await expect(editor.locator("#export-status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeEnabled();
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).not.toBeFocused();
  expect((await editor.locator("#download-apkg").boundingBox()).width).toBe(
    downloadWidth,
  );
  const latestDownloadId = await editor.evaluate(() =>
    globalThis.__packageDownloadIds.at(-1),
  );
  await editor.evaluate(() => {
    let deferOpen = true;
    chrome.downloads.open = (downloadId) => {
      globalThis.__openedPackageIds.push(downloadId);
      if (!deferOpen) {
        return Promise.resolve();
      }
      deferOpen = false;
      return new Promise((resolve) => {
        globalThis.__finishPackageOpen = resolve;
      });
    };
  });
  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .focus();
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeFocused();
  await editor.keyboard.press("Enter");
  await expect(editor.locator("#download-apkg")).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeDisabled();
  await editor.evaluate(() => globalThis.__finishPackageOpen());
  await expect(editor.locator("#export-status")).toHaveText(
    "Open request sent. Confirm the import in Anki.",
  );
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeEnabled();
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    latestDownloadId,
  ]);
  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    latestDownloadId,
    latestDownloadId,
  ]);
  await editor
    .locator('.segment-row textarea[data-field="target"]')
    .first()
    .fill("edited for a fresh package");
  await clickPackageDownload(editor);
  await expect(editor.locator("#export-status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  const replacementDownloadId = await editor.evaluate(() =>
    globalThis.__packageDownloadIds.at(-1),
  );
  expect(replacementDownloadId).not.toBe(latestDownloadId);
  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual([
    latestDownloadId,
    latestDownloadId,
    replacementDownloadId,
  ]);
  await editor
    .locator('.segment-row textarea[data-field="translation"]')
    .first()
    .fill("changed after download");
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(editor.locator("#export-status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  await editor
    .locator('.segment-row textarea[data-field="translation"]')
    .first()
    .fill("changed again after download");
  await expect(editor.locator("#export-status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  await clickPackageDownload(editor);
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  await editor
    .locator('.segment-row textarea[data-field="target"]')
    .first()
    .fill("");
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(editor.locator("#export-status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  await editor.waitForTimeout(500);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
  expect(
    (await extensionStorage(worker, "session"))[`draft:${VIDEO_ID}`],
  ).toBeUndefined();
  await expect(editor.locator("#download-apkg")).toBeDisabled();
});

test("keeps the existing package when opening permission is denied", async ({
  extension,
}) => {
  const { context, worker } = extension;
  await installPackageSpies(context);
  await context.addInitScript(() => {
    const contains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = async (permissions) =>
      permissions.permissions?.includes("downloads")
        ? false
        : contains(permissions);
    globalThis.__permissionRequests = 0;
    chrome.permissions.request = async () => {
      globalThis.__permissionRequests++;
      return false;
    };
  });
  const editor = await openPackageDraftEditor(extension);
  const download = await clickPackageDownload(editor);
  expect(download.suggestedFilename()).toBe("Fixture video - abcdefghijk.apkg");
  await expect(editor.locator("#export-status")).toHaveText(
    "Package download started. Draft kept.",
  );
  expect(await editor.evaluate(() => globalThis.__permissionRequests)).toBe(0);
  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();
  await expect(editor.locator("#export-status")).toHaveText(
    "Package download started. Draft kept. Open the .apkg from Chrome Downloads or File Explorer.",
  );
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeEnabled();
  expect(
    await editor.evaluate(() => globalThis.__packageDownloadNames),
  ).toHaveLength(1);
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual(
    [],
  );
  expect(await editor.evaluate(() => globalThis.__permissionRequests)).toBe(1);
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeDefined();
});

test("keeps the Draft when the tracked package download is interrupted", async ({
  extension,
}) => {
  const { context, worker } = extension;
  await context.addInitScript(() => {
    chrome.downloads.onCreated.addListener((item) => {
      if (item.url.startsWith("blob:")) {
        void chrome.downloads.cancel(item.id);
      }
    });
  });
  const editor = await openPackageDraftEditor(extension);
  await editor.locator("#download-apkg").click();

  await expect(editor.locator("#export-status")).toHaveText(
    "Package download did not finish. Draft kept.",
  );
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("falls back to a manual package open after Chrome rejects the open request", async ({
  extension,
}) => {
  const { context } = extension;
  await context.addInitScript(() => {
    chrome.downloads.open = async () => {
      throw new Error("Chrome-specific failure");
    };
  });
  const editor = await openPackageDraftEditor(extension);
  await clickPackageDownload(editor);
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();

  await expect(editor.locator("#export-status")).toHaveText(
    "Could not open the downloaded package. Open it from Chrome Downloads or File Explorer.",
  );
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
});

test("requires a new package when a completed download disappears", async ({
  extension,
}) => {
  const { context, worker } = extension;
  await installPackageSpies(context);
  const editor = await openPackageDraftEditor(extension);
  await clickPackageDownload(editor);
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  const downloadId = await editor.evaluate(() =>
    globalThis.__packageDownloadIds.at(-1),
  );
  await editor.evaluate((id) => chrome.downloads.erase({ id }), downloadId);

  await editor
    .getByRole("button", { name: "Open in Anki", exact: true })
    .click();

  await expect(editor.locator("#export-status")).toHaveText(
    "Downloaded package is missing. Download a new .apkg.",
  );
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  expect(await editor.evaluate(() => globalThis.__openedPackageIds)).toEqual(
    [],
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
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
    .locator('.segment-row textarea[data-field="target"]')
    .fill("unsaved edit");
  await expect(editor.locator("#save-state")).toBeEmpty();
  await expect(editor.locator("#save-state")).toHaveClass(/visually-hidden/u);
  await expect(editor.locator("#draft-status")).toHaveText(
    "Draft could not be saved. Your latest changes may be lost if you close this editor.",
  );

  const stored = await extensionStorage(worker);
  expect(stored[`draft:${VIDEO_ID}`].segments[0].target).toBe("你好。");
});

test("invalidates a completed package when its Draft is regenerated", async ({
  extension,
}) => {
  const { worker } = extension;
  const stale = createDraft({ translation: "Hello." });
  const editor = await openPackageDraftEditor(extension, stale);
  await clickPackageDownload(editor);
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  const replacement = createDraft({
    target: "Fresh Draft",
    translation: "Fresh",
  });
  replacement.generationId = "replacement-generation";
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: replacement });
  await expect(editor.locator("#save-state")).toBeEmpty();
  await expect(editor.locator("#save-state")).toHaveClass(/visually-hidden/u);
  await expect(editor.locator("#draft-status")).toHaveText(
    "This Draft was replaced by a newer generation. Use the newer editor tab.",
  );
  await expect(editor.locator("#export-status")).toBeEmpty();
  await expect(editor.locator("#segment-list")).toHaveAttribute("inert", "");
  await expect(
    editor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  const stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.generationId).toBe("replacement-generation");
  expect(stored.segments[0].target).toBe("Fresh Draft");
});

test("Select all keeps Target-only rows valid and skips Segments without Target text", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft();
  draft.segments.push({
    ...draft.segments[0],
    identity: "v4_BBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcde",
    selected: true,
    target: "",
  });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator(".row-status")).toHaveCount(0);

  await editor.locator("#select-all").click();
  await expect(editor.locator("#selection-summary")).toHaveText("1/2");
  await expect(editor.locator("#select-all")).toHaveAttribute(
    "aria-label",
    "Select all Segments, 1 of 2 selected",
  );
  await expect(editor.locator("#save-state")).toBeEmpty();
  await expect
    .poll(async () => {
      const saved = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
      return saved.segments.map((segment) => segment.selected);
    })
    .toEqual([true, false]);
  let stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.segments.map((segment) => segment.selected)).toEqual([
    true,
    false,
  ]);

  await editor.locator("#select-all").click();
  await expect(editor.locator("#select-all")).toHaveAttribute(
    "aria-label",
    "Select all Segments, 0 of 2 selected",
  );
  await expect(editor.locator("#save-state")).toBeEmpty();
  await expect
    .poll(async () => {
      const saved = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
      return saved.segments.map((segment) => segment.selected);
    })
    .toEqual([false, false]);
  stored = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(stored.segments.every((segment) => !segment.selected)).toBe(true);
});
test("runs fresh preflight despite stale stored incompatibility", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.video.compatibility.hasOpus = false;
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await installPackageSpies(context);

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#export-status")).toBeEmpty();
  await expect(editor.locator("#download-apkg")).toBeEnabled();
  await editor.locator("#download-apkg").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("blocks export when the fresh playback preflight fails", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  const source = context
    .pages()
    .find((page) => page.url() === `https://m.youtube.com/watch?v=${VIDEO_ID}`);
  await source.evaluate(() => {
    document
      .querySelector("#movie_player")
      .getPlayerResponse().playabilityStatus.playableInEmbed = false;
  });
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#export-status")).toBeEmpty();
  await editor.locator("#download-apkg").click();
  await expect(editor.locator("#export-status")).toHaveText(
    "This Source Video cannot play in Anki.",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("reconnects the Source Video after its recorded tab disappears", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.sourceTabId = 2_147_483_647;
  await worker.evaluate(
    (storedDraft) =>
      chrome.storage.local.set({
        [`draft:${storedDraft.video.videoId}`]: storedDraft,
      }),
    draft,
  );
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await installPackageSpies(context);
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await editor.locator("#download-apkg").click();

  await expect(editor.locator("#export-status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("keeps the Draft when no matching Source Video tab is open", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  draft.sourceTabId = 2_147_483_647;
  await worker.evaluate(
    (storedDraft) =>
      chrome.storage.local.set({
        [`draft:${storedDraft.video.videoId}`]: storedDraft,
      }),
    draft,
  );
  const source = context
    .pages()
    .find((page) => page.url() === `https://m.youtube.com/watch?v=${VIDEO_ID}`);
  await source.close();
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await installPackageSpies(context);
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  await editor.locator("#download-apkg").click();

  await expect(editor.locator("#export-status")).toHaveText(
    "Reopen the Source Video before exporting.",
  );
  expect((await extensionStorage(worker))[`draft:${VIDEO_ID}`]).toBeTruthy();
});

test("stops stale-background recovery after one reload", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await installStalePreflight(context, { always: true });
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  const resumedEditorPromise = waitForResumedEditor(context);
  await editor.locator("#download-apkg").click();
  const resumedEditor = await resumedEditorPromise;
  await expect(resumedEditor.locator("#export-status")).toHaveText(
    "yt2anki could not refresh its background process. Reopen the editor and try again.",
  );
  expect(
    await resumedEditor.evaluate(() =>
      localStorage.getItem("stale-preflight-count"),
    ),
  ).toBe("2");
  expect(
    await resumedEditor.evaluate(
      (videoId) =>
        chrome.storage.local
          .get(`draft:${videoId}`)
          .then((stored) => stored[`draft:${videoId}`]),
      VIDEO_ID,
    ),
  ).toBeTruthy();
  await expect(resumedEditor).toHaveURL(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
});

test("reloads a stale background and resumes package download once", async ({
  extension,
}) => {
  const { context, extensionId, worker } = extension;
  const draft = createDraft({ translation: "Hello." });
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  await installStalePreflight(context);
  await installPackageSpies(context);
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );

  const resumedEditorPromise = waitForResumedEditor(context);
  await editor.locator("#download-apkg").click();
  const resumedEditor = await resumedEditorPromise;
  await expect(resumedEditor.locator("#export-status")).toHaveText(
    "Package downloaded. Draft kept.",
  );
  // Recovery downloads can finish before Playwright returns the resumed page.
  // Check Chrome's retained records instead of waiting for an event already sent.
  const downloads = await resumedEditor.evaluate(() =>
    chrome.downloads.search({}),
  );
  expect(downloads).toHaveLength(1);
  expect(downloads[0].state).toBe("complete");
  expect(
    await resumedEditor.evaluate(() => globalThis.__packageDownloadNames),
  ).toEqual(["Fixture video - abcdefghijk.apkg"]);
  expect(
    await resumedEditor.evaluate(() =>
      localStorage.getItem("stale-preflight-count"),
    ),
  ).toBe("2");
  await expect(
    resumedEditor.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeVisible();
  expect(
    await resumedEditor.evaluate(
      (videoId) =>
        chrome.storage.local
          .get(`draft:${videoId}`)
          .then((stored) => stored[`draft:${videoId}`]),
      VIDEO_ID,
    ),
  ).toBeTruthy();
  const sessionStorage = await extensionStorage(worker, "session");
  expect(sessionStorage[`draft:${VIDEO_ID}`]).toBeUndefined();
  await expect(resumedEditor).toHaveURL(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
});

test("fresh generation replaces saved selections and selects every Segment", async ({
  extension,
}) => {
  const { context, extensionId, messenger, worker } = extension;
  const saved = createDraft({ translation: "Old text." });
  saved.segments[0].selected = false;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: saved,
  });
  await openYouTubeFixture(context);
  const [sourceTab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://www.youtube.com/watch*" }),
  );
  await worker.evaluate(
    (tabId) => chrome.tabs.update(tabId, { active: true }),
    sourceTab.id,
  );

  const popupPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/popup/popup.html"),
  );
  await worker.evaluate(
    (url) => chrome.tabs.create({ active: false, url }),
    `chrome-extension://${extensionId}/popup/popup.html`,
  );
  const popup = await popupPromise;
  await expect(popup.locator("#primary-action")).toHaveText("Editor Preview");
  await expect(popup.locator("#primary-action")).toBeEnabled();

  const editorPromise = context.waitForEvent("page", (page) =>
    page.url().includes("/editor/editor.html"),
  );
  const generation = await extensionMessage(messenger, {
    tabId: sourceTab.id,
    targetTrackId: ".zh-Hans",
    translationTrackId: ".en-GB",
    type: "generate",
  });
  const editor = await editorPromise;
  expect(generation.ok).toBe(true);
  await expect(editor.locator("#selection-summary")).toHaveText("3/3");
  const generated = (await extensionStorage(worker))[`draft:${VIDEO_ID}`];
  expect(generated.segments.every((segment) => segment.selected)).toBe(true);
  expect(generated.segments[0].translation).toBe("Hello world.");
});

async function installStalePreflight(context, { always = false } = {}) {
  await context.exposeBinding("__openRecoveryEditor", async (_source, url) => {
    // Attach Playwright before navigation so init scripts precede automatic
    // export. chrome.tabs.create can start extension code before attachment.
    const page = await context.newPage();
    await page.goto(url);
  });
  await context.addInitScript(
    ({ rejectEveryPreflight }) => {
      if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") {
        return;
      }
      const originalSendMessage = chrome.runtime.sendMessage.bind(
        chrome.runtime,
      );
      chrome.runtime.reload = () => {
        void chrome.storage.session
          .clear()
          .then(() => chrome.storage.local.get("pending-export-recovery"))
          .then(async (stored) => {
            const recovery = stored["pending-export-recovery"];
            await chrome.storage.local.remove("pending-export-recovery");
            const url = new URL(chrome.runtime.getURL("editor/editor.html"));
            url.searchParams.set("video", recovery.videoId);
            url.searchParams.set("resumeExport", recovery.action);
            url.searchParams.set("generation", recovery.generationId);
            await globalThis.__openRecoveryEditor(url.href);
          });
      };
      chrome.runtime.sendMessage = async (message) => {
        if (message.type === "preflight") {
          const count = Number(localStorage.getItem("stale-preflight-count"));
          localStorage.setItem("stale-preflight-count", String(count + 1));
          if (rejectEveryPreflight || count === 0) {
            return {
              error: {
                code: "INVALID_REQUEST",
                message: "Unknown extension request.",
              },
              ok: false,
            };
          }
        }
        return originalSendMessage(message);
      };
    },
    { rejectEveryPreflight: always },
  );
}

async function waitForResumedEditor(context) {
  return context.waitForEvent("page");
}

async function openPackageDraftEditor(
  { context, extensionId, worker },
  draft = createDraft({ translation: "Hello." }),
) {
  await setExtensionStorage(worker, { [`draft:${VIDEO_ID}`]: draft });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );
  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  return editor;
}

async function clickPackageDownload(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-apkg").click();
  return downloadPromise;
}

async function openToolbarPopup({ context, extensionId, worker }) {
  const cdp = await context.newCDPSession(context.pages()[0]);
  const before = await cdp.send("Target.getTargets");
  const existingTargets = new Set(
    before.targetInfos.map((target) => target.targetId),
  );
  await worker.evaluate(() => chrome.action.openPopup());
  await cdp.detach();
  return waitForToolbarPopup({
    context,
    excludedTargetIds: [...existingTargets],
    extensionId,
  });
}

async function waitForToolbarPopup({
  context,
  excludedTargetIds = [],
  extensionId,
}) {
  const cdp = await context.newCDPSession(context.pages()[0]);
  const excluded = new Set(excludedTargetIds);
  let popupTarget;
  await expect
    .poll(async () => {
      const targets = await cdp.send("Target.getTargets");
      popupTarget = targets.targetInfos.find(
        (target) =>
          !excluded.has(target.targetId) &&
          target.url === `chrome-extension://${extensionId}/popup/popup.html`,
      );
      return popupTarget !== undefined;
    })
    .toBe(true);

  const { sessionId } = await cdp.send("Target.attachToTarget", {
    flatten: false,
    targetId: popupTarget.targetId,
  });
  let commandId = 0;
  const send = async (method, params = {}) => {
    const id = ++commandId;
    const response = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.sessionId !== sessionId) {
          return;
        }
        const message = JSON.parse(event.message);
        if (message.id !== id) {
          return;
        }
        cdp.off("Target.receivedMessageFromTarget", onMessage);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      };
      cdp.on("Target.receivedMessageFromTarget", onMessage);
    });
    await cdp.send("Target.sendMessageToTarget", {
      message: JSON.stringify({ id, method, params }),
      sessionId,
    });
    return response;
  };

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };

  return {
    targetId: popupTarget.targetId,
    async click(selector) {
      const bounds = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!bounds) {
        throw new Error(`Toolbar popup element not found: ${selector}`);
      }
      await send("Input.dispatchMouseEvent", {
        button: "left",
        clickCount: 1,
        type: "mousePressed",
        x: bounds.x,
        y: bounds.y,
      });
      await send("Input.dispatchMouseEvent", {
        button: "left",
        clickCount: 1,
        type: "mouseReleased",
        x: bounds.x,
        y: bounds.y,
      });
    },
    async close() {
      await send("Runtime.evaluate", { expression: "window.close()" }).catch(
        () => undefined,
      );
      await cdp
        .send("Target.detachFromTarget", { sessionId })
        .catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
    evaluate,
  };
}

async function installDeferredPopupPermission(
  worker,
  initiallyGranted,
  action = "package",
) {
  await worker.evaluate(
    ({ granted, action }) => {
      globalThis.__popupPermissionRequestStarted = false;
      globalThis.__resolvePopupPermissionRequest = undefined;
      const contains = chrome.permissions.contains.bind(chrome.permissions);
      const request = chrome.permissions.request.bind(chrome.permissions);
      const matches = (permissions) =>
        action === "preview"
          ? permissions.origins?.includes("https://www.youtube.com/*")
          : permissions.permissions?.includes("downloads");
      chrome.permissions.contains = async (permissions) =>
        matches(permissions) ? granted : contains(permissions);
      chrome.permissions.request = (permissions) => {
        if (!matches(permissions)) {
          return request(permissions);
        }
        globalThis.__popupPermissionRequestStarted = true;
        return new Promise((resolve) => {
          globalThis.__resolvePopupPermissionRequest = resolve;
        });
      };
    },
    { granted: initiallyGranted, action },
  );
}

async function installPackageSpies(context) {
  await context.addInitScript(() => {
    globalThis.__packageDownloadIds = [];
    globalThis.__packageDownloadNames = [];
    globalThis.__openedPackageIds = [];
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.href.startsWith("blob:")) {
        globalThis.__packageDownloadNames.push(this.download);
      }
      return anchorClick.call(this);
    };
    chrome.downloads.onCreated.addListener((item) => {
      if (item.url.startsWith("blob:")) {
        globalThis.__packageDownloadIds.push(item.id);
      }
    });
    chrome.downloads.open = async (downloadId) => {
      globalThis.__openedPackageIds.push(downloadId);
    };
  });
}

async function openYouTubeFixture(
  context,
  {
    agreedContinuation = false,
    brokenInitially = false,
    canonicalizeStandardKindDuringCapture = false,
    discardInspectionResult = false,
    extraUnsupportedTracks = false,
    freshPlayerFailure = false,
    freshTrackMismatch = false,
    includeEmbedFlag = true,
    includeAutoGeneratedTrack = false,
    invalidTranslationDuration = false,
    missingPoToken = false,
    missingSupportedTrackId = false,
    navigateDuringCapture = false,
    captionRateLimited = false,
    changeTrackAfterInspection = false,
    changeTrackDuringCapture = false,
    onlyAutoGeneratedTrack = false,
    sameLocaleAlternative = false,
    singleStandardTrack = false,
    standardCapsAsr = false,
    targetAsrUrlOnly = false,
    targetMetadataKind = null,
    targetPayloadMode = "valid",
    targetUrlKind = null,
    timedTextDelayMs = 0,
    timedTextUnavailableLanguages = [],
    timedTextTimeout = false,
    translationAlignmentGap = false,
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
  const translationJson = {
    events: [
      ...(agreedContinuation
        ? [
            {
              dDurationMs: invalidTranslationDuration ? 0 : 1_500,
              segs: [{ utf8: "Hello," }],
              tStartMs: 1_000,
            },
            {
              dDurationMs: 1_500,
              segs: [{ utf8: "world." }],
              tStartMs: 2_500,
            },
          ]
        : [
            {
              dDurationMs: invalidTranslationDuration ? 0 : 3_000,
              segs: [{ utf8: "Hello world." }],
              tStartMs: 1_000,
            },
          ]),
      ...(translationAlignmentGap
        ? []
        : [
            {
              dDurationMs: 1_000,
              segs: [{ utf8: "Goodbye." }],
              tStartMs: 6_000,
            },
          ]),
    ],
  };
  const supportedTracks = [
    {
      baseUrl: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hans&signature=target-signed&xosf=1${standardCapsAsr ? "&caps=asr" : ""}${targetAsrUrlOnly ? "&kind=asr" : targetUrlKind ? `&kind=${targetUrlKind}` : ""}${missingPoToken ? "&exp=xpe" : ""}`,
      languageCode: "zh-Hans",
      name: { simpleText: "Chinese (Simplified)" },
      ...(targetMetadataKind ? { kind: targetMetadataKind } : {}),
      ...(missingSupportedTrackId ? {} : { vssId: ".zh-Hans" }),
    },
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-GB&signature=translation-signed&xosf=1",
      languageCode: "en-GB",
      name: { simpleText: "English (United Kingdom)" },
      vssId: ".en-GB",
    },
    ...(sameLocaleAlternative
      ? [
          {
            baseUrl:
              "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-Hans&name=alternate",
            languageCode: "zh-Hans",
            name: { simpleText: "Chinese (Simplified)" },
            vssId: ".zh-Hans-alt",
          },
        ]
      : []),
  ];
  const unsupportedTracks = [
    {
      baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=da",
      kind: 7,
      languageCode: "da",
      name: { simpleText: "Danish malformed metadata kind" },
      vssId: ".da-malformed-metadata",
    },
    {
      baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=nl",
      kind: "forced",
      languageCode: "nl",
      name: { simpleText: "Dutch forced metadata" },
      vssId: ".nl-forced-metadata",
    },
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&kind=forced",
      languageCode: "fr",
      name: { simpleText: "French forced" },
      vssId: ".fr-forced-url",
    },
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=de&kind=future-kind",
      languageCode: "de",
      name: { simpleText: "German unknown URL kind" },
      vssId: ".de-unknown-url",
    },
    {
      baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=es",
      kind: "future-kind",
      languageCode: "es",
      name: { simpleText: "Spanish unknown metadata kind" },
      vssId: ".es-unknown-metadata",
    },
    {
      baseUrl:
        "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=it&tlang=en",
      languageCode: "it",
      name: { simpleText: "Italian translated" },
      vssId: ".it-translated",
    },
  ];
  const autoGeneratedTrack = {
    baseUrl:
      "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr",
    kind: "asr",
    languageCode: "en",
    name: { simpleText: "English (auto-generated)" },
    vssId: ".auto-en",
  };
  const tracks = onlyAutoGeneratedTrack
    ? [autoGeneratedTrack]
    : singleStandardTrack
      ? [supportedTracks[0]]
      : [
          ...supportedTracks,
          ...(includeAutoGeneratedTrack ? [autoGeneratedTrack] : []),
          ...(extraUnsupportedTracks ? unsupportedTracks : []),
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
  page.__yt2ankiRequests = [];
  page.__yt2ankiTimedTextUrls = [];
  page.__yt2ankiTimedTextRequests = [];
  page.__yt2ankiPlayerRequests = [];
  await page.route(
    "https://www.youtube.com/youtubei/v1/player**",
    async (route) => {
      page.__yt2ankiRequests.push("/youtubei/v1/player");
      const request = route.request();
      const headers = await request.allHeaders();
      page.__yt2ankiPlayerRequests.push({
        body: request.postDataJSON(),
        clientName: headers["x-youtube-client-name"],
        clientVersion: headers["x-youtube-client-version"],
        cookie: headers.cookie,
        query: new URL(request.url()).search,
        visitorData: headers["x-goog-visitor-id"],
      });
      if (freshPlayerFailure) {
        return route.fulfill({ status: 500 });
      }
      const freshResponse = await page.evaluate(
        () => window.__fixtureResponse ?? window.__playerResponse,
      );
      if (freshTrackMismatch) {
        freshResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].vssId =
          ".different";
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(freshResponse),
      });
    },
  );
  await page.route("https://www.youtube.com/api/timedtext**", async (route) => {
    const url = new URL(route.request().url());
    const headers = await route.request().allHeaders();
    page.__yt2ankiTimedTextRequests.push({
      cookie: headers.cookie,
    });
    page.__yt2ankiTimedTextUrls.push(url.href);
    page.__yt2ankiRequests.push(
      `/api/timedtext?lang=${url.searchParams.get("lang")}&fmt=${url.searchParams.get("fmt")}`,
    );
    if (timedTextDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, timedTextDelayMs));
    }
    if (captionRateLimited && url.searchParams.get("lang") === "zh-Hans") {
      return route.fulfill({ status: 429 });
    }
    if (timedTextTimeout && url.searchParams.get("lang") === "zh-Hans") {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      return route.fulfill({ status: 504 });
    }
    if (timedTextUnavailableLanguages.includes(url.searchParams.get("lang"))) {
      return route.fulfill({ status: 500 });
    }
    const language = url.searchParams.get("lang");
    if (canonicalizeStandardKindDuringCapture && language === "zh-Hans") {
      await page.evaluate(() => {
        window.__playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].kind =
          "standard";
      });
    }
    if (navigateDuringCapture && language === "zh-Hans") {
      await page.evaluate(() => {
        const next = structuredClone(window.__fixtureResponse);
        next.videoDetails.videoId = "different01";
        window.__playerResponse = next;
        history.replaceState({}, "", "/watch?v=different01");
      });
    }
    if (changeTrackDuringCapture && language === "zh-Hans") {
      await page.evaluate(() => {
        const next = structuredClone(window.__playerResponse);
        next.captions.playerCaptionsTracklistRenderer.captionTracks[0].languageCode =
          "fr";
        window.__playerResponse = next;
      });
    }
    const body = url.searchParams.has("tlang")
      ? {
          events: [
            {
              dDurationMs: 1_000,
              segs: [{ utf8: "错误的自动翻译。" }],
              tStartMs: 1_000,
            },
          ],
        }
      : url.searchParams.get("name") === "alternate"
        ? {
            events: [
              {
                dDurationMs: 1_000,
                segs: [{ utf8: "选中的字幕。" }],
                tStartMs: 1_000,
              },
            ],
          }
        : language === "en-GB"
          ? translationJson
          : targetJson;
    if (language === "zh-Hans") {
      if (targetPayloadMode === "empty") {
        return route.fulfill({ contentType: "application/json", body: "" });
      }
      if (targetPayloadMode === "malformed") {
        return route.fulfill({
          contentType: "application/json",
          body: "{not-json",
        });
      }
      if (targetPayloadMode === "missing-duration") {
        const missingDuration = structuredClone(targetJson);
        delete missingDuration.events[0].dDurationMs;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(missingDuration),
        });
      }
      if (targetPayloadMode === "invalid-append") {
        const invalidAppend = structuredClone(targetJson);
        invalidAppend.events[0].aAppend = 2;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(invalidAppend),
        });
      }
      if (targetPayloadMode === "oversized") {
        const oversized = structuredClone(targetJson);
        oversized.events[0].segs[0].utf8 = "字".repeat(2_000_000);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(oversized),
        });
      }
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("https://www.youtube.com/watch**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <meta charset="utf-8">
        <title>Fixture video - YouTube</title>
        <div id="movie_player"></div>
        <script>
          ${
            discardInspectionResult || changeTrackAfterInspection
              ? `let captureApi;
                 Object.defineProperty(window, "__yt2ankiCapture", {
                   configurable: true,
                   get: () => captureApi,
                   set: (value) => {
                      captureApi = {
                        ...value,
                        inspect: () => {
                          ${
                            discardInspectionResult
                              ? "return undefined;"
                              : `const result = value.inspect();
                                 const next = structuredClone(window.__playerResponse);
                                 next.captions.playerCaptionsTracklistRenderer.captionTracks[0].languageCode = "fr";
                                 window.__playerResponse = next;
                                 return result;`
                          }
                        },
                      };
                    }
                  });`
              : ""
          }
          const response = ${JSON.stringify(playerResponse)};
          window.ytcfg = {
            get: (key) => ({
              INNERTUBE_API_KEY: "fixture-api-key",
              INNERTUBE_CONTEXT: {
                client: {
                   clientName: "WEB",
                   clientVersion: "fixture-current",
                   hl: "en",
                   timeZone: "Europe/Stockholm",
                   utcOffsetMinutes: 120,
                   visitorData: "fixture-visitor",
                 },
              },
            })[key],
          };
          window.__fixtureResponse = response;
          window.__playerResponse = ${brokenInitially ? "null" : "response"};
          const player = document.querySelector("#movie_player");
          window.__playerControlCalls = [];
          Object.assign(player, {
            getPlayerResponse: () => window.__playerResponse,
            loadModule: () => { window.__playerControlCalls.push("loadModule"); },
            pauseVideo: () => { window.__playerControlCalls.push("pauseVideo"); },
            playVideo: () => { window.__playerControlCalls.push("playVideo"); },
            setOption: (_namespace, option) => {
              window.__playerControlCalls.push("setOption:" + option);
            },
            unloadModule: () => { window.__playerControlCalls.push("unloadModule"); },
          });
        </script>`,
    }),
  );
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  return page;
}

test("order changes invalidate completed packages and lock during export", async ({
  extension,
}) => {
  await installPackageSpies(extension.context);
  const editor = await openPackageDraftEditor(extension);
  await clickPackageDownload(editor);
  await expect(editor.locator("#package-action-label")).toHaveText(
    "Open in Anki",
  );
  await editor
    .getByRole("button", { name: "Move English up", exact: true })
    .click();
  await expect(editor.locator("#package-action-label")).toHaveText(
    "Download .apkg",
  );
  await expect(editor.locator("#export-status")).toHaveText(
    "Draft changed. Download a new .apkg before opening it in Anki.",
  );
  await editor.evaluate(() => {
    chrome.permissions.contains = async () => false;
    chrome.permissions.request = () =>
      new Promise((resolve) => {
        globalThis.__finishOrderPermission = resolve;
      });
  });
  await clickPackageDownload(editor);
  await expect(editor.locator("#package-action-label")).toHaveText(
    "Open in Anki",
  );
  await editor.locator("#download-apkg").click();
  for (const button of await editor
    .locator(".field-order-actions button")
    .all())
    await expect(button).toBeDisabled();
  await editor.evaluate(() => globalThis.__finishOrderPermission(true));
  await expect(editor.locator("#package-action-label")).toHaveText(
    "Open in Anki",
  );
  await expect(
    editor.getByRole("button", { name: "Move English down", exact: true }),
  ).toBeEnabled();
  const draft = (await extensionStorage(extension.worker))["draft:abcdefghijk"];
  expect(draft.translationFirst).toBe(true);
});

// Overflow in CSS pixels of a label inside its fixed-width button. The package
// button never changes width, so a longer state label has to still fit.
async function labelOverflow(page, selector) {
  return page.locator(selector).evaluate((label) => {
    const button = label.closest("button");
    const style = getComputedStyle(button);
    const inner =
      button.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    const siblings = [...button.children]
      .filter((child) => child !== label)
      .reduce((total, child) => total + child.getBoundingClientRect().width, 0);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const available = inner - siblings - gap * (button.children.length - 1);
    return Math.max(0, Math.ceil(label.scrollWidth - available));
  });
}
