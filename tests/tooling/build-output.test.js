import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  glob,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

const root = resolve(import.meta.dirname, "..", "..");
const stableDist = join(root, "dist");

test("a disposable build leaves stable dist untouched", async () => {
  const before = await snapshotDirectory(stableDist);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-build-test-"));
  const outputDir = join(temporaryRoot, "extension");

  try {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "build.mjs"), "--out-dir", outputDir],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(
      result.status,
      0,
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    const manifest = JSON.parse(
      await readFile(join(outputDir, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.name, "yt2anki");
    const verification = spawnSync(
      process.execPath,
      [join(root, "scripts", "verify-build.mjs"), "--dir", outputDir],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(
      verification.status,
      0,
      `${verification.stdout ?? ""}${verification.stderr ?? ""}`,
    );
    assert.deepEqual(await snapshotDirectory(stableDist), before);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("verification rejects a mismatched version, leaked path, leaked secret name, or missing notice", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-build-test-"));
  const outputDir = join(temporaryRoot, "extension");

  try {
    assert.equal(runBuild(["--out-dir", outputDir]).status, 0);

    await withEdit(
      join(outputDir, "manifest.json"),
      (text) => text.replace(/"version": "[^"]+"/u, '"version": "9.9.9"'),
      () => {
        const result = runVerify(["--dir", outputDir]);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /differs from package version/u);
      },
    );

    await withEdit(
      join(outputDir, "editor", "editor.js"),
      (text) => `${text}\n// C:\\Users\\someone\\projects\\yt2anki\n`,
      () => {
        const result = runVerify(["--dir", outputDir]);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /Windows user directory path/u);
      },
    );

    await withEdit(
      join(outputDir, "editor", "editor.js"),
      (text) => `${text}\nconst key = process.env.SOME_SERVICE_API_KEY;\n`,
      () => {
        const result = runVerify(["--dir", outputDir]);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /prefixed secret variable name/u);
      },
    );

    await withEdit(
      join(outputDir, "THIRD_PARTY_NOTICES.md"),
      (text) => text.replaceAll("pinyin-pro 3.29.3", "pinyin-pro"),
      () => {
        const result = runVerify(["--dir", outputDir]);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /omit pinyin-pro 3\.29\.3/u);
      },
    );

    assert.equal(runVerify(["--dir", outputDir]).status, 0);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("a disposable build refuses a directory it did not create", async () => {
  const ankiBase = await mkdtemp(join(tmpdir(), "yt2anki-anki-playback-"));
  const collection = join(ankiBase, "collection.anki2");

  try {
    await writeFile(collection, "disposable Anki collection");
    const result = runBuild(["--out-dir", ankiBase]);

    assert.notEqual(result.status, 0);
    assert.match(output(result), /must be empty or a previous build output/u);
    assert.equal(
      await readFile(collection, "utf8"),
      "disposable Anki collection",
    );
  } finally {
    await rm(ankiBase, { force: true, recursive: true });
  }
});

test("a rebuild removes stale files and directories", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-build-test-"));
  const outputDir = join(temporaryRoot, "extension");

  try {
    assert.equal(runBuild(["--out-dir", outputDir]).status, 0);
    const stale = join(outputDir, "stale", "nested");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "old.js"), "");

    const rebuild = runBuild(["--out-dir", outputDir]);
    assert.equal(rebuild.status, 0, output(rebuild));
    await assert.rejects(stat(join(outputDir, "stale")));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("a disposable build refuses an unowned temporary root", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "build-guard-test-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "build.mjs"),
        "--out-dir",
        join(temporaryRoot, "extension"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
      /--out-dir must be inside an OS temporary directory named yt2anki-\*/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("ZIP packaging reproduces build bytes across rebuilds and timezones", async () => {
  const before = await snapshotDirectory(stableDist);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-package-test-"));
  const source = join(temporaryRoot, "extension");
  const firstZip = join(temporaryRoot, "first.zip");
  const secondZip = join(temporaryRoot, "second.zip");
  try {
    const firstBuild = runBuild(["--out-dir", source]);
    assert.equal(firstBuild.status, 0, output(firstBuild));
    const first = runPackage(source, firstZip, "Pacific/Honolulu");
    assert.equal(first.status, 0, output(first));
    const firstBytes = await readFile(firstZip);
    const unpacked = unzipSync(firstBytes);
    const built = await snapshotDirectory(source);
    assert.deepEqual(
      Object.keys(unpacked).sort(),
      built.map((file) => file.file),
    );
    assert.ok(unpacked["manifest.json"], "manifest must be at the ZIP root");
    for (const file of built) {
      assert.deepEqual(
        Buffer.from(unpacked[file.file]),
        await readFile(join(source, file.file)),
        file.file,
      );
    }
    const secondBuild = runBuild(["--out-dir", source]);
    assert.equal(secondBuild.status, 0, output(secondBuild));
    await utimes(join(source, "manifest.json"), 1_000_000, 1_000_000);
    const second = runPackage(source, secondZip, "Asia/Tokyo");
    assert.equal(second.status, 0, output(second));
    assert.deepEqual(await readFile(secondZip), firstBytes);

    const overwrite = runPackage(source, firstZip);
    assert.notEqual(overwrite.status, 0);
    assert.deepEqual(await readFile(firstZip), firstBytes);
    assert.deepEqual(await snapshotDirectory(stableDist), before);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("ZIP packaging rejects unsafe output and unapproved build contents", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-package-test-"));
  const source = join(temporaryRoot, "extension");
  const archive = join(temporaryRoot, "rejected.zip");
  try {
    assert.equal(runBuild(["--out-dir", source]).status, 0);
    for (const target of [
      join(source, "bad.zip"),
      join(stableDist, "bad.zip"),
    ]) {
      const result = runPackage(source, target);
      assert.notEqual(result.status, 0);
      assert.match(
        output(result),
        /outside the build directory and stable dist/u,
      );
    }
    await withEdit(
      join(source, "manifest.json"),
      (text) => text.replace(/"version": "[^"]+"/u, '"version": "9.9.9"'),
      () => assert.notEqual(runPackage(source, archive).status, 0),
    );
    await withEdit(
      join(source, "background.js"),
      (text) => `${text}\nconst secret = process.env.SERVICE_API_KEY;\n`,
      () => assert.notEqual(runPackage(source, archive).status, 0),
    );
    await writeFile(join(source, "development.txt"), "not a runtime file");
    assert.notEqual(runPackage(source, archive).status, 0);
    await rm(join(source, "development.txt"));
    await assert.rejects(stat(archive), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("ZIP packaging rejects junction paths into the build before creating directories", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "yt2anki-package-test-"));
  const source = join(temporaryRoot, "extension");
  const alias = join(temporaryRoot, "alias");
  try {
    assert.equal(runBuild(["--out-dir", source]).status, 0);
    await symlink(source, alias, "junction");
    const before = await snapshotDirectory(source);
    for (const [directory, destination] of [
      [source, join(alias, "bad.zip")],
      [source, join(alias, "nested", "bad.zip")],
      [alias, join(source, "bad.zip")],
    ]) {
      const result = runPackage(directory, destination);
      assert.notEqual(result.status, 0);
      assert.match(
        output(result),
        /outside the build directory and stable dist/u,
      );
    }
    assert.deepEqual(await snapshotDirectory(source), before);
    await assert.rejects(stat(join(source, "nested")), { code: "ENOENT" });

    const archive = join(temporaryRoot, "new", "nested", "release.zip");
    const result = runPackage(alias, archive);
    assert.equal(result.status, 0, output(result));
    assert.ok((await stat(archive)).isFile());
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

function runPackage(source, destination, timezone = "UTC") {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/package.mjs"), "--dir", source, "--out", destination],
    { cwd: root, encoding: "utf8", env: { ...process.env, TZ: timezone } },
  );
}

function runBuild(args) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "build.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function runVerify(args) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-build.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function withEdit(file, edit, check) {
  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, edit(original));
    check();
  } finally {
    await writeFile(file, original);
  }
}

async function snapshotDirectory(directory) {
  const files = (
    await Array.fromAsync(glob("**/*", { cwd: directory, withFileTypes: true }))
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  return Promise.all(
    files.map(async (file) => {
      const [contents, metadata] = await Promise.all([
        readFile(file),
        stat(file, { bigint: true }),
      ]);
      return {
        file: relative(directory, file).replaceAll("\\", "/"),
        hash: createHash("sha256").update(contents).digest("hex"),
        modified: metadata.mtimeNs.toString(),
      };
    }),
  );
}
