import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test as base, expect } from "@playwright/test";
import { unzipSync } from "fflate";
import { DRAFT_SCHEMA_VERSION } from "../src/domain/types.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const test = base.extend({
  grantOptionalPermissions: [true, { option: true }],
  extensionBuild: [
    async ({ playwright: _playwright }, use) => {
      const root = await mkdtemp(join(tmpdir(), "yt2anki-e2e-build-"));
      const extensionDir = join(root, "extension");
      try {
        if (process.env.YT2ANKI_E2E_ZIP) {
          const entries = unzipSync(
            await readFile(resolve(process.env.YT2ANKI_E2E_ZIP)),
          );
          for (const [name, bytes] of Object.entries(entries)) {
            const destination = resolve(extensionDir, name);
            const within = relative(extensionDir, destination);
            if (
              !within ||
              isAbsolute(within) ||
              within.split(sep)[0] === ".."
            ) {
              throw new Error(
                "Release ZIP entry escapes the extension directory.",
              );
            }
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, bytes);
          }
          runChecked(process.execPath, [
            resolve("scripts/verify-build.mjs"),
            "--dir",
            extensionDir,
          ]);
        } else {
          runChecked(process.execPath, [
            resolve("scripts/build.mjs"),
            "--out-dir",
            extensionDir,
          ]);
        }
        await use(extensionDir);
      } finally {
        await removeTemporaryRoot(root, "yt2anki-e2e-build-");
      }
    },
    { scope: "worker" },
  ],
  extension: async (
    { extensionBuild, grantOptionalPermissions, playwright },
    use,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "yt2anki-e2e-"));
    const extensionDir = join(root, "extension");
    const profileDir = join(root, "profile");
    await cp(extensionBuild, extensionDir, { recursive: true });

    // Playwright cannot grant activeTab through chrome.action.openPopup(). The
    // product build remains unchanged; this disposable copy receives only the
    // host grants needed to drive capture. Tests can preserve the optional
    // package permissions to exercise their real popup transition.
    const manifestPath = join(extensionDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions.push("https://www.youtube.com/*");
    manifest.host_permissions.push("https://m.youtube.com/*");
    if (grantOptionalPermissions) {
      manifest.permissions.push(...manifest.optional_permissions);
      delete manifest.optional_permissions;
    }
    delete manifest.optional_host_permissions;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    assertBundledChromium(playwright.chromium.executablePath());
    let active;
    try {
      const launch = async () => {
        const context = await playwright.chromium.launchPersistentContext(
          profileDir,
          {
            args: [
              `--disable-extensions-except=${extensionDir}`,
              `--load-extension=${extensionDir}`,
            ],
            channel: "chromium",
            headless: true,
          },
        );
        try {
          // Browser tests may reach no local service on the owner's machine.
          await context.route(
            (url) => LOOPBACK_HOSTS.has(url.hostname),
            (route) => route.abort(),
          );
          await context.route(
            "https://m.youtube.com/watch?v=abcdefghijk",
            (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html>
                <title>yt2anki preflight fixture</title>
                <div id="movie_player"></div>
                <script>
                  const response = {
                    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
                    playabilityStatus: { playableInEmbed: true, status: "OK" },
                    streamingData: { adaptiveFormats: [
                      { mimeType: 'video/webm; codecs="vp9"' },
                      { mimeType: 'audio/webm; codecs="opus"' }
                    ] },
                    videoDetails: {
                      lengthSeconds: "10",
                      title: "Fixture video",
                      videoId: "abcdefghijk"
                    }
                  };
                  Object.assign(document.querySelector("#movie_player"), {
                    getPlayerResponse: () => response,
                    setOption: () => {}
                  });
                </script>`,
              }),
          );
          const preflightPage = await context.newPage();
          await preflightPage.goto("https://m.youtube.com/watch?v=abcdefghijk");
          const worker =
            context.serviceWorkers()[0] ??
            (await context.waitForEvent("serviceworker"));
          const extensionId = new URL(worker.url()).host;
          const messenger = await context.newPage();
          await messenger.goto(
            `chrome-extension://${extensionId}/editor/editor.html?video=invalid`,
          );
          return { context, extensionId, messenger, worker };
        } catch (error) {
          await context.close().catch(() => undefined);
          throw error;
        }
      };
      active = await launch();
      await use(active);
    } finally {
      await active?.context.close().catch(() => undefined);
      await removeTemporaryRoot(root, "yt2anki-e2e-");
    }
  },
});

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
}

function assertBundledChromium(executablePath) {
  const normalized = resolve(executablePath)
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    !normalized.includes("/ms-playwright/chromium-") ||
    !normalized.endsWith("/chrome-win64/chrome.exe")
  ) {
    throw new Error(
      "Refusing to launch anything except bundled Playwright Chromium.",
    );
  }
}

async function removeTemporaryRoot(directory, prefix) {
  const temporaryRoot = resolve(tmpdir());
  const fromTemporaryRoot = relative(temporaryRoot, resolve(directory));
  if (
    isAbsolute(fromTemporaryRoot) ||
    !fromTemporaryRoot.split(sep)[0].startsWith(prefix)
  ) {
    throw new Error("Refusing to remove a non-temporary browser test root.");
  }
  await rm(directory, { force: true, recursive: true });
}

export { createDraft } from "../tests/fixtures.js";
export { expect };

export async function extensionMessage(messenger, message) {
  return messenger.evaluate(
    (value) => chrome.runtime.sendMessage(value),
    message,
  );
}

export async function extensionStorage(worker, area = "local") {
  return worker.evaluate(
    (storageArea) => chrome.storage[storageArea].get(null),
    area,
  );
}

export async function setExtensionStorage(worker, values, area = "local") {
  const preflightTabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.title === "yt2anki preflight fixture")?.id;
  });
  const storedValues = structuredClone(values);
  for (const value of Object.values(storedValues)) {
    if (
      preflightTabId !== undefined &&
      value &&
      typeof value === "object" &&
      value.version === DRAFT_SCHEMA_VERSION &&
      value.video?.videoId === "abcdefghijk"
    ) {
      value.sourceTabId = preflightTabId;
    }
  }
  await worker.evaluate(
    ({ items, storageArea }) => chrome.storage[storageArea].set(items),
    { items: storedValues, storageArea: area },
  );
}

// Models the existing YouTube iframe handshake without fetching a live player.
export const previewPlayerFixture = `<script>
  let connected = false;
  addEventListener("message", event => {
    const message = JSON.parse(event.data);
    parent.postMessage({ type: "yt2anki-preview-command", payload: event.data }, "*");
    if (message.event === "listening" && !connected) {
      connected = true;
      parent.postMessage(JSON.stringify({ event: "initialDelivery" }), "*");
    }
    if (message.func === "addEventListener" && message.args[0] === "onReady") {
      parent.postMessage(JSON.stringify({ event: "onReady" }), "*");
    }
  });
</script>`;
