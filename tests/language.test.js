import assert from "node:assert/strict";
import test from "node:test";
import * as language from "../src/domain/language.ts";

test("keeps only supported standard Caption Tracks", () => {
  const tracks = [
    track(".zh-CN", "zh-CN"),
    track(".zh-SG", "zh-SG", "standard"),
    track("a.en", "en", "asr"),
    track(".forced", "en", "forced"),
    track(".unknown", "en", "future-kind"),
  ];

  assert.deepEqual(language.supportedCaptionTracks(tracks), tracks.slice(0, 2));
});

test("extracts normalized base languages", () => {
  assert.equal(language.baseLanguage("zh-Hans"), "zh");
  assert.equal(language.baseLanguage("EN-gb"), "en");
  assert.equal(language.baseLanguage("not_a_language"), "not_a_language");
});

test("chooses the Chinese Segment field with Target precedence", () => {
  assert.equal(
    language.chineseSegmentField(track("target", "zh-Hans"), null),
    "target",
  );
  assert.equal(
    language.chineseSegmentField(
      track("target", "en"),
      track("translation", "zh-CN"),
    ),
    "translation",
  );
  assert.equal(
    language.chineseSegmentField(
      track("target", "zh-Hans"),
      track("translation", "zh-CN"),
    ),
    "target",
  );
  // pinyin-pro has no traditional dictionary, so Traditional offers no Pinyin.
  for (const traditional of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"]) {
    assert.equal(
      language.chineseSegmentField(track("target", traditional), null),
      null,
    );
  }
  assert.equal(
    language.chineseSegmentField(
      track("target", "en"),
      track("translation", "fr"),
    ),
    null,
  );
});

function track(id, languageCode, kind = null) {
  return { id, kind, languageCode, name: languageCode };
}
