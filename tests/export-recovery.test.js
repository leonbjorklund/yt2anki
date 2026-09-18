import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_RECOVERY_MAX_AGE_MS,
  isFreshExportRecovery,
} from "../src/export-recovery.ts";

const now = 2_000_000;
const recovery = {
  action: "apkg",
  generationId: "generation-1",
  requestedAt: now,
  videoId: "abcdefghijk",
};

test("accepts current package recovery and rejects retired direct exports", () => {
  assert.equal(isFreshExportRecovery(recovery, now), true);
  assert.equal(
    isFreshExportRecovery({ ...recovery, action: "anki" }, now),
    false,
  );
});

test("rejects expired, future, and malformed recovery records", () => {
  for (const value of [
    { ...recovery, requestedAt: now - EXPORT_RECOVERY_MAX_AGE_MS - 1 },
    { ...recovery, requestedAt: now + 1 },
    { ...recovery, action: "other" },
    { ...recovery, generationId: "" },
    { ...recovery, videoId: "short" },
    null,
  ]) {
    assert.equal(isFreshExportRecovery(value, now), false);
  }
});
