import {
  createDraft,
  expect,
  extensionStorage,
  previewPlayerFixture,
  setExtensionStorage,
  test,
} from "./fixtures.js";

const VIDEO_ID = "abcdefghijk";
const DRAFT_KEY = `draft:${VIDEO_ID}`;

for (const bilingual of [false, true]) {
  test(`merges ${bilingual ? "two tracks" : "one track"} and restores the last merge after reopening`, async ({
    extension,
  }) => {
    const draft = mergeDraft(3, bilingual);
    const page = await openEditor(extension, draft);
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await expect(page.locator(".revert-merge")).toHaveCount(0);
    await boundary(page, 0).click();
    await expect(page.locator(".segment-row")).toHaveCount(2);
    await expect(page.locator(".revert-merge")).toHaveCount(1);
    await expect(field(page, "target")).toHaveValue("你好。 再见。");
    await expect(field(page, "pinyin")).toHaveValue("nǐ hǎo。 zài jiàn。");
    if (bilingual) {
      await expect(field(page, "translation")).toHaveValue("Hello. Goodbye.");
    } else {
      await expect(
        page.locator('.segment-row textarea[data-field="translation"]'),
      ).toHaveCount(0);
    }
    await expect
      .poll(async () => (await storedDraft(extension)).segments.length)
      .toBe(2);
    const firstMerge = (await storedDraft(extension)).segments[0];
    expect(firstMerge.startMs).toBe(draft.segments[0].startMs);
    expect(firstMerge.endMs).toBe(draft.segments[1].endMs);
    await boundary(page, 0).click();
    await expect(page.locator(".segment-row")).toHaveCount(1);
    await expect(page.locator(".merge-boundary")).toHaveCount(0);
    await field(page, "target").fill("Later edit, discarded by revert");
    await expect
      .poll(async () => (await storedDraft(extension)).segments[0].target)
      .toBe("Later edit, discarded by revert");
    await page.reload();
    await expect(page.locator(".segment-row")).toHaveCount(1);
    await page.locator(".revert-merge").click();
    await expect(page.locator(".segment-row")).toHaveCount(2);
    await expect(field(page, "target")).toHaveValue(firstMerge.target);
    await expect(field(page, "target", 1)).toHaveValue(
      draft.segments[2].target,
    );
    await expect(page.locator(".revert-merge")).toHaveCount(1);
    await expect
      .poll(async () => (await storedDraft(extension)).segments.length)
      .toBe(2);
    expect((await storedDraft(extension)).segments).toEqual([
      firstMerge,
      draft.segments[2],
    ]);
    await page.locator(".revert-merge").click();
    await expect(page.locator(".segment-row")).toHaveCount(3);
    await expect(page.locator(".revert-merge")).toHaveCount(0);
    await expect
      .poll(async () => (await storedDraft(extension)).segments)
      .toEqual(draft.segments);
    expect(dialogs).toEqual([]);
  });
}

