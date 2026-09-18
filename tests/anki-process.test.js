import assert from "node:assert/strict";
import test from "node:test";
import {
  availablePort,
  isAnkiProcess,
} from "../scripts/anki-process-guard.mjs";

test("recognizes installed Anki launchers and backend processes", () => {
  assert.equal(
    isAnkiProcess({ name: "anki.exe", commandLine: '"C:\\Anki\\anki.exe"' }),
    true,
  );
  assert.equal(
    isAnkiProcess({ name: "ankiw.exe", commandLine: '"C:\\Anki\\ankiw.exe"' }),
    true,
  );
  assert.equal(
    isAnkiProcess({
      name: "python.exe",
      commandLine: '"C:\\Anki\\.venv\\Scripts\\anki.exe"',
    }),
    true,
  );
  assert.equal(
    isAnkiProcess({
      name: "pythonw.exe",
      commandLine: '"C:\\Anki\\.venv\\Scripts\\ankiw.exe"',
    }),
    true,
  );
  assert.equal(
    isAnkiProcess({
      name: "pythonw.exe",
      commandLine: 'pythonw.exe -c "import aqt, sys; aqt.run()"',
    }),
    true,
  );
});

test("does not classify unrelated Python processes as Anki", () => {
  assert.equal(
    isAnkiProcess({
      name: "pythonw.exe",
      commandLine: "pythonw.exe -m http.server",
    }),
    false,
  );
});

test("selects a disposable loopback port", async () => {
  const port = await availablePort();
  assert.equal(Number.isInteger(port), true);
  assert.ok(port > 0 && port <= 65_535);
});
