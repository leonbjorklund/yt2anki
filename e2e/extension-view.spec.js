import {
  createDraft,
  expect,
  previewPlayerFixture,
  setExtensionStorage,
  test,
} from "./fixtures.js";

const VIDEO_ID = "abcdefghijk";
const VIDEO_TITLE =
  "Chinese Peppa Pig - 🚙 George's Racing Car 乔治的赛车 - 8 CC SUBS";

// Focus must stay distinct from subtle borders and the primary action in both
// themes, and readable against whatever the ring is drawn on.
test("editor keyboard focus uses contrasting neutral outlines in both themes", async ({
  extension,
}) => {
  const editor = await openEditor(extension, createSegmentedDraft(3));
  for (const [theme, outlineColor] of [
    ["light", "rgb(98, 104, 113)"],
    ["dark", "rgb(167, 175, 184)"],
  ]) {
    await editor.emulateMedia({ colorScheme: theme });
    for (const selector of [
      ".segment-textarea",
      "#select-all",
      "#replay",
      ".field-order-actions button",
      "#generate-pinyin",
      "#download-apkg",
    ]) {
      const field = editor.locator(selector).first();
      await field.focus();
      await expect(field).toHaveCSS("outline-style", "solid");
      await expect(field).toHaveCSS(
        "outline-width",
        selector === ".segment-textarea" ? "1px" : "2px",
      );
      await expect(field).toHaveCSS("outline-color", outlineColor);
      const contrast = await field.evaluate(focusRingContrast);
      expect(contrast, `${theme} ${selector}`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("table header controls stay aligned, keyboard reachable, and usable at narrow widths", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(93));
  await page.emulateMedia({ colorScheme: "dark" });
  const parent = page.locator("#select-all");
  await parent.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".segment-checkbox:checked")).toHaveCount(0);
  await expect(page.locator("#selection-summary")).toHaveText("0/93");
  await page.keyboard.press("Space");
  await expect(page.locator(".segment-checkbox:checked")).toHaveCount(93);
  await page.keyboard.press("Tab");
  await expect(page.locator("#generate-pinyin")).toBeFocused();
  await expect(page.locator("#generate-pinyin")).toHaveCSS(
    "outline-style",
    "solid",
  );

  const headerTop = (await parent.boundingBox()).y;
  await page.locator(".table-shell").evaluate((element) => {
    element.scrollTop = 400;
  });
  expect((await parent.boundingBox()).y).toBeCloseTo(headerTop, 0);
  await expect(
    page.locator("#target-heading #generate-pinyin"),
  ).toBeInViewport();
  await page.locator(".table-shell").evaluate((element) => {
    element.scrollTop = 0;
  });

  for (const generated of [false, true]) {
    if (generated) await page.locator("#generate-pinyin").click();
    let wideColumns;
    for (const width of [1600, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const columns = await page.evaluate(() =>
        ["number-column", "time-column"].map(
          (name) =>
            document.querySelector(`th.${name}`).getBoundingClientRect().width,
        ),
      );
      if (width === 1600) wideColumns = columns;
      if (width === 1280) {
        for (const [index, column] of columns.entries()) {
          expect(column).toBeLessThan(wideColumns[index]);
        }
      }
      const layout = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect();
        const title = rect("#video-title");
        const download = rect("#download-apkg");
        const checkbox = rect("#select-all");
        const child = rect(".segment-checkbox");
        const number = rect("#selection-summary");
        const numberCell = rect("tbody .number-column");
        const rowNumber = rect(".row-preview-button");
        const heading = rect("#target-heading");
        const label = rect("#target-heading-label");
        const pinyin = rect("#generate-pinyin");
        return {
          pageOverflows: document.documentElement.scrollWidth > innerWidth,
          titleBeforeDownload: title.right <= download.left,
          titleSharesDownloadRow:
            title.top < download.bottom && title.bottom > download.top,
          checkboxAligned: Math.abs(checkbox.x - child.x) < 1,
          countAligned: Math.abs(number.left - (rowNumber.left - 4)) < 1,
          headerHeight: rect("thead").height,
          checkboxSize: [
            checkbox.width,
            checkbox.height,
            child.width,
            child.height,
          ],
          pinyinHeight: pinyin.height,
          countInNumberColumn:
            number.left >= numberCell.left && number.right <= numberCell.right,
          pinyinInsideHeading:
            pinyin.width === 0 ||
            (pinyin.left >= heading.left && pinyin.right <= heading.right),
          headingContentsDoNotOverlap:
            pinyin.width === 0 ||
            label.right <= pinyin.left ||
            label.bottom <= pinyin.top,
        };
      });
      expect(layout, `${width}px pinyin=${generated}`).toEqual({
        pageOverflows: false,
        titleBeforeDownload: true,
        titleSharesDownloadRow: true,
        checkboxAligned: true,
        countAligned: true,
        headerHeight: 38,
        checkboxSize: [16, 16, 16, 16],
        pinyinHeight: generated ? 0 : 24,
        countInNumberColumn: true,
        pinyinInsideHeading: true,
        headingContentsDoNotOverlap: true,
      });
    }
  }
});

