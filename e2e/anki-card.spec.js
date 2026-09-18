import { expect, test } from "@playwright/test";
import {
  ANSWER_TEMPLATE,
  CARD_CSS,
  PINYIN_ANSWER_TEMPLATE,
  PINYIN_CARD_CSS,
} from "../src/anki/templates.ts";

// A caption long enough to wrap on a phone and to fill a desktop Card.
const LONG_FIELDS = {
  EndMs: "3000",
  Pinyin:
    "cái bú huì yīn wèi guò yú yī lài yí gè mù biāo dì chéng huò zhě shī bài lái zuò chū bù míng zhì de xuǎn zé。",
  StartMs: "1000",
  Target: "才不会因为过于依赖一个目标的成或者失败来做出不明智的选择。",
  Translation:
    "we won’t base them solely on whether one goal succeeds or fails, and end up making unwise choices.",
  VideoId: "abcdefghijk",
};

for (const [colorScheme, textColor] of [
  ["light", "rgb(23, 25, 28)"],
  ["dark", "rgb(244, 245, 247)"],
]) {
  // The Card body font size is clamp(30px, 3.25vw, 34px): the phone width sits
  // on the lower bound and the desktop width on the upper one.
  for (const [width, frameWidth, fontSize] of [
    [390, 358, "30px"],
    [1280, 760, "34px"],
  ]) {
    test(`Anki answer fits a ${width}px Card in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await renderCard(
        page,
        PINYIN_ANSWER_TEMPLATE,
        PINYIN_CARD_CSS,
        LONG_FIELDS,
      );
      if (colorScheme === "dark") {
        await page
          .locator("body")
          .evaluate((element) => element.classList.add("nightMode"));
      }

      // Anki paints the window behind the Card, so the Card adds no background.
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(page.locator("body")).toHaveCSS("color", textColor);
      await expect(page.locator(".yt2anki-status")).toBeHidden();

      const text = page.locator(".yt2anki-answer span");
      await expect(text).toHaveText([
        LONG_FIELDS.Target,
        LONG_FIELDS.Pinyin,
        LONG_FIELDS.Translation,
      ]);
      const sizes = await text.evaluateAll((spans) =>
        spans.map((span) => getComputedStyle(span).fontSize),
      );
      expect(sizes).toEqual([fontSize, fontSize, fontSize]);

      const layout = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect();
        const frame = rect(".yt2anki-frame");
        const answer = rect(".yt2anki-answer");
        return {
          answerGap: answer.top - frame.bottom,
          aspectRatio: frame.width / frame.height,
          fitsViewport:
            document.documentElement.scrollWidth <= innerWidth &&
            frame.left >= 0 &&
            frame.right <= innerWidth &&
            answer.left >= 0 &&
            answer.right <= innerWidth,
          frameWidth: frame.width,
        };
      });
      expect(layout.fitsViewport).toBe(true);
      expect(layout.frameWidth).toBe(frameWidth);
      expect(layout.aspectRatio).toBeCloseTo(16 / 9, 4);
      expect(layout.answerGap).toBe(20);
    });
  }
}

test("Anki answers preserve optional fields and Chinese Pinyin placement", async ({
  page,
}) => {
  for (const underTranslation of ["", "1"]) {
    await renderCard(page, PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS, {
      Target: "Target",
      Translation: "Translation",
      Pinyin: "Pinyin",
      PinyinUnderTranslation: underTranslation,
    });
    await expect(page.locator(".yt2anki-answer span")).toHaveText(
      underTranslation
        ? ["Target", "Translation", "Pinyin"]
        : ["Target", "Pinyin", "Translation"],
    );
  }
  for (const [template, css] of [
    [ANSWER_TEMPLATE, CARD_CSS],
    [PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS],
  ]) {
    await renderCard(page, template, css, { Target: "Target only" });
    await expect(page.locator(".yt2anki-answer span")).toHaveText([
      "Target only",
    ]);
    await expect(page.locator(".yt2anki-answer-group:empty")).toBeHidden();
  }
});

test("Anki night mode preserves the host background and readable text", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const [host, className] of [
    ["body", "nightMode"],
    ["body", "night_mode"],
    ["html", "night-mode"],
  ]) {
    await renderCard(page, PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS, {
      Target: "你好",
      Translation: "Hello",
      Pinyin: "nǐ hǎo",
    });
    await page.evaluate(() => {
      const hostStyle = document.createElement("style");
      hostStyle.textContent = "body { background: rgb(32, 33, 34); }";
      document.head.prepend(hostStyle);
    });
    await page
      .locator(host)
      .evaluate((element, name) => element.classList.add(name), className);
    const appearance = await page.locator("body").evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
    expect(appearance).toEqual({
      background: "rgb(32, 33, 34)",
      color: "rgb(244, 245, 247)",
    });
    await expect(page.locator(".yt2anki-pinyin")).toHaveCSS(
      "color",
      "rgb(244, 245, 247)",
    );
    await page
      .locator(host)
      .evaluate((element, name) => element.classList.remove(name), className);
  }
});

test("Anki light mode keeps dark text when the system prefers dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await renderCard(page, PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS, {
    Target: "你好",
    Translation: "Hello",
    Pinyin: "nǐ hǎo",
  });
  await page.locator("body").evaluate((element) => {
    element.style.background = "white";
  });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".yt2anki-pinyin")).toHaveCSS(
    "color",
    "rgb(23, 25, 28)",
  );
});

test("long edited Pinyin wraps within a narrow Card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await renderCard(page, PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS, {
    Target: "你好",
    Pinyin: "ā".repeat(40),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("answer order reverses language groups with Pinyin under Chinese", async ({
  page,
}) => {
  for (const translationFirst of ["", "1"]) {
    for (const underTranslation of ["", "1"]) {
      for (const hasPinyin of [false, true]) {
        const targetGroup =
          underTranslation || !hasPinyin
            ? ["First language"]
            : ["First language", "Pronunciation"];
        const translationGroup =
          underTranslation && hasPinyin
            ? ["Second language", "Pronunciation"]
            : ["Second language"];
        await renderCard(page, PINYIN_ANSWER_TEMPLATE, PINYIN_CARD_CSS, {
          Target: "First language",
          Translation: "Second language",
          TranslationFirst: translationFirst,
          PinyinUnderTranslation: underTranslation,
          Pinyin: hasPinyin ? "Pronunciation" : "",
        });
        await expect(page.locator(".yt2anki-answer span")).toHaveText(
          translationFirst
            ? [...translationGroup, ...targetGroup]
            : [...targetGroup, ...translationGroup],
        );
      }
    }
    await renderCard(page, ANSWER_TEMPLATE, CARD_CSS, {
      Target: "First",
      Translation: "Second",
      TranslationFirst: translationFirst,
    });
    await expect(page.locator(".yt2anki-answer span")).toHaveText(
      translationFirst ? ["Second", "First"] : ["First", "Second"],
    );
    await renderCard(page, ANSWER_TEMPLATE, CARD_CSS, {
      Target: "First",
      TranslationFirst: translationFirst,
    });
    await expect(page.locator(".yt2anki-answer span")).toHaveText(["First"]);
  }
});

async function renderCard(page, template, css, fields) {
  let html = template.replace(/<script>[\s\S]*?<\/script>/gu, "");
  const sections = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/gu;
  while (sections.test(html)) {
    sections.lastIndex = 0;
    html = html.replace(sections, (_match, operator, field, contents) =>
      Boolean(fields[field]) === (operator === "#") ? contents : "",
    );
  }
  html = html.replace(
    /\{\{(\w+)\}\}/gu,
    (_match, field) => fields[field] ?? "",
  );
  await page.setContent(
    `<style>${css}</style><body class="card"><div id="qa">${html}</div></body>`,
  );
}
