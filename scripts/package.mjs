import { spawnSync } from "node:child_process";
import { glob, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { dir: { type: "string" }, out: { type: "string" } },
  strict: true,
});
if (!values.out?.endsWith(".zip")) {
  throw new Error("Pass --out with a new .zip file path.");
}
const source = resolve(values.dir ?? resolve(root, "dist"));
const output = resolve(values.out);
const physicalOutput = await resolvePhysicalPath(output);
for (const protectedDirectory of [source, resolve(root, "dist")]) {
  const path = relative(
    await resolvePhysicalPath(protectedDirectory),
    physicalOutput,
  );
  if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
    throw new Error(
      "The ZIP must be outside the build directory and stable dist.",
    );
  }
}

const verification = spawnSync(
  process.execPath,
  [resolve(root, "scripts/verify-build.mjs"), "--dir", source],
  { cwd: root, stdio: "inherit" },
);
if (verification.error || verification.status !== 0) {
  throw new Error("Build verification failed; no ZIP was written.");
}

const files = (
  await Array.fromAsync(glob("**/*", { cwd: source, withFileTypes: true }))
)
  .filter((entry) => entry.isFile())
  .map((entry) =>
    relative(source, resolve(entry.parentPath, entry.name)).replaceAll(
      "\\",
      "/",
    ),
  )
  .sort();
const entries = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [file, await readFile(resolve(source, file))]),
  ),
);
// ZIP timestamps are local wall time. Construct the same local date in every
// timezone instead of passing a UTC timestamp that shifts across machines.
const archive = zipSync(entries, {
  level: 9,
  mtime: new Date(2000, 0, 1, 0, 0, 0),
  os: 0,
  attrs: 0,
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive, { flag: "wx" });
console.log(`Packaged verified build: ${output}`);

async function resolvePhysicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (error.code !== "ENOENT" || parent === path) throw error;
    // Resolve existing junctions before appending directories not yet created.
    return resolve(await resolvePhysicalPath(parent), basename(path));
  }
}