test("large Segment counts remain inside the number column", async ({
  extension,
}) => {
  // This checks column geometry, not how fast CI renders 10,000 rows.
  test.setTimeout(60_000);
  const draft = createDraft({ videoId: VIDEO_ID });
  draft.segments = Array.from({ length: 10000 }, (_, index) => ({
    ...draft.segments[0],
    identity: `v4_${index.toString(36).padStart(43, "0")}`,
  }));
  const editor = await openEditor(extension, draft, {
    readyTimeout: 15_000,
  });
  await expect(editor.locator("#selection-summary")).toHaveText("10000/10000");
  const geometry = await editor.evaluate(() => {
    const count = document
      .querySelector("#selection-summary")
      .getBoundingClientRect();
    const cell = document
      .querySelector("th.number-column")
      .getBoundingClientRect();
    return { countRight: count.right, cellRight: cell.right };
  });
  expect(geometry.countRight).toBeLessThanOrEqual(geometry.cellRight);
});

test("text-field clicks play rows while keyboard focus and checkboxes do not", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(3), {
    beforeLoad: (target) =>
      target.addInitScript(() => {
        window.__playbackCommands = [];
        addEventListener("message", (event) => {
          if (event.data?.type === "yt2anki-preview-command") {
            const { id, channel, ...command } = JSON.parse(event.data.payload);
            if (command.func === "loadVideoById")
              window.__playbackCommands.push(command);
          }
        });
      }),
  });
  await page.frameLocator("#preview").locator("body").waitFor();
  await expect(page.locator("#preview-time")).toHaveText(
    await page.locator(".segment-time > span").first().textContent(),
  );
  await expect(page.locator("#preview-target-label")).toHaveText("Chinese");
  await expect(page.locator("#preview-translation-label")).toHaveText(
    "English",
  );
  await page.locator("#generate-pinyin").click();
  await expect(page.locator("#preview-pinyin")).toBeFocused();
  await expect(page.locator("#preview-pinyin")).not.toBeEmpty();
  await expect(
    page.locator('.segment-row textarea[data-field="pinyin"]'),
  ).toHaveCount(3);
  let playbackCount = 0;
  for (const field of ["target", "translation", "pinyin"]) {
    for (const index of [1, 0]) {
      const row = page.locator(".segment-row").nth(index);
      const input = row.locator(`textarea[data-field="${field}"]`);
      await input.focus();
      await expect(row).toHaveClass(/active/u);
      await expect(page.locator(`#preview-${field}`)).toHaveValue(
        await row.locator(`textarea[data-field="${field}"]`).inputValue(),
      );
      await expect(page.locator("#preview-time")).toHaveText(
        await row.locator(".segment-time > span").textContent(),
      );
      expect(await page.evaluate(() => window.__playbackCommands.length)).toBe(
        playbackCount,
      );
      await input.click();
      await expect(input).toBeFocused();
      playbackCount += 1;
      await expect
        .poll(() => page.evaluate(() => window.__playbackCommands.length))
        .toBe(playbackCount);
      await page.locator(`#preview-${field}`).click();
      expect(await page.evaluate(() => window.__playbackCommands.length)).toBe(
        playbackCount,
      );
    }
  }
  await expect(page.locator("#preview-controls")).toBeVisible();

  const checkbox = page.locator('.segment-row input[type="checkbox"]').nth(2);
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(() => window.__playbackCommands.length)).toBe(6);

  await page.locator(".segment-time").nth(2).click();
  await expect
    .poll(() => page.evaluate(() => window.__playbackCommands.length))
    .toBe(7);
  await page
    .locator('.segment-row textarea[data-field="target"]')
    .first()
    .click();
  await expect(page.locator(".segment-row").first()).toHaveClass(/active/u);
  await expect(page.locator("#preview")).toHaveAttribute(
    "title",
    "Segment 1 preview",
  );
  await expect
    .poll(() => page.evaluate(() => window.__playbackCommands.length))
    .toBe(8);

  await page.getByRole("button", { name: "Replay", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.__playbackCommands.at(-1)))
    .toEqual({
      args: [{ endSeconds: 3, startSeconds: 1, videoId: VIDEO_ID }],
      event: "command",
      func: "loadVideoById",
    });
  // One more command, not two: a double fire would restart playback twice and
  // still leave the right command last.
  expect(await page.evaluate(() => window.__playbackCommands.length)).toBe(9);
});