for (const theme of ["light", "dark"]) {
  test(`always-visible divider controls match row states in ${theme} theme`, async ({
    extension,
  }) => {
    const page = await openEditor(extension, mergeDraft(5));
    await page.emulateMedia({ colorScheme: theme });
    const rows = page.locator(".segment-row");
    await expect(page.locator("#merge-cards")).toHaveCount(0);
    await expect(page.locator(".merge-boundary")).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      const button = boundary(page, index);
      await expect(button).toBeVisible();
      await expect(button).toHaveAccessibleName(
        `Merge Segments ${index + 1} and ${index + 2}`,
      );
      await expect(button).toHaveCSS("opacity", "1");
      await expect(button).toHaveCSS("border-width", "0px");
      await expect(button).toHaveCSS("outline-style", "none");
      await expect(button.locator("svg path")).toHaveAttribute(
        "d",
        "M7 5l5 4 5-4M7 19l5-4 5 4",
      );
      await expect(button.locator("svg")).toHaveAttribute(
        "viewBox",
        "0 0 24 24",
      );
      for (const [property, value] of Object.entries({
        width: "16px",
        height: "16px",
        fill: "none",
        "stroke-width": "1.5px",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }))
        await expect(button.locator("svg")).toHaveCSS(property, value);
    }
    // Active above, below, and outside the pair. Hover must never change selection.
    for (const active of [1, 2, 4]) {
      await rows.nth(active).locator(".row-preview-button").focus();
      await page.mouse.move(0, 0);
      const idle = await rowColors(page);
      await expectBoundaryBackgrounds(page);
      await field(page, "target", 2).hover();
      const ordinaryHover = await rowColors(page);
      if (active !== 2) expect(ordinaryHover[2]).not.toBe(idle[2]);
      else expect(ordinaryHover[2]).toBe(idle[2]);
      await expectBoundaryBackgrounds(page);
      for (let index = 0; index < 4; index += 1) {
        await expect(boundary(page, index)).toHaveCSS("outline-style", "none");
      }
      await boundary(page, 1).hover();
      const pairHover = await rowColors(page);
      expect(pairHover[1]).toBe(pairHover[2]);
      if (theme === "dark") expect(pairHover[1]).toBe("rgb(30, 34, 41)");
      else expect(pairHover[1]).not.toBe(idle[0]);
      for (const index of [0, 3, 4]) expect(pairHover[index]).toBe(idle[index]);
      const button = boundary(page, 1);
      await expect(button).toHaveCSS("background-image", "none");
      await expect(button).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(37, 42, 50)" : "rgb(238, 241, 245)",
      );
      await expect(button).toHaveCSS(
        "outline",
        `${theme === "dark" ? "rgb(69, 78, 89)" : "rgb(142, 147, 155)"} solid 1px`,
      );
      await expect(button).toHaveCSS(
        "color",
        theme === "dark" ? "rgb(223, 227, 232)" : "rgb(23, 25, 28)",
      );
      await expectBoundaryBackgrounds(page, 1);
      await page.mouse.move(0, 0);
      expect(await rowColors(page)).toEqual(idle);
      await expectBoundaryBackgrounds(page);
      await expect(rows.nth(active)).toHaveClass(/active/u);
    }
    await field(page, "translation", 1).focus();
    await page.keyboard.press("Tab");
    await expect(boundary(page, 1)).toBeFocused();
    await expect(boundary(page, 1)).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    const revert = page.getByRole("button", {
      name: "Revert last merge for Segment 2",
      exact: true,
    });
    await expect(revert).toBeFocused();
    await expect(revert).toHaveCSS("outline-width", "2px");
    await expect(revert).toHaveCSS(
      "outline-color",
      theme === "dark" ? "rgb(167, 175, 184)" : "rgb(98, 104, 113)",
    );
    await page.keyboard.press("Space");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(1).locator(".row-preview-button")).toBeFocused();
  });

  for (const bilingual of [false, true]) {
    test(`divider and revert geometry preserves multiline editing with ${bilingual ? "two tracks" : "one track"} in ${theme} theme`, async ({
      extension,
    }) => {
      const draft = mergeDraft(40, bilingual);
      for (const segment of draft.segments) {
        segment.target =
          "第一行 First full line of caption text with enough words to wrap across the cell.\nSecond full line of caption text.\nThird line stays editable by scrolling.";
        segment.pinyin = "";
        if (bilingual)
          segment.translation =
            "First translation line with enough words to wrap across the cell.\nSecond translation line.\nThird line stays editable by scrolling.";
      }
      const page = await openEditor(extension, draft);
      await page.emulateMedia({ colorScheme: theme });
      for (const pinyin of [false, true]) {
        if (pinyin) await page.locator("#generate-pinyin").click();
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await boundary(page, 0).scrollIntoViewIfNeeded();
          const before = await tableGeometry(page);
          await page.evaluate(() => {
            for (const button of document.querySelectorAll(".merge-boundary"))
              button.hidden = true;
            for (const cell of document.querySelectorAll(
              ".segment-row > td:last-child",
            ))
              cell.style.paddingRight = "6px";
          });
          expect(await tableGeometry(page)).toEqual(before);
          await page.evaluate(() => {
            for (const button of document.querySelectorAll(".merge-boundary"))
              button.hidden = false;
            for (const cell of document.querySelectorAll(
              ".segment-row > td:last-child",
            ))
              cell.style.removeProperty("padding-right");
          });
          await boundary(page, 0).hover();
          expect(await tableGeometry(page)).toEqual(before);
          await expectControlGeometry(page, ".merge-boundary", true);
          await boundary(page, 0).click();
          await expect(page.locator(".segment-row")).toHaveCount(39);
          expect(await tableGeometry(page)).toEqual(before);
          await expectControlGeometry(page, ".revert-merge", false);
          await expectControlGeometry(page, ".merge-boundary", true);
          await page.locator(".revert-merge").click();
          await expect(page.locator(".segment-row")).toHaveCount(40);
          expect(await tableGeometry(page)).toEqual(before);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const headerTop = (await page.locator("thead th").first().boundingBox())
        .y;
      await page.locator(".table-shell").evaluate((element) => {
        element.scrollTop = 350;
      });
      expect(
        (await page.locator("thead th").first().boundingBox()).y,
      ).toBeCloseTo(headerTop, 0);
    });
  }
}
test("a replaced draft disables merge and revert without changing the replacement", async ({
  extension,
}) => {
  const page = await openEditor(extension, mergeDraft(3));
  await boundary(page, 0).click();
  await expect
    .poll(async () => (await storedDraft(extension)).segments.length)
    .toBe(2);
  const replacement = mergeDraft(3);
  replacement.generationId = "replacement-generation";
  await setExtensionStorage(extension.worker, { [DRAFT_KEY]: replacement });
  await expect(page.locator("#segment-list")).toHaveAttribute("inert", "");
  await expect(page.locator(".revert-merge")).toBeDisabled();
  await expect(boundary(page, 0)).toBeDisabled();
  expect((await storedDraft(extension)).segments).toEqual(replacement.segments);
});

