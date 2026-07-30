import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApkg } from "../src/anki/apkg.ts";

class CdpSession {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      socket.onopen = resolveOpen;
      socket.onerror = reject;
    });
    return new CdpSession(socket);
  }

  constructor(socket) {
    this.contexts = [];
    this.nextId = 0;
    this.pending = new Map();
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      } else if (message.method === "Runtime.executionContextCreated") {
        this.contexts.push(message.params.context);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveMessage) => {
      this.pending.set(id, resolveMessage);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const ankiRoot = join(
  process.env.LOCALAPPDATA ?? "",
  "AnkiProgramFiles",
);
const anki = join(ankiRoot, ".venv", "Scripts", "anki.exe");
const python = join(ankiRoot, ".venv", "Scripts", "python.exe");
await Promise.all([access(anki), access(python)]);

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
if (Number(activeAnki.stdout.trim()) > 0) {
  throw new Error(
    "Close Anki before the disposable playback test; refusing to use a running collection.",
  );
}

const root = await mkdtemp(join(tmpdir(), "yt2anki-anki-playback-"));
const packagePath = join(root, "final.apkg");
const wasmPath = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
globalThis.chrome = {
  runtime: {
    getURL: () => wasmPath,
  },
};

const identity = "v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const segment = {
  alignmentQuality: "matched",
  endMs: 12_000,
  identity,
  selected: true,
  sourceEndMs: 12_000,
  sourceStartMs: 5_000,
  startMs: 5_000,
  target: "Final template playback check.",
  translation: "Final template playback check.",
};
const draft = {
  activeSegmentIdentity: identity,
  nativeLocale: "en-GB",
  nativeTrack: null,
  segments: [segment],
  sourceTabId: 1,
  targetLocale: "en-GB",
  targetTrack: {
    id: ".en",
    kind: null,
    languageCode: "en",
    name: "English",
  },
  version: 1,
  video: {
    compatibility: {
      embeddable: true,
      hasOpus: true,
      hasVp9: true,
    },
    durationMs: 20_000,
    title: "Final playback fixture",
    tracks: [],
    videoId: "M7lc1UVf-VE",
  },
};

