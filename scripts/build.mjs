import {
  access,
  copyFile,
  cp,
  glob,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stableDist = join(root, "dist");
const { values } = parseArgs({
  options: {
    "out-dir": { type: "string" },
  },
  strict: true,
});
const outputDir = values["out-dir"] ? resolve(values["out-dir"]) : stableDist;
await assertBuildOutput(outputDir);
const manifest = JSON.parse(
  await readFile(join(root, "src", "manifest.json"), "utf8"),
);
const browserTarget = `chrome${manifest.minimum_chrome_version}`;
const browserNodeStub = {
  name: "browser-node-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
      namespace: "browser-node-stub",
      path: "node:fs/promises",
    }));
    buildContext.onLoad(
      {
        filter: /.*/,
        namespace: "browser-node-stub",
      },
      () => ({
        contents:
          "export async function writeFile() { throw new Error('Filesystem writes are unavailable in the browser.'); }",
        loader: "js",
      }),
    );
  },
};

async function listEntries(directory, keep) {
  return (
    await Array.fromAsync(glob("**/*", { cwd: directory, withFileTypes: true }))
  )
    .filter((entry) => keep(entry))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

async function listFiles(directory) {
  return listEntries(directory, (entry) => entry.isFile());
}

function ancestorDirectories(relativePath) {
  const directories = [];
  for (
    let current = dirname(relativePath);
    current !== "." && current !== dirname(current);
    current = dirname(current)
  ) {
    directories.push(current);
  }
  return directories;
}

async function writeBuild(staging) {
  await mkdir(outputDir, { recursive: true });
  const stagedFiles = (await listFiles(staging)).sort();
  const manifest = "manifest.json";

  for (const relativePath of stagedFiles.filter((file) => file !== manifest)) {
    const target = join(outputDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(staging, relativePath), target);
  }

  await copyFile(join(staging, manifest), join(outputDir, manifest));

  const expected = new Set(stagedFiles);
  for (const relativePath of await listFiles(outputDir)) {
    if (!expected.has(relativePath)) {
      await rm(join(outputDir, relativePath), { force: true });
    }
  }

  const expectedDirectories = new Set(
    stagedFiles.flatMap((file) => ancestorDirectories(file)),
  );
  const staleDirectories = (
    await listEntries(outputDir, (entry) => entry.isDirectory())
  )
    .filter((relativePath) => !expectedDirectories.has(relativePath))
    .sort((left, right) => right.length - left.length);
  for (const relativePath of staleDirectories) {
    await rm(join(outputDir, relativePath), { force: true, recursive: true });
  }
}

async function assertBuildOutput(directory) {
  if (directory === stableDist) {
    return;
  }

  const temporaryRoot = resolve(tmpdir());
  const fromTemporaryRoot = relative(temporaryRoot, directory);
  const topLevelDirectory = fromTemporaryRoot.split(sep)[0];
  if (
    !fromTemporaryRoot ||
    fromTemporaryRoot === ".." ||
    fromTemporaryRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromTemporaryRoot) ||
    !topLevelDirectory.startsWith("yt2anki-")
  ) {
    throw new Error(
      "--out-dir must be inside an OS temporary directory named yt2anki-*.",
    );
  }

  // The yt2anki-* name is also used by disposable Anki bases and package
  // fixtures, and writeBuild deletes whatever it did not stage. Only an empty
  // directory or an earlier build output may be overwritten.
  const entries = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  if (entries.length === 0) {
    return;
  }
  try {
    await access(join(directory, "manifest.json"));
  } catch {
    throw new Error(
      "--out-dir must be empty or a previous build output; refusing to overwrite unrelated files.",
    );
  }
}

const staging = await mkdtemp(join(tmpdir(), "yt2anki-build-"));
try {
  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: {
      background: "src/background.ts",
      "popup/popup": "src/popup/popup.ts",
      "editor/editor": "src/editor/editor.ts",
    },
    format: "esm",
    logLevel: "info",
    minify: true,
    outdir: staging,
    platform: "browser",
    plugins: [browserNodeStub],
    sourcemap: false,
    target: browserTarget,
  });

  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: ["src/capture/main.ts"],
    format: "iife",
    globalName: "yt2ankiCaptureBundle",
    logLevel: "info",
    minify: true,
    outfile: join(staging, "capture-main.js"),
    platform: "browser",
    target: browserTarget,
  });

  for (const file of [
    "../LICENSE",
    "../THIRD_PARTY_NOTICES.md",
    "manifest.json",
    "popup/popup.html",
    "popup/popup.css",
    "package-button.css",
    "editor/editor.html",
    "editor/editor.css",
  ]) {
    const source = join(root, "src", file);
    const target = join(staging, file.replace(/^\.\.\//u, ""));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }

  await cp(
    join(root, "node_modules", "sql.js", "dist", "sql-wasm-browser.wasm"),
    join(staging, "sql-wasm-browser.wasm"),
  );
  await cp(join(root, "src", "icons"), join(staging, "icons"), {
    recursive: true,
  });

  await writeBuild(staging);
} finally {
  await rm(staging, { force: true, recursive: true });
}
