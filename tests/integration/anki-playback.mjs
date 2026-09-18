import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  activeAnkiProcessCount,
  availablePort,
} from "../../scripts/anki-process-guard.mjs";
import { buildApkg } from "../../src/anki/apkg.ts";
import { DRAFT_SCHEMA_VERSION } from "../../src/domain/types.ts";

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

const ankiRoot = join(process.env.LOCALAPPDATA ?? "", "AnkiProgramFiles");
const anki = join(ankiRoot, ".venv", "Scripts", "anki.exe");
const python = join(ankiRoot, ".venv", "Scripts", "python.exe");
await Promise.all([access(anki), access(python)]);

if (activeAnkiProcessCount() > 0) {
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

const identity = "v4_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const segment = {
  endMs: 848_250,
  identity,
  selected: true,
  startMs: 844_250,
  target: "才不会因为过于依赖一个目标的成或者失败来做出不明智的选择。",
  translation:
    "we won’t base them solely on whether one goal succeeds or fails, and end up making unwise choices.",
  pinyin:
    "cái bú huì yīn wèi guò yú yī lài yí gè mù biāo dì chéng huò zhě shī bài lái zuò chū bù míng zhì de xuǎn zé。",
};
const draft = {
  generationId: "playback-fixture",
  segments: [segment],
  sourceTabId: 1,
  targetTrack: {
    id: ".zh-Hans",
    kind: null,
    languageCode: "zh-Hans",
    name: "Chinese (Simplified)",
  },
  translationTrack: {
    id: ".en",
    kind: null,
    languageCode: "en",
    name: "English",
  },
  translationFirst: false,
  version: DRAFT_SCHEMA_VERSION,
  video: {
    compatibility: {
      embeddable: true,
      hasOpus: true,
      hasVp9: true,
    },
    durationMs: 900_000,
    title: "Final playback fixture",
    tracks: [],
    videoId: "hyDEIdq42cw",
  },
};

let ankiProcess;
try {
  await writeFile(
    packagePath,
    await buildApkg({
      deckName: "Final playback fixture",
      draft,
      segments: [segment],
    }),
  );
  const preparation = spawnSync(
    python,
    [
      resolve("tests/integration/prepare_anki.py"),
      "playback",
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
    ["-b", root, "-p", "yt2anki", "--safemode", "-l", "en"],
    {
      env: {
        ...process.env,
        QTWEBENGINE_REMOTE_DEBUGGING: String(port),
      },
      stdio: "ignore",
      windowsHide: process.env.QT_QPA_PLATFORM === "offscreen",
    },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => Boolean(await target(endpoint, "main webview")), {
    message: "Anki reviewer webview did not start.",
    timeoutMs: 30_000,
  });

  await waitFor(
    async () =>
      String(
        await evaluate(endpoint, "main webview", "document.body.innerText"),
      ).includes("Final playback fixture"),
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
      String(
        await evaluate(endpoint, "main webview", "document.body.innerText"),
      ).includes("Study Now"),
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

  await waitFor(async () => (await cardState(endpoint))?.autoplay === "true", {
    message: "The final question template did not render.",
    timeoutMs: 10_000,
  });
  await verifyPlayback(endpoint, "question");
  await activateCaptions(endpoint);
  await verifyNativeReplay(endpoint, "question");

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
        state?.autoplay === "true" &&
        state.target === segment.target &&
        state.translation === segment.translation &&
        state.targetBeforeTranslation &&
        state.pinyin === segment.pinyin &&
        state.pinyinAfterTarget &&
        state.pinyinMatchesTranslationStyle
      );
    },
    {
      message: "The final answer template did not render.",
      timeoutMs: 10_000,
    },
  );
  const answer = await cardState(endpoint);
  if (!answer.textStylesMatch || !answer.layoutMatches) {
    throw new Error(
      `Answer styles differ from the Card contract: ${JSON.stringify(answer)}`,
    );
  }
  if (process.env.YT2ANKI_PLAYBACK_SCREENSHOT) {
    const screenshotPage = await target(endpoint, "main webview");
    const screenshotSession = await CdpSession.open(
      screenshotPage.webSocketDebuggerUrl,
    );
    try {
      const screenshot = await screenshotSession.send(
        "Page.captureScreenshot",
        { format: "png" },
      );
      if (!screenshot.result?.data)
        throw new Error("Anki screenshot was unavailable.");
      await mkdir(resolve(".tmp"), { recursive: true });
      await writeFile(
        resolve(".tmp/native-card-repair.png"),
        Buffer.from(screenshot.result.data, "base64"),
      );
    } finally {
      screenshotSession.close();
    }
  }

  await verifyPlayback(endpoint, "answer");
  await verifyNativeReplay(endpoint, "answer");

  console.log(
    "Verified both Card sides autoplay, stop, replay, hide CC, and keep their styles in disposable Anki.",
  );
} finally {
  if (ankiProcess) {
    const cleanup = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve("tests/integration/close-disposable-anki.ps1"),
        "-BasePath",
        root,
      ],
      { encoding: "utf8" },
    );
    if (cleanup.error || cleanup.status !== 0) {
      // biome-ignore lint/correctness/noUnsafeFinally: a surviving disposable Anki must fail loudly even when the run already failed.
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
    // biome-ignore lint/correctness/noUnsafeFinally: refusing to delete a non-disposable path must fail loudly even when the run already failed.
    throw new Error("Refusing to remove a non-temporary Anki base.");
  }
  await rm(resolvedRoot, {
    force: true,
    maxRetries: 20,
    recursive: true,
    retryDelay: 250,
  });
}

