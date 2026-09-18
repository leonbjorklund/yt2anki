import { access, glob, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { dir: { type: "string" } },
  strict: true,
});
const dist = values.dir ? resolve(values.dir) : join(root, "dist");
const files = (
  await Array.fromAsync(glob("**/*", { cwd: dist, withFileTypes: true }))
)
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
const relativeFiles = files
  .map((file) => relative(dist, file).replaceAll("\\", "/"))
  .sort();
const expectedFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "background.js",
  "capture-main.js",
  "editor/editor.css",
  "editor/editor.html",
  "editor/editor.js",
  "icons/action-16.png",
  "icons/action-20.png",
  "icons/action-24.png",
  "icons/action-32.png",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/yt2anki-logo.svg",
  "manifest.json",
  "package-button.css",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "sql-wasm-browser.wasm",
].sort();

if (JSON.stringify(relativeFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Build files differ from the approved v1 boundary");
}
const textFiles = files.filter((file) =>
  [".css", ".html", ".js", ".json", ".md", ".svg", ".txt"].includes(
    extname(file),
  ),
);
const contents = await Promise.all(
  textFiles.map(async (file) => ({
    file,
    text: await readFile(file, "utf8"),
  })),
);

if (files.some((file) => basename(file) === ".env")) {
  throw new Error("Build contains a development .env file");
}

// Screaming-snake credential names, so a future development secret cannot
// reach the build the way a single named key would have slipped past. A bare
// `API_KEY` with no prefix does not match.
const secretVariableName =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|SECRET|TOKEN|PASSWORD)\b/u;
if (contents.some(({ text }) => secretVariableName.test(text))) {
  throw new Error("Build contains a prefixed secret variable name");
}

// sql.js embeds an Emscripten "/home/web_user" virtual path, so only a real
// Windows user directory counts as a leaked developer path.
if (
  contents.some(({ text }) => /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/u.test(text))
) {
  throw new Error("Build contains a Windows user directory path");
}

const manifest = JSON.parse(
  await readFile(join(dist, "manifest.json"), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
if (manifest.version !== packageJson.version) {
  throw new Error(
    `Manifest version ${manifest.version} differs from package version ${packageJson.version}`,
  );
}
const expectedHosts = [];
const expectedOptionalHosts = ["https://www.youtube.com/*"];

if (
  JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)
) {
  throw new Error("Manifest host permissions exceed the approved v1 boundary");
}

if (
  JSON.stringify(manifest.optional_host_permissions) !==
  JSON.stringify(expectedOptionalHosts)
) {
  throw new Error(
    "Manifest optional host permissions exceed the approved v1 boundary",
  );
}

const expectedPermissions = [
  "activeTab",
  "declarativeNetRequestWithHostAccess",
  "scripting",
  "storage",
];
if (
  JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)
) {
  throw new Error("Manifest permissions exceed the approved v1 boundary");
}

const expectedOptionalPermissions = ["downloads", "downloads.open"];
if (
  JSON.stringify(manifest.optional_permissions) !==
  JSON.stringify(expectedOptionalPermissions)
) {
  throw new Error(
    "Manifest optional permissions exceed the approved v1 boundary",
  );
}

const expectedExtensionCsp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'; frame-src https://www.youtube.com; base-uri 'none'; form-action 'none'";
if (
  manifest.content_security_policy?.extension_pages !== expectedExtensionCsp
) {
  throw new Error(
    "Manifest extension-page CSP exceeds the approved v1 boundary",
  );
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
  "icons/yt2anki-logo.svg",
  "capture-main.js",
  "sql-wasm-browser.wasm",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
if (referencedFiles.some((file) => typeof file !== "string" || !file)) {
  throw new Error("Manifest contains an invalid local file reference");
}
await Promise.all(referencedFiles.map((file) => access(join(dist, file))));

const thirdPartyNotices = await readFile(
  join(dist, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);
for (const requiredNotice of [
  "ankipack 0.3.0",
  "fflate 0.8.3",
  "fzstd 0.1.1",
  "pinyin-pro 3.29.3",
  "sql.js 1.14.1",
  "@bufbuild/protobuf 2.13.0",
  "Apache License 2.0",
  "BSD 3-Clause License",
]) {
  if (!thirdPartyNotices.includes(requiredNotice)) {
    throw new Error(`Third-party notices omit ${requiredNotice}`);
  }
}

if (
  contents.some(
    ({ file, text }) =>
      extname(file) === ".js" &&
      (/(?:\bfrom\s*|\bimport\s*\()\s*["']node:/u.test(text) ||
        /sourceMappingURL=/u.test(text)),
  )
) {
  throw new Error("Build contains a Node.js import or source map reference");
}

console.log(
  `Verified ${files.length} build files with no bundled development secret.`,
);
