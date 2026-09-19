import { spawn, spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_MANUAL_VIDEO_ID,
  manualChromeArguments,
  parseManualVideoId,
} from "./manual-chrome-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileDir = join(root, ".local", "manual-chrome-profile");
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const { values } = parseArgs({
  options: {
    label: { type: "string" },
    setup: { type: "boolean" },
    video: { default: DEFAULT_MANUAL_VIDEO_ID, type: "string" },
  },
  strict: true,
});
const label = values.label?.trim();
if (!label || label.length > 40 || /[\r\n]/u.test(label)) {
  throw new Error("--label must contain 1–40 characters on one line.");
}
const videoId = parseManualVideoId(values.video);

await access(chrome);
runChecked(process.execPath, [join(root, "scripts", "build.mjs")]);
runChecked(process.execPath, [join(root, "scripts", "verify-build.mjs")]);
const closedChrome = closeDedicatedChrome();
await mkdir(profileDir, { recursive: true });

launchDedicatedChrome();

console.log("");
console.log(`Manual checkpoint: yt2anki — ${label}`);
if (closedChrome.initialCount > 0) {
  console.log(
    `Closed the previous dedicated Chrome process${
      closedChrome.forcedCount > 0 ? " (forced fallback used)" : ""
    }.`,
  );
}
console.log(`Dedicated Chrome profile: ${profileDir}`);
console.log(`Source Video: https://www.youtube.com/watch?v=${videoId}`);
if (values.setup) {
  console.log(`One-time extension folder: ${join(root, "dist")}`);
}

function closeDedicatedChrome() {
  const shutdown = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      join(root, "scripts", "close-dedicated-chrome.ps1"),
      "-ProfilePath",
      profileDir,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (shutdown.error || shutdown.status !== 0) {
    throw new Error(
      `Could not close the dedicated Chrome process: ${
        shutdown.error?.message ?? shutdown.stderr.trim()
      }`,
    );
  }
  try {
    const result = JSON.parse(shutdown.stdout.trim());
    return {
      forcedCount: Number(result.ForcedCount ?? 0),
      initialCount: Number(result.InitialCount ?? 0),
    };
  } catch {
    throw new Error("Could not parse the dedicated Chrome shutdown result.");
  }
}

function launchDedicatedChrome() {
  const browser = spawn(
    chrome,
    manualChromeArguments({
      profileDir,
      setup: values.setup === true,
      videoId,
    }),
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  browser.unref();
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? `Command failed with status ${result.status}.`,
    );
  }
}
