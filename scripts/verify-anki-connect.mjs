import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ankiRoot = join(
  process.env.LOCALAPPDATA ?? "",
  "AnkiProgramFiles",
);
const anki = join(ankiRoot, ".venv", "Scripts", "anki.exe");
const python = join(ankiRoot, ".venv", "Scripts", "python.exe");
const addonSource = join(
  process.env.APPDATA ?? "",
  "Anki2",
  "addons21",
  "2055492159",
);
await Promise.all([
  access(anki),
  access(python),
  access(join(addonSource, "__init__.py")),
]);

const activeAnki = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    [
      "@(Get-CimInstance Win32_Process | Where-Object {",
      "$_.Name -ieq 'anki.exe' -or",
      "($_.Name -ieq 'python.exe' -and",
      "$_.CommandLine -like '*\\Scripts\\anki.exe*')",
      "}).Count",
    ].join(" "),
  ],
  { encoding: "utf8" },
);
if (activeAnki.error || activeAnki.status !== 0) {
  throw new Error(
    `Could not verify that Anki is closed: ${
      activeAnki.error?.message ?? activeAnki.stderr.trim()
    }`,
  );
}
if (Number(activeAnki.stdout.trim()) > 0 || (await portIsOpen(8765))) {
  throw new Error(
    "Close Anki before the disposable AnkiConnect test; refusing to use a running collection.",
  );
}

const root = await mkdtemp(join(tmpdir(), "yt2anki-anki-connect-"));
let ankiProcess;
let ankiOutput = "";
try {
  const preparation = spawnSync(
    python,
    [
      resolve("scripts/prepare_anki_connect.py"),
      root,
      addonSource,
    ],
    { encoding: "utf8" },
  );
  if (preparation.status !== 0) {
    throw new Error(
      `Disposable AnkiConnect setup failed: ${preparation.stderr.trim()}`,
    );
  }

  ankiProcess = spawn(
    anki,
    ["-b", root, "-p", "yt2anki", "-l", "en"],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  for (const stream of [ankiProcess.stdout, ankiProcess.stderr]) {
    stream.on("data", (chunk) => {
      ankiOutput = `${ankiOutput}${chunk}`.slice(-4_000);
    });
  }
  await waitForAnkiConnect().catch((error) => {
    throw new Error(
      `${error.message}${ankiOutput.trim() ? `\n${ankiOutput.trim()}` : ""}`,
    );
  });

  const playwrightCli = resolve(
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  const testResult = spawnSync(
    process.execPath,
    [playwrightCli, "test", "e2e/live-anki.spec.js"],
    {
      encoding: "utf8",
    },
  );
  process.stdout.write(testResult.stdout ?? "");
  process.stderr.write(testResult.stderr ?? "");
  if (testResult.status !== 0) {
    throw new Error(
      testResult.error?.message ??
        "Disposable AnkiConnect integration test failed.",
    );
  }
  console.log(
    "Verified final AnkiConnect export in disposable Anki 25.09.5.",
  );
} finally {
  if (ankiProcess) {
    const cleanup = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve("scripts/close-disposable-anki.ps1"),
        "-BasePath",
        root,
      ],
      { encoding: "utf8" },
    );
    if (cleanup.error || cleanup.status !== 0) {
      throw new Error(
        `Disposable Anki cleanup failed: ${
          cleanup.error?.message ?? cleanup.stderr.trim()
        }`,
      );
    }
  }
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedRoot.startsWith(`${resolvedTemp}\\yt2anki-anki-connect-`)) {
    throw new Error("Refusing to remove a non-temporary Anki base.");
  }
  await rm(resolvedRoot, {
    force: true,
    maxRetries: 20,
    recursive: true,
    retryDelay: 250,
  });
}

async function waitForAnkiConnect() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8765", {
        body: JSON.stringify({
          action: "version",
          params: {},
          version: 6,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = await response.json();
      if (response.ok && body.error === null && body.result >= 6) {
        return;
      }
    } catch {
      // The disposable add-on is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Disposable AnkiConnect did not start.");
}

function portIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    const closed = () => {
      socket.destroy();
      resolveOpen(false);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}
