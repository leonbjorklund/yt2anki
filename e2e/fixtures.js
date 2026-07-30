import { test as base, expect } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const test = base.extend({
  extension: async ({ playwright }, use) => {
    const root = await mkdtemp(join(tmpdir(), "yt2anki-e2e-"));
    const extensionDir = join(root, "extension");
    const profileDir = join(root, "profile");
    await cp(resolve("dist"), extensionDir, { recursive: true });

    // Playwright cannot synthesize the browser-toolbar gesture that grants
    // activeTab. The product build remains unchanged; this disposable copy
    // receives the narrow host grants needed to drive capture and approve
    // the preview permission without browser UI automation.
    const manifestPath = join(extensionDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions.push("https://www.youtube.com/*");
    delete manifest.optional_host_permissions;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const context = await playwright.chromium.launchPersistentContext(
      profileDir,
      {
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
        ],
        headless: false,
      },
    );

    try {
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(worker.url()).host;
      const messenger = await context.newPage();
      await messenger.goto(
        `chrome-extension://${extensionId}/editor/editor.html?video=invalid`,
      );
      await use({ context, extensionId, messenger, worker });
    } finally {
      await context.close();
      await rm(root, { force: true, recursive: true });
    }
  },
});

export { expect };
export { createDraft } from "../tests/fixtures.js";

export async function extensionMessage(messenger, message) {
  return messenger.evaluate(
    (value) => chrome.runtime.sendMessage(value),
    message,
  );
}

export async function extensionStorage(worker) {
  return worker.evaluate(() => chrome.storage.local.get(null));
}

export async function setExtensionStorage(worker, values) {
  await worker.evaluate(
    (items) => chrome.storage.local.set(items),
    values,
  );
}

const ANKI_RESULTS = {
  addNotes: [123],
  createDeck: 456,
  createModel: 789,
  findNotes: [],
  modelNames: [],
  requestPermission: {
    permission: "granted",
    requireApikey: false,
  },
  version: 6,
};

export async function mockAnkiConnect(context, respond) {
  const requests = [];
  await context.route("http://127.0.0.1:8765/**", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const defaultResponse = {
      error: null,
      result: ANKI_RESULTS[request.action],
    };
    const response = respond
      ? await respond(request, defaultResponse)
      : defaultResponse;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response),
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  return requests;
}