test("editor dark theme separates hover, disabled, and focus states", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(3));
  await page.emulateMedia({ colorScheme: "dark" });
  for (const selector of ["#replay", "#download-apkg"]) {
    await page.mouse.move(0, 0);
    const button = page.locator(selector);
    const idle = await button.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await button.hover();
    expect(
      await button.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
      `${selector} hover`,
    ).not.toBe(idle);
    await button.evaluate((element) => {
      element.disabled = true;
    });
    expect(
      await button.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
      `${selector} disabled`,
    ).toBe(idle);
    await button.evaluate((element) => {
      element.disabled = false;
    });
  }
  await page.locator(".segment-checkbox").nth(1).uncheck();
  await expect(page.locator("#select-all")).toHaveJSProperty(
    "indeterminate",
    true,
  );
  const mark = await page
    .locator("#select-all")
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(mark).toContain("rgb(255, 255, 255)");
  await expect(page.locator("#selection-summary")).toHaveText("2/3");
  await expect(page.locator("#select-all")).toHaveAttribute(
    "aria-label",
    "Select all Segments, 2 of 3 selected",
  );
});

test("table fields share row hover and borderless preview fields remain keyboard editable", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(3));
  await page.locator("#generate-pinyin").click();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const name of ["target", "translation", "pinyin"]) {
      const field = page
        .locator(`.segment-row textarea[data-field="${name}"]`)
        .nth(1);
      await page.locator("#replay").focus();
      await field.hover();
      await expect(field).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await field.focus();
      await expect(field).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(31, 37, 44)" : "rgb(251, 252, 253)",
      );
      await expect(field).toHaveCSS("outline-style", "solid");
      const preview = page.locator(`#preview-${name}`);
      await expect(preview).toHaveCSS("border-width", "0px");
      await expect(preview).toHaveCSS("outline-style", "none");
      const before = await preview.boundingBox();
      // Shift+Tab returns through the real tab order to the preview field.
      await preview.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(preview).toBeFocused();
      await expect(preview).toHaveCSS("border-width", "0px");
      await expect(preview).toHaveCSS("outline-style", "none");
      await expect(preview).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(31, 37, 44)" : "rgb(251, 252, 253)",
      );
      await expect(preview).toHaveCSS("min-height", "42px");
      await expect(preview).toHaveCSS("max-height", "122px");
      await expect(preview).toHaveCSS("padding", "8px");
      expect(await preview.boundingBox()).toEqual(before);
      await preview.fill(`Edited ${name} in ${theme}`);
      await expect(field).toHaveValue(`Edited ${name} in ${theme}`);
      await field.focus();
    }
  }
});

