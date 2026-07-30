import { expect, extensionMessage, test } from "./fixtures.js";

test.describe("live YouTube capture", () => {
  test("captures both supplied Source Videos", async ({ extension }) => {
    test.setTimeout(120_000);
    const { context, extensionId, messenger, worker } = extension;
    const fixtures = [
      {
        nativeLocale: "en-GB",
        targetLocale: "zh-Hans",
        videoId: "boMXFNybOXY",
      },
      {
        nativeLocale: "en-GB",
        targetLocale: "zh-Hans",
        videoId: "APv9hfjYRY0",
      },
    ];

    for (const fixture of fixtures) {
      const source = await context.newPage();
      await source.goto(
        `https://www.youtube.com/watch?v=${fixture.videoId}`,
        { timeout: 45_000, waitUntil: "domcontentloaded" },
      );
      await source.waitForFunction(
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

      const [tab] = await worker.evaluate(
        (videoId) =>
          chrome.tabs.query({
            url: `https://www.youtube.com/watch?v=${videoId}*`,
          }),
        fixture.videoId,
      );
      expect(tab?.id).toBeTruthy();

      const inspection = await extensionMessage(messenger, {
        tabId: tab.id,
        type: "inspect",
      });
      expect(inspection.ok, JSON.stringify(inspection)).toBe(true);
      expect(inspection.data.video.videoId).toBe(fixture.videoId);
      expect(
        inspection.data.video.tracks.some(
          (track) => track.kind?.toLowerCase() === "asr",
        ),
      ).toBe(false);

      const popupPromise = context.waitForEvent("page", (page) =>
        page.url().includes("/popup/popup.html"),
      );
      await worker.evaluate(
        (url) => chrome.tabs.create({ active: false, url }),
        `chrome-extension://${extensionId}/popup/popup.html`,
      );
      const popup = await popupPromise;
      await expect(popup.locator("#status")).toHaveText(
        fixture.videoId === "APv9hfjYRY0"
          ? "Manual captions found."
          : "Manual Target captions found. Gemini will translate.",
        { timeout: 15_000 },
      );
      const manualNames = [
        ...new Set(
          inspection.data.video.tracks
            .filter((track) => track.kind?.toLowerCase() !== "asr")
            .map((track) => track.name),
        ),
      ];
      await expect(popup.locator("#target-locale option")).toHaveText(
        manualNames,
      );
      if (fixture.videoId === "boMXFNybOXY") {
        await expect(
          popup.locator("#target-locale option:checked"),
        ).toHaveText("Chinese");
        await expect(popup.locator("#native-locale option")).toHaveText([
          "No native captions",
        ]);
        await expect(popup.locator("#native-locale")).toBeDisabled();
      }

      const editorPromise = context.waitForEvent("page", {
        predicate: (page) => page.url().includes("editor/editor.html"),
        timeout: 30_000,
      });
      await popup.locator("#primary-action").click();
      const editor = await Promise.race([
        editorPromise,
        popup
          .waitForFunction(() => {
            const action = document.querySelector("#primary-action");
            return action?.textContent?.trim() === "Try again";
          })
          .then(async () => {
            throw new Error(
              (await popup.locator("#status").textContent()) ??
                "Live caption capture failed.",
            );
          })
          .catch((error) => {
            if (popup.isClosed()) {
              return editorPromise;
            }
            throw error;
          }),
      ]);
      await expect(editor.locator("#selection-summary")).toBeVisible({
        timeout: 15_000,
      });
      const draft = await worker.evaluate(async (videoId) => {
        const key = `draft:${videoId}`;
        return (await chrome.storage.local.get(key))[key];
      }, fixture.videoId);

      expect(draft.segments.length).toBeGreaterThan(0);
      if (fixture.videoId === "APv9hfjYRY0") {
        expect(draft.nativeTrack?.languageCode).toBe("en-GB");
        expect(
          draft.segments.some((segment) =>
            Boolean(segment.translation.trim()),
          ),
        ).toBe(true);
      } else {
        expect(draft.nativeTrack).toBeNull();
      }

      await expectPlayablePreview(editor, fixture.videoId);
      await editor.close();
      await worker.evaluate(
        (videoId) => chrome.storage.local.remove(`draft:${videoId}`),
        fixture.videoId,
      );
      await source.close();
    }
  });
});

async function expectPlayablePreview(editor, videoId) {
  await expect.poll(
    async () => {
      const frame = editor
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
      message: `YouTube preview did not load for ${videoId}`,
      timeout: 30_000,
    },
  ).toBe("ready");
}