test("merging overlapping non-Chinese rows does not start playback and Replay keeps the outer bounds", async ({
  extension,
}) => {
  const draft = mergeDraft(3, false);
  draft.targetTrack = {
    id: ".sv",
    languageCode: "sv",
    name: "Swedish",
    kind: null,
  };
  draft.segments.forEach((segment, index) => {
    segment.target = ["Hej.", "Hej då.", "Tack."][index];
    segment.pinyin = "";
  });
  draft.segments[0].endMs = 3901;
  const page = await openEditor(extension, draft);
  await page.frameLocator("#preview").locator("body").waitFor();
  await field(page, "target").focus();
  await page.keyboard.press("Tab");
  await expect(boundary(page, 0)).toBeFocused();
  await expect(boundary(page, 0)).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(field(page, "target")).toHaveValue("Hej. Hej då.");
  await expect(page.locator(".revert-merge")).toBeFocused();
  await expect(
    page.locator('.segment-row textarea[data-field="pinyin"]'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__mergePlaybackCommands)).toEqual([]);
  await page.locator("#replay").click();
  await expect
    .poll(() => page.evaluate(() => window.__mergePlaybackCommands))
    .toEqual([
      {
        args: [{ endSeconds: 3.901, startSeconds: 0.101, videoId: VIDEO_ID }],
        event: "command",
        func: "loadVideoById",
      },
    ]);
  const revert = page.locator(".revert-merge");
  await field(page, "target").focus();
  await page.keyboard.press("Tab");
  await expect(revert).toBeFocused();
  await expect(revert).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Space");
  await expect(page.locator(".segment-row")).toHaveCount(3);
  await expect(page.locator(".row-preview-button").first()).toBeFocused();
  expect(await page.evaluate(() => window.__mergePlaybackCommands.length)).toBe(
    1,
  );
});

test("regeneration during an unfinished merge keeps the replacement and editor locked", async ({
  extension,
}) => {
  const page = await openEditor(extension, mergeDraft(3));
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      await new Promise((resolve) => {
        window.__releaseMerge = resolve;
      });
      const result = await digest(...args);
      window.__mergeDigestFinished = true;
      return result;
    };
  });
  await boundary(page, 0).click();
  await expect(page.locator("#download-apkg")).toBeDisabled();
  await expect(boundary(page, 0)).toBeDisabled();
  const replacement = mergeDraft(3);
  replacement.generationId = "replacement-during-merge";
  await setExtensionStorage(extension.worker, { [DRAFT_KEY]: replacement });
  await expect(page.locator("#segment-list")).toHaveAttribute("inert", "");
  await page.evaluate(() => window.__releaseMerge());
  await expect
    .poll(() => page.evaluate(() => window.__mergeDigestFinished))
    .toBe(true);
  await expect(page.locator("#download-apkg")).toBeDisabled();
  await expect(boundary(page, 0)).toBeDisabled();
  await expect(page.locator(".segment-row")).toHaveCount(3);
  expect((await storedDraft(extension)).segments).toEqual(replacement.segments);
});