async function verifyPlayback(endpoint, side) {
  const start = segment.startMs / 1000;
  const end = segment.endMs / 1000;
  let lastState;
  try {
    await waitFor(
      async () => {
        lastState = await videoState(endpoint);
        return (
          lastState?.paused === false &&
          lastState.ready >= 3 &&
          lastState.time >= start - 0.1 &&
          lastState.time < start + 2
        );
      },
      {
        message: `${side} did not start at ${start}s without a Play click.`,
        timeoutMs: 45_000,
      },
    );
    await waitFor(
      async () => {
        lastState = await videoState(endpoint);
        if (
          lastState?.captions.length ||
          Object.keys(lastState?.captionTrack ?? {}).length
        ) {
          throw new Error(`${side} showed captions during playback.`);
        }
        return (
          lastState?.paused === true &&
          lastState.state === 0 &&
          lastState.time >= end - 0.25 &&
          lastState.time <= end + 0.35
        );
      },
      {
        message: `${side} did not reach the native ended state at ${end}s.`,
        timeoutMs: 15_000,
      },
    );
    const card = await cardState(endpoint);
    if (card.status || card.hasCustomPlay) {
      throw new Error(`${side} ended with an error or custom Play control.`);
    }
  } catch (error) {
    throw new Error(
      `${error.message} Card: ${JSON.stringify(await cardState(endpoint))} Video: ${JSON.stringify(lastState)}`,
    );
  }
}

async function activateCaptions(endpoint) {
  let captions;
  await waitFor(
    async () => {
      captions = await evaluateVideo(
        endpoint,
        `JSON.stringify((() => {
      const player = document.querySelector("#movie_player");
      const tracks = player?.getOption?.("captions", "tracklist") ?? [];
      if (!tracks.length) {
        player?.loadModule?.("captions");
        return { available: false };
      }
      const track = tracks.find((item) => item.languageCode === "en") ?? tracks[0];
      player.setOption("captions", "track", track);
      return { available: true, selected: player.getOption("captions", "track") };
    })())`,
      );
      return (
        captions?.available && Object.keys(captions.selected ?? {}).length > 0
      );
    },
    {
      message:
        "Could not activate a real caption track to verify suppression on replay.",
      timeoutMs: 10_000,
    },
  );
  console.log(
    `Activated real caption track before native replay: ${captions.selected.languageCode ?? "available"}.`,
  );
}

async function verifyNativeReplay(endpoint, side) {
  const replay = await evaluateVideo(
    endpoint,
    `JSON.stringify((() => {
    const buttons = [...document.querySelectorAll("button")];
    const visible = buttons.filter((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const replay = visible.find((button) => button.matches(".ytp-play-button, .ytp-large-play-button") || /replay|spela upp video igen/i.test(button.getAttribute("aria-label") ?? button.title));
    if (!replay) return { clicked: false, controls: visible.map((button) => button.getAttribute("aria-label") ?? button.title) };
    replay.click();
    return { clicked: true };
  })())`,
    true,
  );
  if (!replay?.clicked) {
    throw new Error(
      `${side} has no visible native Replay control: ${JSON.stringify(replay)}`,
    );
  }
  await verifyPlayback(endpoint, `${side} native replay`);
}

