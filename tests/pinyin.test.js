import assert from "node:assert/strict";
import test from "node:test";
import {
  fillBlankPinyin,
  generateMandarinPinyin,
} from "../src/domain/pinyin.ts";
import { createDraft } from "./fixtures.js";

test("generates tone-marked Mandarin Pinyin and preserves non-Han text", () => {
  assert.equal(
    generateMandarinPinyin("你好，George 2！吕\n一个不对"),
    "nǐ hǎo，George 2！lǚ\nyí gè bú duì",
  );
  assert.equal(generateMandarinPinyin("我very喜欢你"), "wǒveryxǐ huan nǐ");
});

test("fills only blank Pinyin from a Chinese Target", () => {
  const draft = createDraft({ target: "你好。", translation: "Hello." });
  draft.segments.push(
    {
      ...draft.segments[0],
      identity: "second",
      pinyin: "manual correction",
      target: "不对。",
    },
    {
      ...draft.segments[0],
      identity: "third",
      pinyin: "   ",
      target: "吕布。",
    },
    {
      ...draft.segments[0],
      identity: "fourth",
      target: "   ",
    },
    {
      ...draft.segments[0],
      identity: "fifth",
      target: "George 2!",
    },
  );

  assert.deepEqual(fillBlankPinyin(draft), {
    generated: 2,
    kept: 1,
  });
  assert.deepEqual(
    draft.segments.map((segment) => segment.pinyin),
    ["nǐ hǎo。", "manual correction", "lǚ bù。", "", ""],
  );
});

test("uses a Chinese Translation and regenerates a cleared value", () => {
  const draft = createDraft({ target: "Hello.", translation: "一个。" });
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.languageCode = "zh-Hans";

  assert.deepEqual(fillBlankPinyin(draft), {
    generated: 1,
    kept: 0,
  });
  assert.equal(draft.segments[0].pinyin, "yí gè。");

  draft.segments[0].translation = "不对。";
  assert.deepEqual(fillBlankPinyin(draft), {
    generated: 0,
    kept: 1,
  });
  assert.equal(draft.segments[0].pinyin, "yí gè。");

  draft.segments[0].pinyin = "";
  assert.deepEqual(fillBlankPinyin(draft), {
    generated: 1,
    kept: 0,
  });
  assert.equal(draft.segments[0].pinyin, "bú duì。");
});

test("offers no Pinyin for a Traditional Chinese track", () => {
  // pinyin-pro has no traditional dictionary, so it would read 我們 as "wǒ mén".
  for (const languageCode of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"]) {
    const draft = createDraft({ target: "我們。" });
    draft.targetTrack.languageCode = languageCode;

    assert.deepEqual(fillBlankPinyin(draft), { generated: 0, kept: 0 });
    assert.equal(draft.segments[0].pinyin, "");
  }
});

test("leaves Pinyin unchanged when neither track is Chinese", () => {
  const draft = createDraft({ target: "Hello.", translation: "Bonjour." });
  draft.targetTrack.languageCode = "en";
  draft.translationTrack.languageCode = "fr";
  draft.segments[0].pinyin = "manual";

  assert.deepEqual(fillBlankPinyin(draft), {
    generated: 0,
    kept: 1,
  });
  assert.equal(draft.segments[0].pinyin, "manual");
});