function mergeDraft(count, bilingual = true) {
  const draft = createDraft({ translation: bilingual ? "Hello." : "" });
  const targets = ["你好。", "再见。", "谢谢。"];
  const translations = ["Hello.", "Goodbye.", "Thank you."];
  const pinyin = ["nǐ hǎo。", "zài jiàn。", "xiè xie。"];
  draft.segments = Array.from({ length: count }, (_, index) => ({
    ...draft.segments[0],
    identity: `v4_${index.toString(36).padStart(43, "0")}`,
    startMs: index * 2000 + 101,
    endMs: index * 2000 + 1801,
    target: targets[index % 3],
    translation: bilingual ? translations[index % 3] : "",
    pinyin: pinyin[index % 3],
  }));
  draft.video.durationMs = Math.max(10000, draft.segments.at(-1).endMs);
  return draft;
}

async function openEditor({ context, extensionId, worker }, draft) {
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: previewPlayerFixture }),
  );
  await setExtensionStorage(worker, { [DRAFT_KEY]: draft });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    window.__mergePlaybackCommands = [];
    addEventListener("message", (event) => {
      if (event.data?.type === "yt2anki-preview-command") {
        const { id, channel, ...command } = JSON.parse(event.data.payload);
        if (command.func === "loadVideoById")
          window.__mergePlaybackCommands.push(command);
      }
    });
  });
  await page.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${VIDEO_ID}`,
  );
  await expect(page.locator("#editor")).toBeVisible();
  return page;
}

function boundary(page, index) {
  return page.locator(`.segment-row[data-index="${index}"] .merge-boundary`);
}

function field(page, name, index = 0) {
  return page.locator(`.segment-row textarea[data-field="${name}"]`).nth(index);
}

async function storedDraft({ worker }) {
  return (await extensionStorage(worker))[DRAFT_KEY];
}

async function tableGeometry(page) {
  return page.evaluate(() => ({
    columns: [...document.querySelectorAll("thead th")].map(
      (cell) => cell.getBoundingClientRect().width,
    ),
    rowHeight: document.querySelector(".segment-row").getBoundingClientRect()
      .height,
  }));
}

async function rowColors(page) {
  return page
    .locator(".segment-row")
    .evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
}

async function expectBoundaryBackgrounds(page, hovered = -1) {
  const colors = await rowColors(page);
  for (let index = 0; index < colors.length - 1; index += 1) {
    if (index === hovered) continue;
    await expect(boundary(page, index)).toHaveCSS(
      "background-image",
      `linear-gradient(${colors[index]} 50%, ${colors[index + 1]} 50%)`,
    );
    await expect(boundary(page, index)).toHaveCSS("outline-style", "none");
  }
}

async function expectControlGeometry(page, selector, divider) {
  const button = page.locator(selector).first();
  await button.scrollIntoViewIfNeeded();
  const geometry = await button.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = element.closest("tr");
    const first = row.getBoundingClientRect();
    const next = row.nextElementSibling?.getBoundingClientRect();
    const icon = element.querySelector("svg").getBoundingClientRect();
    const fields = [row, row.nextElementSibling]
      .filter(Boolean)
      .map((entry) => {
        const textarea = entry.querySelector("td:last-child textarea");
        const rect = textarea.getBoundingClientRect();
        return {
          right: rect.right,
          receivesPointer:
            document.elementFromPoint(rect.right - 8, rect.top + 8) ===
            textarea,
          scrollable: textarea.scrollHeight > textarea.clientHeight,
        };
      });
    return {
      size: [bounds.width, bounds.height],
      iconSize: [icon.width, icon.height],
      radius: getComputedStyle(element).borderRadius,
      rightInset: first.right - bounds.right,
      left: bounds.left,
      centerY: bounds.y + bounds.height / 2,
      rowCenterY: first.y + first.height / 2,
      rowBottom: first.bottom,
      nextTop: next?.top,
      receivesPointer: element.contains(
        document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        ),
      ),
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      fields,
    };
  });
  expect(geometry.size).toEqual([18, 20]);
  expect(geometry.iconSize).toEqual([16, 16]);
  expect(geometry.radius).toBe("4px");
  expect(geometry.rightInset).toBe(6);
  expect(geometry.centerY).toBeCloseTo(
    divider ? geometry.rowBottom : geometry.rowCenterY,
    1,
  );
  if (divider) expect(geometry.nextTop).toBe(geometry.rowBottom);
  expect(geometry.receivesPointer).toBe(true);
  expect(geometry.pageOverflows).toBe(false);
  for (const field of geometry.fields) {
    expect(field.right).toBeLessThanOrEqual(geometry.left);
    expect(field.receivesPointer).toBe(true);
    // Long text stays scrollable inside the existing row height.
    expect(field.scrollable).toBe(true);
  }
}