test("editor keeps its title, package button, and field limits at every width", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(93));
  await expect(page.locator("#video-title")).toHaveText(VIDEO_TITLE);
  await expect(page.locator("#video-title")).toHaveCSS("font-size", "16px");
  await expect(page.locator("#video-title")).toHaveCSS("font-weight", "400");
  await expect(page.locator("#save-state")).toBeEmpty();
  await expect(page.locator("#save-state")).toHaveClass(/visually-hidden/u);
  await expect(page.locator("#selection-summary")).toHaveText("93/93");
  await expect(page.locator("#download-apkg")).toContainText("Download .apkg");
  await expect(
    page.getByRole("button", { name: "Open in Anki", exact: true }),
  ).toBeHidden();
  const download = page.locator("#download-apkg");
  await expect(download).toHaveCSS("border-radius", "6px");
  await expect(download).toHaveCSS("font-weight", "600");
  await expect(download).toHaveCSS("height", "32px");

  // A long Segment scrolls inside its row instead of growing the table.
  const tableTarget = page
    .locator('.segment-row textarea[data-field="target"]')
    .first();
  await tableTarget.fill("第一行\n第二行\n第三行\n第四行");
  const overflow = await tableTarget.evaluate((element) => ({
    clientHeight: element.clientHeight,
    maxHeight: getComputedStyle(element).maxHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(overflow.maxHeight).toBe("44px");
  expect(overflow.overflowY).toBe("auto");
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  await expect(page.locator("#preview-target")).toHaveValue(
    "第一行\n第二行\n第三行\n第四行",
  );
  await page.locator("#preview-translation").fill("Preview-side edit");
  await expect(
    page.locator('.segment-row textarea[data-field="translation"]').first(),
  ).toHaveValue("Preview-side edit");

  // An empty Target marks the row and the preview field without inventing a
  // row status or a description to point at.
  await tableTarget.fill("");
  await expect(page.locator(".segment-row").first()).toHaveClass(/invalid/u);
  await expect(page.locator(".row-status")).toHaveCount(0);
  await expect(page.locator("#preview-target")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#preview-target")).toHaveAttribute("required", "");
  await expect(page.locator("#preview-target")).not.toHaveAttribute(
    "aria-describedby",
  );
  await tableTarget.fill("你好。");
  await expect(page.locator(".segment-row").first()).not.toHaveClass(
    /invalid/u,
  );

  await page.setViewportSize({ width: 900, height: 1200 });
  const stacked = await page.evaluate(() => {
    const preview = document
      .querySelector(".preview-panel")
      .getBoundingClientRect();
    const table = document
      .querySelector(".table-shell")
      .getBoundingClientRect();
    return {
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      columns: getComputedStyle(
        document.querySelector("#editor"),
      ).gridTemplateColumns.split(" ").length,
      previewTop: Math.round(preview.top),
      tableTop: Math.round(table.top),
    };
  });
  expect(stacked.bodyOverflowY).toBe("auto");
  expect(stacked.columns).toBe(1);
  expect(stacked.previewTop).toBeLessThan(stacked.tableTop);
});

test("card ordering persists, keeps Pinyin with Chinese, and aligns preview controls", async ({
  extension,
}) => {
  const page = await openEditor(extension, createSegmentedDraft(3));
  await page.emulateMedia({ colorScheme: "dark" });
  const chinese = page.locator('.preview-language[data-language="target"]');
  const english = page.locator(
    '.preview-language[data-language="translation"]',
  );
  for (const group of [chinese, english]) {
    await expect(group.locator(".field-order-actions button")).toHaveCount(1);
    await expect(group.locator(".field-order-actions button")).toBeEnabled();
    await expect(group.locator(".field-order-actions button")).toHaveCSS(
      "width",
      "26px",
    );
    await expect(group.locator(".field-order-actions button")).toHaveCSS(
      "height",
      "34px",
    );
    await expect(group.locator(".field-order-actions svg")).toHaveCSS(
      "width",
      "18px",
    );
    await expect(group.locator(".field-order-actions svg")).toHaveCSS(
      "height",
      "18px",
    );
    await expect(group.locator(".preview-language-row")).toHaveCSS(
      "column-gap",
      "4px",
    );
  }
  await expect(page.locator("#replay")).toHaveCSS("width", "24px");
  await expect(page.locator("#replay")).toHaveCSS("height", "24px");

  await page.locator("#generate-pinyin").click();
  expect(
    await page
      .locator("textarea")
      .evaluateAll((fields) => fields.every((field) => !field.spellcheck)),
  ).toBe(true);
  const original = await page.locator("#preview-target").inputValue();
  await page
    .getByRole("button", { name: "Move Chinese down", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Move Chinese up", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".preview-language").first()).toHaveAttribute(
    "data-language",
    "translation",
  );
  await expect(chinese.locator("#preview-pinyin")).toBeVisible();
  await expect(page.locator("#preview-target")).toHaveValue(original);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.evaluate(() => {
      const rect = (s) => document.querySelector(s).getBoundingClientRect();
      const toolbar = rect(".segments-toolbar"),
        heading = rect(".preview-heading");
      const table = rect(".table-shell"),
        video = rect(".preview-frame");
      const style = (s) => {
        const computed = getComputedStyle(document.querySelector(s));
        return [computed.fontSize, computed.color, computed.fontWeight];
      };
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        tableY: table.y,
        videoY: video.y,
        toolbarHeight: toolbar.height,
        headingHeight: heading.height,
        tableGap: table.y - toolbar.bottom,
        videoGap: video.y - heading.bottom,
        headingWeight: getComputedStyle(
          document.querySelector(".preview-heading"),
        ).fontWeight,
        toolbarPadRight: getComputedStyle(
          document.querySelector(".segments-toolbar"),
        ).paddingRight,
        label: style("#preview-target-label"),
        time: style("#preview-time"),
        controls: [...document.querySelectorAll(".preview-language-row")].map(
          (row) => {
            const input = row.querySelector("textarea").getBoundingClientRect();
            const buttons = row
              .querySelector(".field-order-actions")
              .getBoundingClientRect();
            return {
              inputRight: input.right,
              buttonsLeft: buttons.left,
              buttonsRight: buttons.right,
            };
          },
        ),
      };
    });
    expect(geometry.overflow, `${width}px overflow`).toBe(false);
    expect(geometry.time, `${width}px preview type scale`).toEqual(
      geometry.label,
    );
    // Absolute, not only relative: moving the timestamp and the field labels
    // together would slip past an equality check between them.
    expect(geometry.time[0], `${width}px timestamp size`).toBe("14px");
    expect(geometry.headingWeight, `${width}px Card preview weight`).toBe(
      "500",
    );
    expect(geometry.toolbarPadRight, `${width}px toolbar padding`).toBe("4px");
    expect(geometry.toolbarHeight).toBe(geometry.headingHeight);
    expect(geometry.tableGap).toBe(geometry.videoGap);
    if (width === 1280) expect(geometry.tableY).toBe(geometry.videoY);
    for (const control of geometry.controls) {
      expect(control.buttonsLeft).toBeGreaterThan(control.inputRight);
      expect(control.buttonsRight).toBeLessThanOrEqual(width);
    }
  }
  await expect(english).toBeVisible();

  await expect.poll(() => storedOrder(extension)).toBe(true);
  await page.reload();
  await expect(page.locator(".preview-language").first()).toHaveAttribute(
    "data-language",
    "translation",
  );
  await page.locator(".row-preview-button").nth(1).click();
  await expect(page.locator(".preview-language").first()).toHaveAttribute(
    "data-language",
    "translation",
  );
  await page
    .getByRole("button", { name: "Move English down", exact: true })
    .click();
  await expect.poll(() => storedOrder(extension)).toBe(false);
});

async function storedOrder({ worker }) {
  const stored = await worker.evaluate(() =>
    chrome.storage.local.get("draft:abcdefghijk"),
  );
  return stored["draft:abcdefghijk"].translationFirst;
}

function createSegmentedDraft(count) {
  const draft = createDraft({
    targetTrackName: "Chinese (Traditional)",
    title: VIDEO_TITLE,
    translation: "Hello.",
    videoId: VIDEO_ID,
  });
  draft.targetTrack.languageCode = "zh-Hans";
  draft.translationTrack.languageCode = "en-GB";
  draft.translationTrack.name = "English (United Kingdom)";
  draft.segments = Array.from({ length: count }, (_, index) => ({
    ...draft.segments[0],
    endMs: index * 4_000 + 3_000,
    identity: `v4_${index.toString(36).padStart(43, "0")}`,
    pinyin: "",
    selected: true,
    startMs: index * 4_000 + 1_000,
    target: `第${index + 1}句话很长。`,
    translation: `Line ${index + 1}.`,
  }));
  draft.video.durationMs = draft.segments.at(-1).endMs;
  return draft;
}

async function openEditor(
  { context, extensionId, worker },
  draft,
  { beforeLoad, readyTimeout = 5_000 } = {},
) {
  await context.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: previewPlayerFixture }),
  );
  await setExtensionStorage(worker, {
    [`draft:${draft.video.videoId}`]: draft,
  });
  const editor = await context.newPage();
  await editor.setViewportSize({ width: 1280, height: 900 });
  await beforeLoad?.(editor);
  await editor.goto(
    `chrome-extension://${extensionId}/editor/editor.html?video=${draft.video.videoId}`,
  );
  await expect(editor.locator("#editor")).toBeVisible({
    timeout: readyTimeout,
  });
  return editor;
}

// Contrast of the focus ring against whatever it is drawn on: the element's own
// surface when the outline sits inside, the nearest painted ancestor when it
// sits outside.
function focusRingContrast(element) {
  const style = getComputedStyle(element);
  const channels = (value) =>
    value
      .match(/[\d.]+/gu)
      .slice(0, 3)
      .map(Number);
  const luminance = (value) => {
    const [red, green, blue] = channels(value)
      .map((channel) => channel / 255)
      .map((channel) =>
        channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  let node =
    Number.parseFloat(style.outlineOffset) >= 0
      ? element.parentElement
      : element;
  let backdrop = "rgb(255, 255, 255)";
  while (node) {
    const background = getComputedStyle(node).backgroundColor;
    if (channels(background).length === 3 && !background.endsWith(", 0)")) {
      backdrop = background;
      break;
    }
    node = node.parentElement;
  }
  const ring = luminance(style.outlineColor);
  const behind = luminance(backdrop);
  return (Math.max(ring, behind) + 0.05) / (Math.min(ring, behind) + 0.05);
}
