import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const extensionDir = resolve("dist");
const pickerScript = resolve("scripts/select-extension-folder.ps1");
const actionScript = resolve("scripts/invoke-extension-action.ps1");
const browsers = [
  {
    channel: "chrome",
    extensionsUrl: "chrome://extensions",
    name: "Google Chrome",
    nativeTrack: false,
    videoId: "boMXFNybOXY",
  },
  {
    channel: "msedge",
    extensionsUrl: "edge://extensions",
    name: "Microsoft Edge",
    nativeTrack: true,
    videoId: "APv9hfjYRY0",
  },
];

async function prepareTestExtension(directory) {
  await cp(extensionDir, directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions.push("https://www.youtube.com/*");
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function verifyPreview(page, videoId, browserName) {
  await expect.poll(
    async () => {
      const frame = page
        .frames()
        .find((candidate) =>
          candidate.url().startsWith(
            `https://www.youtube.com/embed/${videoId}`,
          ),
        );
      if (!frame) {
        return "loading";
      }
      try {
        return await frame.evaluate(() => {
          const text = document.body?.innerText ?? "";
          if (
            text.includes("Error 153") ||
            text.includes("Video player configuration error")
          ) {
            return "error 153";
          }
          return document.querySelector("video") ? "ready" : "loading";
        });
      } catch {
        return "loading";
      }
    },
    {
      intervals: [1_000],
      message: `${browserName} preview did not become playable`,
      timeout: 30_000,
    },
  ).toBe("ready");
}

async function enableDeveloperMode(page, channel) {
  if (channel === "chrome") {
    await page.evaluate(() => {
      const toolbar = document
        .querySelector("extensions-manager")
        ?.shadowRoot?.querySelector("extensions-toolbar");
      const toggle = toolbar?.shadowRoot?.querySelector("#devMode");
      if (!toggle) {
        throw new Error("The extensions developer controls are unavailable.");
      }
      if (toggle.getAttribute("aria-pressed") !== "true") {
        toggle.click();
      }
    });
    return;
  }

  await page.evaluate(() => {
    const toggle = document
      .querySelector("root-app")
      ?.shadowRoot?.querySelector("side-nav-pane")
      ?.shadowRoot?.querySelector("profile-toggles")
      ?.shadowRoot?.querySelector("developer-mode-switch")
      ?.shadowRoot?.querySelector("#dev-switch");
    if (!toggle) {
      throw new Error("The extensions developer controls are unavailable.");
    }
    if (toggle.getAttribute("checked") !== "true") {
      toggle.click();
    }
  });
}

async function openFolderPicker(page, channel) {
  if (channel === "chrome") {
    await page.evaluate(() => {
      const button = document
        .querySelector("extensions-manager")
        ?.shadowRoot?.querySelector("extensions-toolbar")
        ?.shadowRoot?.querySelector("#loadUnpacked");
      if (!button) {
        throw new Error("Load unpacked is unavailable.");
      }
      button.click();
    });
    return;
  }

  await page.evaluate(() => {
    const buttons = document
      .querySelector("root-app")
      ?.shadowRoot?.querySelector("my-extension-page")
      ?.shadowRoot?.querySelector("developer-mode-options-header")
      ?.shadowRoot?.querySelectorAll("fluent-button");
    const button = [...(buttons ?? [])].find(
      (candidate) => candidate.getAttribute("title") === "Load unpacked",
    );
    if (!button) {
      throw new Error("Load unpacked is unavailable.");
    }
    button.click();
  });
}

async function readExtensionDetails(page, channel) {
  if (channel === "chrome") {
    const item = page
      .locator("extensions-manager")
      .locator("extensions-item");
    await item.waitFor({ state: "attached", timeout: 10_000 });
    return item.evaluate((element) => {
      const data = element.data;
      return {
        disableReasons: data?.disableReasons ?? [],
        id: element.id,
        manifestErrors: data?.manifestErrors ?? [],
        name: data?.name,
        runtimeWarnings: data?.runtimeWarnings ?? [],
        state: data?.state,
        version: data?.version,
      };
    });
  }

  const item = page
    .locator("root-app")
    .locator("my-extension-page")
    .locator("extension-card");
  await item.waitFor({ state: "attached", timeout: 10_000 });
  return item.evaluate((element) => {
    const data = element.data;
    return {
      disableReasons: data?.enabled ? [] : ["disabled"],
      id: data?.id,
      manifestErrors: data?.errors ?? [],
      name: data?.extensionName,
      runtimeWarnings: [
        ...(data?.warnings ?? []),
        ...(data?.revampedWarnings ?? []),
      ],
      state: data?.enabled ? "ENABLED" : "DISABLED",
      version: data?.version,
    };
  });
}

function assertExtensionDetails(details, browserName, action) {
  if (
    details.name !== "yt2anki" ||
    details.version !== "0.1.0" ||
    details.state !== "ENABLED" ||
    details.disableReasons.length > 0 ||
    details.manifestErrors.length > 0 ||
    details.runtimeWarnings.length > 0
  ) {
    throw new Error(
      `${browserName} ${action}: ${JSON.stringify(details)}`,
    );
  }
}

function launchBrowser(profile, channel) {
  return chromium.launchPersistentContext(profile, {
    args: [
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
    ],
    channel,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
  });
}

for (const browser of browsers) {
  const root = await mkdtemp(
    join(tmpdir(), `yt2anki-${browser.channel}-`),
  );
  const profile = join(root, "profile");
  const testExtensionDir = join(root, "extension");
  await prepareTestExtension(testExtensionDir);
  let context = await launchBrowser(profile, browser.channel);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(browser.extensionsUrl);
    await page.waitForTimeout(400);
    await enableDeveloperMode(page, browser.channel);
    await page.waitForTimeout(400);
    await openFolderPicker(page, browser.channel);
    await page.waitForTimeout(500);

    const picker = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        pickerScript,
        "-Path",
        testExtensionDir,
        "-ProfilePath",
        profile,
      ],
      { encoding: "utf8" },
    );
    if (picker.status !== 0) {
      throw new Error(
        `${browser.name} folder selection failed: ${picker.stderr.trim()}`,
      );
    }

    const details = await readExtensionDetails(page, browser.channel);
    assertExtensionDetails(details, browser.name, "rejected the extension");

    const popup = await context.newPage();
    const errors = [];
    popup.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.goto(
      `chrome-extension://${details.id}/popup/popup.html`,
    );
    await popup
      .locator("#status")
      .waitFor({ state: "visible", timeout: 5_000 });
    if (
      (await popup.locator("#status").textContent()) !==
        "Open a YouTube video to continue." ||
      !(await popup.locator("#primary-action").isDisabled()) ||
      errors.length > 0
    ) {
      throw new Error(
        `${browser.name} popup check failed: ${JSON.stringify(errors)}`,
      );
    }

    const editor = await context.newPage();
    await editor.goto(
      `chrome-extension://${details.id}/editor/editor.html?video=invalid`,
    );
    if (
      (await editor.locator("#fatal-error").textContent()) !==
      "This editor URL does not identify a valid Source Video."
    ) {
      throw new Error(`${browser.name} editor did not initialize.`);
    }
    await popup.close();
    await editor.close();

    await page.goto(
      `https://www.youtube.com/watch?v=${browser.videoId}`,
      { timeout: 45_000, waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      () => {
        const player = document.getElementById("movie_player");
        return (
          typeof player?.getPlayerResponse === "function" &&
          typeof player?.setOption === "function"
        );
      },
      undefined,
      { timeout: 30_000 },
    );

    const invocation = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        actionScript,
        "-ProfilePath",
        profile,
      ],
      { encoding: "utf8" },
    );
    if (invocation.status !== 0) {
      throw new Error(
        `${browser.name} toolbar invocation failed: ${invocation.stderr.trim()}`,
      );
    }

    const worker =
      context
        .serviceWorkers()
        .find((candidate) => candidate.url().includes(details.id)) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (candidate) => candidate.url().includes(details.id),
        timeout: 5_000,
      }));
    const flowPopupPromise = context.waitForEvent("page", {
      predicate: (candidate) =>
        candidate.url().includes("/popup/popup.html"),
      timeout: 5_000,
    });
    await worker.evaluate(() =>
      chrome.tabs.create({
        active: false,
        url: chrome.runtime.getURL("popup/popup.html"),
      }),
    );
    const flowPopup = await flowPopupPromise;
    await flowPopup.waitForFunction(
      () =>
        document.querySelector("#status")?.textContent?.trim() !==
        "Checking this video…",
      undefined,
      { timeout: 15_000 },
    );
    const flowStatus = (await flowPopup.locator("#status").textContent())?.trim();
    const expectedStatus = browser.nativeTrack
      ? "Manual captions found."
      : "Manual Target captions found. Gemini will translate.";
    if (
      flowStatus !== expectedStatus ||
      !(await flowPopup.locator("#primary-action").isEnabled())
    ) {
      throw new Error(
        `${browser.name} toolbar popup check failed: ${flowStatus}`,
      );
    }

    const generatedEditorPromise = context.waitForEvent("page", {
      predicate: (candidate) =>
        candidate.url().includes(
          `/editor/editor.html?video=${browser.videoId}`,
        ),
      timeout: 30_000,
    });
    await flowPopup.locator("#primary-action").click();
    const generatedEditor = await generatedEditorPromise;
    await generatedEditor
      .locator("#selection-summary")
      .waitFor({ state: "visible", timeout: 15_000 });
    const draft = await worker.evaluate(async (videoId) => {
      const key = `draft:${videoId}`;
      return (await chrome.storage.local.get(key))[key];
    }, browser.videoId);
    if (
      !draft ||
      draft.segments.length === 0 ||
      Boolean(draft.nativeTrack) !== browser.nativeTrack ||
      (browser.nativeTrack &&
        !draft.segments.some((segment) => segment.translation.trim()))
    ) {
      throw new Error(`${browser.name} did not generate the expected Draft.`);
    }
    await verifyPreview(generatedEditor, browser.videoId, browser.name);

    await worker.evaluate((videoId) => {
      void chrome.storage.local.remove(`draft:${videoId}`);
    }, browser.videoId);
    await generatedEditor.close();
    await flowPopup.close();

    await context.close();
    context = await launchBrowser(profile, browser.channel);
    const reopenedPage =
      context.pages()[0] ?? (await context.newPage());
    await reopenedPage.goto(browser.extensionsUrl);
    const persistedDetails = await readExtensionDetails(
      reopenedPage,
      browser.channel,
    );
    assertExtensionDetails(
      persistedDetails,
      browser.name,
      "did not retain the extension after restart",
    );

    console.log(
      `${browser.name}: generated ${draft.segments.length} Segments, loaded the preview, and retained the extension after restart.`,
    );
  } finally {
    await context.close();
    const resolvedRoot = resolve(root);
    const resolvedTemp = resolve(tmpdir());
    if (!resolvedRoot.startsWith(`${resolvedTemp}\\`)) {
      throw new Error("Refusing to remove a non-temporary browser test root.");
    }
    await rm(resolvedRoot, { force: true, recursive: true });
  }
}
