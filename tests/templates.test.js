import assert from "node:assert/strict";
import test from "node:test";
import {
  ANSWER_TEMPLATE,
  CARD_CSS,
  NOTE_FIELDS,
  PINYIN_ANSWER_TEMPLATE,
  PINYIN_CARD_CSS,
  PINYIN_NOTE_FIELDS,
  QUESTION_TEMPLATE,
} from "../src/anki/templates.ts";

test("includes per-note answer order in the standard Note Type", () => {
  assert.deepEqual(
    [...NOTE_FIELDS],
    [
      "SegmentIdentity",
      "VideoId",
      "StartMs",
      "EndMs",
      "Target",
      "Translation",
      "TranslationFirst",
    ],
  );
  assert.doesNotMatch(ANSWER_TEMPLATE, /Pinyin/u);
  assert.doesNotMatch(CARD_CSS, /yt2anki-pinyin/u);
});

test("uses a separate Pinyin Note Type contract", () => {
  assert.deepEqual(
    [...PINYIN_NOTE_FIELDS],
    [
      "SegmentIdentity",
      "VideoId",
      "StartMs",
      "EndMs",
      "Target",
      "Translation",
      "TranslationFirst",
      "Pinyin",
      "PinyinUnderTranslation",
    ],
  );
});

test("hides native player controls", () => {
  assert.match(QUESTION_TEMPLATE, /controls:\s*0/u);
});

test("uses YouTube bounded playback on both card sides without a competing pause timer", () => {
  for (const template of [
    QUESTION_TEMPLATE,
    ANSWER_TEMPLATE,
    PINYIN_ANSWER_TEMPLATE,
  ]) {
    assert.match(template, /data-autoplay="true"/u);
    assert.doesNotMatch(
      template,
      /setInterval|pauseVideo|seekTo|cueVideoById/u,
    );
    assert.match(
      template,
      /loadVideoById\(\{ videoId, startSeconds: start, endSeconds: end \}\)/u,
    );
  }
});

test("renders required Target before optional Translation", () => {
  const normalOrder = ANSWER_TEMPLATE.split("{{^TranslationFirst}}")[1];
  const translation = normalOrder.indexOf("{{Translation}}");
  const target = normalOrder.indexOf("{{Target}}");
  assert.ok(target >= 0 && target < translation);
  assert.match(
    ANSWER_TEMPLATE,
    /\{\{#Translation\}\}[\s\S]*\{\{Translation\}\}[\s\S]*\{\{\/Translation\}\}/u,
  );
  assert.match(CARD_CSS, /font-size:\s*clamp\(30px, 3\.25vw, 34px\)/u);
  assert.match(CARD_CSS, /flex-direction:\s*column/u);
  assert.match(CARD_CSS, /gap:\s*24px/u);
  assert.match(CARD_CSS, /text-align:\s*center/u);
});

test("renders Pinyin below the selected Chinese answer field", () => {
  assert.match(
    PINYIN_ANSWER_TEMPLATE,
    /\{\{#PinyinUnderTranslation\}\}\{\{#Pinyin\}\}<span class="yt2anki-pinyin">\{\{Pinyin\}\}<\/span>\{\{\/Pinyin\}\}\{\{\/PinyinUnderTranslation\}\}/u,
  );
  assert.match(
    PINYIN_ANSWER_TEMPLATE,
    /<span class="yt2anki-target">\{\{Target\}\}<\/span>\{\{\^PinyinUnderTranslation\}\}\{\{#Pinyin\}\}<span class="yt2anki-pinyin">\{\{Pinyin\}\}<\/span>\{\{\/Pinyin\}\}\{\{\/PinyinUnderTranslation\}\}/u,
  );
  assert.match(
    PINYIN_CARD_CSS,
    /\.yt2anki-answer-group\s*\{[\s\S]*display:\s*contents/u,
  );
  assert.match(
    PINYIN_CARD_CSS,
    /\.yt2anki-pinyin\s*\{[\s\S]*font-size:\s*inherit/u,
  );
});