let ankiProcess;
try {
  await writeFile(
    packagePath,
    await buildApkg({
      deckName: "yt2anki::Final playback fixture",
      draft,
      segments: [segment],
    }),
  );
  const preparation = spawnSync(
    python,
    [
      resolve("scripts/prepare_anki_playback.py"),
      root,
      packagePath,
    ],
    { encoding: "utf8" },
  );
  if (preparation.status !== 0) {
    throw new Error(
      `Disposable Anki setup failed: ${preparation.stderr.trim()}`,
    );
  }

  const port = await availablePort();
  ankiProcess = spawn(
    anki,
    [
      "-b",
      root,
      "-p",
      "yt2anki",
      "--safemode",
      "-l",
      "en",
    ],
    {
      env: {
        ...process.env,
        QTWEBENGINE_REMOTE_DEBUGGING: String(port),
      },
      stdio: "ignore",
      windowsHide: false,
    },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => Boolean(await target(endpoint, "main webview")), {
    message: "Anki reviewer webview did not start.",
    timeoutMs: 30_000,
  });

  await waitFor(
    async () =>
      String(await evaluate(endpoint, "main webview", "document.body.innerText"))
        .includes("Final playback fixture"),
    {
      message: "The packaged Video Deck is not visible in Anki.",
      timeoutMs: 10_000,
    },
  );
  await evaluate(
    endpoint,
    "main webview",
    `(() => {
      const deck = [...document.querySelectorAll("a.deck")]
        .find((item) => item.textContent.includes("Final playback fixture"));
      if (!deck) throw new Error("Video Deck link missing");
      deck.click();
    })()`,
  );
  await waitFor(
    async () =>
      String(await evaluate(endpoint, "main webview", "document.body.innerText"))
        .includes("Study Now"),
    {
      message: "The packaged Card is not available to study.",
      timeoutMs: 10_000,
    },
  );
  await evaluate(
    endpoint,
    "main webview",
    `(() => {
      const button = [...document.querySelectorAll("button, a")]
        .find((item) => item.textContent.trim() === "Study Now");
      if (!button) throw new Error("Study Now button missing");
      button.click();
    })()`,
  );

  await waitFor(
    async () =>
      (await cardState(endpoint))?.autoplay === "true",
    {
      message: "The final question template did not render.",
      timeoutMs: 10_000,
    },
  );
  await waitFor(
    async () => {
      const state = await videoState(endpoint);
      return (
        state?.paused === false &&
        state.ready >= 3 &&
        state.time >= 5 &&
        state.time < 12
      );
    },
    {
      message: "The final question template did not autoplay at 5 seconds.",
      timeoutMs: 20_000,
    },
  );
  await waitFor(
    async () => {
      const state = await videoState(endpoint);
      return state?.paused === true && state.time >= 11.8;
    },
    {
      message: "The final question template did not stop at 12 seconds.",
      timeoutMs: 15_000,
    },
  );
  const question = await cardState(endpoint);
  if (question.status || question.playHidden) {
    throw new Error("The final question template ended in an error state.");
  }

  await evaluate(
    endpoint,
    "bottom toolbar",
    `(() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) => item.textContent.includes("Show Answer"));
      if (!button) throw new Error("Show Answer button missing");
      button.click();
    })()`,
  );
  await waitFor(
    async () => {
      const state = await cardState(endpoint);
      return (
        state?.autoplay === "false" &&
        state.target === segment.target &&
        state.translation === segment.translation
      );
    },
    {
      message: "The final answer template did not render.",
      timeoutMs: 10_000,
    },
  );
  await delay(1_500);
  const answerInitial = await videoState(endpoint);
  if (!answerInitial?.paused) {
    throw new Error("The final answer template autoplayed unexpectedly.");
  }

  await evaluate(
    endpoint,
    "main webview",
    `document.querySelector(".yt2anki-play").click()`,
  );
  await waitFor(
    async () => {
      const state = await videoState(endpoint);
      return (
        state?.paused === false &&
        state.time >= 5 &&
        state.time < 12
      );
    },
    {
      message: "The final answer replay did not start at 5 seconds.",
      timeoutMs: 15_000,
    },
  );
  await waitFor(
    async () => {
      const state = await videoState(endpoint);
      return state?.paused === true && state.time >= 11.8;
    },
    {
      message: "The final answer replay did not stop at 12 seconds.",
      timeoutMs: 15_000,
    },
  );
  const answer = await cardState(endpoint);
  if (answer.status || answer.playHidden) {
    throw new Error("The final answer template ended in an error state.");
  }

  console.log(
    "Verified final Card playback in disposable Anki 25.09.5.",
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
  if (!resolvedRoot.startsWith(`${resolvedTemp}\\yt2anki-anki-playback-`)) {
    throw new Error("Refusing to remove a non-temporary Anki base.");
  }
  await rm(resolvedRoot, {
    force: true,
    maxRetries: 20,
    recursive: true,
    retryDelay: 250,
  });
}

async function cardState(endpoint) {
  const value = await evaluate(
    endpoint,
    "main webview",
    `JSON.stringify({
      autoplay: document.querySelector(".yt2anki-root")?.dataset.autoplay,
      playHidden: document.querySelector(".yt2anki-play")
        ?.classList.contains("yt2anki-hidden"),
      status: document.querySelector(".yt2anki-status")?.textContent ?? "",
      target: document.querySelector(".yt2anki-target")?.textContent,
      translation: document.querySelector(".yt2anki-translation")?.textContent
    })`,
  );
  return value ? JSON.parse(value) : null;
}

async function videoState(endpoint) {
  const page = await target(endpoint, "main webview");
  if (!page) {
    return null;
  }
  const session = await CdpSession.open(page.webSocketDebuggerUrl);
  try {
    await session.send("Runtime.enable");
    await delay(150);
    const context = session.contexts.find(
      (candidate) =>
        candidate.origin === "https://www.youtube.com" &&
        candidate.auxData?.isDefault,
    );
    if (!context) {
      return null;
    }
    const response = await session.send("Runtime.evaluate", {
      contextId: context.id,
      expression: `JSON.stringify({
        paused: document.querySelector("video")?.paused,
        ready: document.querySelector("video")?.readyState ?? 0,
        time: document.querySelector("video")?.currentTime ?? 0
      })`,
      returnByValue: true,
    });
    const value = response.result?.result?.value;
    return value ? JSON.parse(value) : null;
  } finally {
    session.close();
  }
}

async function evaluate(endpoint, title, expression) {
  const page = await target(endpoint, title);
  if (!page) {
    throw new Error(`Anki target is unavailable: ${title}`);
  }
  const session = await CdpSession.open(page.webSocketDebuggerUrl);
  try {
    const response = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ??
          "Anki JavaScript evaluation failed.",
      );
    }
    return response.result?.result?.value;
  } finally {
    session.close();
  }
}

async function target(endpoint, title) {
  try {
    const response = await fetch(`${endpoint}/json/list`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()).find(
      (candidate) => candidate.title === title,
    );
  } catch {
    return null;
  }
}

async function waitFor(check, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(250);
  }
  throw new Error(options.message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}