async function cardState(endpoint) {
  const value = await evaluate(
    endpoint,
    "main webview",
    `JSON.stringify({
      autoplay: document.querySelector(".yt2anki-root")?.dataset.autoplay,
      hasCustomPlay: Boolean(document.querySelector(".yt2anki-play")),
      status: document.querySelector(".yt2anki-status")?.textContent ?? "",
      target: document.querySelector(".yt2anki-target")?.textContent,
      translation: document.querySelector(".yt2anki-translation")?.textContent,
      pinyin: document.querySelector(".yt2anki-pinyin")?.textContent,
      textStylesMatch: (() => {
        const spans = [...document.querySelectorAll(".yt2anki-answer span")];
        const styles = spans.map((span) => getComputedStyle(span));
        return styles.length === 3 && styles.every((style) =>
          style.fontSize === styles[0].fontSize && style.color === styles[0].color &&
          parseFloat(style.fontSize) >= 30 && parseFloat(style.fontSize) <= 34
        );
      })(),
      layout: (() => {
        const root = document.querySelector(".yt2anki-root");
        const answer = document.querySelector(".yt2anki-answer");
        return {
          rootWidth: root?.getBoundingClientRect().width,
          answerWidth: answer?.getBoundingClientRect().width,
          gap: answer && getComputedStyle(answer).gap,
          background: document.body && getComputedStyle(document.body).backgroundColor,
          cardBackground: document.querySelector(".card") && getComputedStyle(document.querySelector(".card")).backgroundColor,
          classes: document.body?.className
        };
      })(),
      layoutMatches: (() => {
        const root = document.querySelector(".yt2anki-root");
        const answer = document.querySelector(".yt2anki-answer");
        return Boolean(root && answer &&
          root.getBoundingClientRect().width <= 760 &&
          answer.getBoundingClientRect().width <= 1020 &&
          getComputedStyle(answer).gap === "24px"
        );
      })(),
      pinyinAfterTarget: (() => {
        const translation = document.querySelector(".yt2anki-translation");
        const pinyin = document.querySelector(".yt2anki-pinyin");
        return Boolean(
          translation && pinyin &&
          document.querySelector(".yt2anki-target")?.parentElement === pinyin.parentElement &&
          document.querySelector(".yt2anki-target")?.nextElementSibling === pinyin
        );
      })(),
      pinyinMatchesTranslationStyle: (() => {
        const translation = document.querySelector(".yt2anki-translation");
        const pinyin = document.querySelector(".yt2anki-pinyin");
        return Boolean(
          translation && pinyin &&
          getComputedStyle(pinyin).fontSize === getComputedStyle(translation).fontSize &&
          getComputedStyle(pinyin).color === getComputedStyle(translation).color
        );
      })(),
      targetBeforeTranslation: (() => {
        const answer = document.querySelector(".yt2anki-answer");
        const translation = answer?.querySelector(".yt2anki-translation");
        const target = answer?.querySelector(".yt2anki-target");
        const translationGroup = translation?.closest(
          ".yt2anki-answer-group"
        );
        const targetGroup = target?.closest(".yt2anki-answer-group");
        return Boolean(
          answer && translationGroup && targetGroup &&
          [...answer.children].indexOf(targetGroup) <
            [...answer.children].indexOf(translationGroup)
        );
      })()
    })`,
  );
  return value ? JSON.parse(value) : null;
}

async function videoState(endpoint) {
  return evaluateVideo(
    endpoint,
    `JSON.stringify({
    paused: document.querySelector("video")?.paused,
    ready: document.querySelector("video")?.readyState ?? 0,
    time: document.querySelector("video")?.currentTime ?? 0,
    networkState: document.querySelector("video")?.networkState,
    mediaError: document.querySelector("video")?.error?.code ?? null,
    buffered: (() => {
      const ranges = document.querySelector("video")?.buffered;
      return ranges ? Array.from({ length: ranges.length }, (_, index) => [ranges.start(index), ranges.end(index)]) : [];
    })(),
    state: document.querySelector("#movie_player")?.getPlayerState?.(),
    captions: [...document.querySelectorAll(".ytp-caption-segment")]
      .filter((node) => node.getBoundingClientRect().width && getComputedStyle(node).visibility !== "hidden")
      .map((node) => node.textContent),
    captionTrack: document.querySelector("#movie_player")?.getOption?.("captions", "track"),
    error: document.querySelector(".ytp-error-content-wrap")?.textContent ?? ""
  })`,
  );
}

async function evaluateVideo(endpoint, expression, userGesture = false) {
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
      expression,
      returnByValue: true,
      userGesture,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ??
          "YouTube evaluation failed.",
      );
    }
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
