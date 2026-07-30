import { readFile } from "node:fs/promises";
import {
  createDraft,
  expect,
  extensionStorage,
  setExtensionStorage,
  test,
} from "./fixtures.js";

const VIDEO_ID = "abcdefghijk";

test.use({ trace: "off" });

test("translates a Draft through live Gemini without exposing the key", async ({
  extension,
}) => {
  test.setTimeout(90_000);
  const apiKey = await readGeminiKey();
  test.skip(!apiKey, "GEMINI_API_KEY is absent from .env.");

  const { context, extensionId, worker } = extension;
  await setExtensionStorage(worker, {
    [`draft:${VIDEO_ID}`]: createDraft(),
    "secret:gemini": apiKey,
  });
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "" }),
  );

  const editor = await context.newPage();
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(editor.locator("#gemini-key")).toHaveAttribute(
    "placeholder",
    "Stored key",
  );
  await editor.locator("#translate").click();
  await expect(editor.locator("#translation-status")).toHaveText(
    "Translations complete.",
    { timeout: 75_000 },
  );
  await expect(
    editor.locator('textarea[data-field="translation"]'),
  ).not.toHaveValue("");

  const stored = await extensionStorage(worker);
  expect(stored[`draft:${VIDEO_ID}`].segments[0].translation).not.toBe("");
  await worker.evaluate(() => chrome.storage.local.clear());
});

async function readGeminiKey() {
  let content;
  try {
    content = await readFile(".env", "utf8");
  } catch {
    return "";
  }
  const line = content
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("GEMINI_API_KEY="));
  if (!line) {
    return "";
  }
  return line
    .slice("GEMINI_API_KEY=".length)
    .trim()
    .replace(/^(['"])(.*)\1$/u, "$2");
}
