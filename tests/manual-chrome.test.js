import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  manualChromeArguments,
  parseManualVideoId,
} from "../scripts/manual-chrome-profile.mjs";

test("manual Chrome accepts a video ID or watch URL", () => {
  assert.equal(parseManualVideoId("APv9hfjYRY0"), "APv9hfjYRY0");
  assert.equal(
    parseManualVideoId("https://www.youtube.com/watch?v=APv9hfjYRY0"),
    "APv9hfjYRY0",
  );
  assert.throws(() => parseManualVideoId("not valid"), /YouTube/u);
});

test("manual Chrome opens setup and video in its dedicated profile", () => {
  assert.deepEqual(
    manualChromeArguments({
      profileDir: "C:\\repo\\.local\\manual-chrome-profile",
      setup: true,
      videoId: "APv9hfjYRY0",
    }),
    [
      "--user-data-dir=C:\\repo\\.local\\manual-chrome-profile",
      "--no-default-browser-check",
      "--no-first-run",
      "--new-window",
      "chrome://extensions/",
      "https://www.youtube.com/watch?v=APv9hfjYRY0",
    ],
  );
});

test("the runtime Chrome shutdown guard matches only its exact profile", () => {
  const profile = "C:\\repo\\.local\\manual-chrome-profile";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      resolve("scripts/close-dedicated-chrome.ps1"),
      "-ProfilePath",
      profile,
      "-MatchOnly",
      "-ProcessListPath",
      resolve("tests/fixtures/chrome-processes.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [101]);
});

for (const operation of ["Close", "Stop"]) {
  test(`manual Chrome tolerates an exit during ${operation}`, () => {
    const result = runShutdownRace(`${operation}Exited`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).InitialCount, 1);
  });

  test(`manual Chrome preserves ${operation} errors for a live process`, () => {
    const result = runShutdownRace(`${operation}Alive`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Process has exited|Synthetic stop failure/u);
  });
}

function runShutdownRace(scenario) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      resolve("tests/fixtures/chrome-shutdown-race.ps1"),
      "-ScriptPath",
      resolve("scripts/close-dedicated-chrome.ps1"),
      "-Scenario",
      scenario,
    ],
    { encoding: "utf8", windowsHide: true },
  );
}
