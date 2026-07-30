import { access, glob, readFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const files = (await Array.fromAsync(
  glob("**/*", { cwd: dist, withFileTypes: true }),
))
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
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "sql-wasm-browser.wasm",
].sort();

if (JSON.stringify(relativeFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Build files differ from the approved v1 boundary");
}
const textFiles = files.filter((file) =>
  [".css", ".html", ".js", ".json", ".md", ".txt"].includes(extname(file)),
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

if (contents.some(({ text }) => text.includes("GEMINI_API_KEY"))) {
  throw new Error("Build contains the development Gemini variable name");
}

const envPath = join(root, ".env");
let developmentKey = "";
try {
  const envText = await readFile(envPath, "utf8");
  const match = envText.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
  developmentKey = match?.[1]?.replace(/^(['"])(.*)\1$/, "$2") ?? "";
} catch {
  // A clean checkout intentionally has no .env.
}

if (
  developmentKey &&
  contents.some(({ text }) => text.includes(developmentKey))
) {
  throw new Error("Build contains the development Gemini key");
}

const manifest = JSON.parse(
  await readFile(join(dist, "manifest.json"), "utf8"),
);
const expectedHosts = [
  "http://127.0.0.1/*",
  "https://generativelanguage.googleapis.com/*",
];
const expectedOptionalHosts = ["https://www.youtube.com/*"];

if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)) {
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
  JSON.stringify(manifest.permissions) !==
  JSON.stringify(expectedPermissions)
) {
  throw new Error("Manifest permissions exceed the approved v1 boundary");
}

const expectedExtensionCsp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src http://127.0.0.1:8765 https://generativelanguage.googleapis.com; frame-src https://www.youtube.com; base-uri 'none'; form-action 'none'";
if (
  manifest.content_security_policy?.extension_pages !==
  expectedExtensionCsp
) {
  throw new Error("Manifest extension-page CSP exceeds the approved v1 boundary");
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
  "capture-main.js",
  "sql-wasm-browser.wasm",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
if (referencedFiles.some((file) => typeof file !== "string" || !file)) {
  throw new Error("Manifest contains an invalid local file reference");
}
await Promise.all(
  referencedFiles.map((file) => access(join(dist, file))),
);

const thirdPartyNotices = await readFile(
  join(dist, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);
for (const requiredNotice of [
  "ankipack 0.1.3",
  "fflate 0.8.3",
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

console.log(`Verified ${files.length} build files with no bundled development secret.`);
