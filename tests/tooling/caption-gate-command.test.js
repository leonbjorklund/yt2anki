import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import gateConfig from "../../playwright.caption-gate.config.mjs";

const root = resolve(import.meta.dirname, "..", "..");

test("only the caption-gate config can reach the live gate", () => {
  const shared = listSpecFiles([]);
  const gate = listSpecFiles(["--config=playwright.caption-gate.config.mjs"]);

  assert.ok(shared.length > 0, "the shared config lists no browser specs");
  assert.equal(shared.includes("caption-gate.spec.js"), false);
  assert.deepEqual(gate, ["caption-gate.spec.js"]);
});

test("the live caption gate stops on the first failure", () => {
  assert.equal(gateConfig.maxFailures, 1);
});

test("the live caption command runs through the caption-gate config", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );

  assert.match(
    packageJson.scripts["test:e2e:caption-gate"],
    /--config=playwright\.caption-gate\.config\.mjs/u,
  );
});

// AGENTS.md keeps every Anki command on a disposable base. Nothing else stops
// one of these being repointed at a runner that reaches a real collection.
test("Anki commands run only the disposable integration runners", async () => {
  const { scripts } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const ankiCommands = Object.entries(scripts).filter(([name]) =>
    name.startsWith("test:anki:"),
  );

  assert.deepEqual(
    ankiCommands.map(([name]) => name),
    ["test:anki:apkg", "test:anki:playback"],
  );
  for (const [name, command] of ankiCommands) {
    assert.match(command, /^node tests\/integration\/[\w-]+\.mjs$/u, name);
  }
});

// Every non-live browser spec has to run. Naming files in the script would let
// a new spec sit unrun while the suite still reports green.
test("the browser command runs every spec the shared config lists", async () => {
  const { scripts } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );

  assert.equal(scripts["test:e2e"], "playwright test");
});

function listSpecFiles(args) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "@playwright", "test", "cli.js"),
      "test",
      "--list",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return [...new Set(result.stdout.match(/[\w.-]+\.spec\.js/gu) ?? [])].sort();
}
