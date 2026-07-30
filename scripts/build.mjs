import {
  copyFile,
  cp,
  glob,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const browserNodeStub = {
  name: "browser-node-stub",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^node:fs\/promises$/ },
      () => ({
        namespace: "browser-node-stub",
        path: "node:fs/promises",
      }),
    );
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

async function listFiles(directory) {
  return (await Array.fromAsync(
    glob("**/*", { cwd: directory, withFileTypes: true }),
  ))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name)),
    );
}

async function publishBuild(staging) {
  await mkdir(dist, { recursive: true });
  const stagedFiles = (await listFiles(staging)).sort();
  const manifest = "manifest.json";

  for (const relativePath of stagedFiles.filter(
    (file) => file !== manifest,
  )) {
    const target = join(dist, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(staging, relativePath), target);
  }

  await copyFile(join(staging, manifest), join(dist, manifest));

  const expected = new Set(stagedFiles);
  for (const relativePath of await listFiles(dist)) {
    if (!expected.has(relativePath)) {
      await rm(join(dist, relativePath), { force: true });
    }
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
    target: "chrome138",
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
    target: "chrome138",
  });

  for (const file of [
    "../LICENSE",
    "../THIRD_PARTY_NOTICES.md",
    "manifest.json",
    "popup/popup.html",
    "popup/popup.css",
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

  await publishBuild(staging);
} finally {
  await rm(staging, { force: true, recursive: true });
}
