import assert from "node:assert/strict";
import test from "node:test";
import {
  matchManualTrack,
  manualTracks,
} from "../src/domain/language.ts";

const tracks = [
  track(".zh", "zh"),
  track(".zh-Hans", "zh-Hans"),
  track(".zh-Hant", "zh-Hant"),
  track(".en-GB", "en-GB"),
  track("a.en", "en", "asr"),
];

test("prefers an exact locale among multiple writing variants", () => {
  assert.deepEqual(matchManualTrack(tracks, "zh-Hans"), {
    status: "matched",
    track: tracks[1],
  });
});

test("accepts a sole base-language track with unspecified script", () => {
  assert.deepEqual(matchManualTrack([tracks[0]], "zh-Hans"), {
    status: "matched",
    track: tracks[0],
  });
});

test("does not cross Simplified and Traditional Chinese", () => {
  assert.deepEqual(matchManualTrack([tracks[2]], "zh-Hans"), {
    status: "missing",
  });
  assert.deepEqual(
    matchManualTrack([track(".zh-TW", "zh-TW")], "zh-Hans"),
    { status: "missing" },
  );
});

test("asks when multiple compatible variants remain", () => {
  const result = matchManualTrack(
    [track(".zh-CN", "zh-CN"), track(".zh-SG", "zh-SG")],
    "zh-Hans",
  );
  assert.equal(result.status, "ambiguous");
});

test("excludes ASR tracks", () => {
  assert.deepEqual(manualTracks(tracks).map(({ id }) => id), [
    ".zh",
    ".zh-Hans",
    ".zh-Hant",
    ".en-GB",
  ]);
  assert.deepEqual(matchManualTrack([tracks[4]], "en-GB"), {
    status: "missing",
  });
});

function track(id, languageCode, kind = null) {
  return { id, kind, languageCode, name: languageCode };
}
