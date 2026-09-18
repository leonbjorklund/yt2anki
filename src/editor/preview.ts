import type { Segment } from "../domain/types.ts";
import { formatRange } from "./segments.ts";

interface PreviewOptions {
  controls: HTMLElement;
  frame: HTMLIFrameElement;
  replay: HTMLButtonElement;
  time: HTMLElement;
  videoId: string;
}

export interface PreviewController {
  disable: (disabled: boolean) => void;
  play: (segment: Segment, index: number) => void;
  select: (segment: Segment, index: number) => void;
  showInitial: () => void;
}

interface PreviewPlaybackCommand {
  args: [
    {
      endSeconds: number;
      startSeconds: number;
      videoId: string;
    },
  ];
  event: "command";
  func: "loadVideoById";
}

const YOUTUBE_EMBED_ORIGIN = "https://www.youtube.com";

export function createPreviewController({
  controls,
  frame,
  replay,
  time,
  videoId,
}: PreviewOptions): PreviewController {
  let active: Segment | null = null;
  let loaded = false;
  let playbackRequested = false;
  let listeningTimer: ReturnType<typeof setInterval> | undefined;

  frame.addEventListener("load", () => {
    loaded = false;
    clearInterval(listeningTimer);
    send({ event: "listening" });
    listeningTimer = setInterval(() => send({ event: "listening" }), 250);
  });
  window.addEventListener("pagehide", () => clearInterval(listeningTimer));
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== YOUTUBE_EMBED_ORIGIN ||
      event.source !== frame.contentWindow ||
      typeof event.data !== "string"
    )
      return;
    let message: { event?: string } | null;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.event === "initialDelivery") {
      clearInterval(listeningTimer);
      for (const name of ["onReady", "onApiChange", "onStateChange"]) {
        send({ event: "command", func: "addEventListener", args: [name] });
      }
    }
    if (message?.event === "onReady") {
      loaded = true;
      if (active && playbackRequested) startPlayback(active);
    }
    if (
      message?.event === "onReady" ||
      message?.event === "onApiChange" ||
      message?.event === "onStateChange"
    ) {
      // Match the Card's captions-off request. YouTube exposes no documented
      // captions-off option; an unavailable module simply ignores the command.
      send({
        event: "command",
        func: "setOption",
        args: ["captions", "track", {}],
      });
    }
  });

  function send(message: object): void {
    frame.contentWindow?.postMessage(
      JSON.stringify({ ...message, id: frame.id, channel: "widget" }),
      YOUTUBE_EMBED_ORIGIN,
    );
  }

  replay.addEventListener("click", () => {
    if (active) {
      playbackRequested = true;
      startPlayback(active);
    }
  });

  function showInitial(): void {
    active = null;
    playbackRequested = false;
    controls.hidden = true;
    time.textContent = "";
    frame.title = "YouTube video preview";
    loaded = false;
    frame.src = previewEmbedUrl(videoId);
  }

  function select(segment: Segment, index: number): void {
    if (active !== segment) playbackRequested = false;
    active = segment;
    controls.hidden = false;
    time.textContent = formatRange(segment);
    frame.title = `Segment ${index + 1} preview`;
  }

  function play(segment: Segment, index: number): void {
    select(segment, index);
    playbackRequested = true;
    startPlayback(segment);
  }

  function startPlayback(segment: Segment): void {
    if (!loaded) {
      return;
    }
    send(previewPlaybackCommand(videoId, segment));
  }

  return {
    disable: (disabled) => {
      replay.disabled = disabled;
    },
    play,
    select,
    showInitial,
  };
}

function previewEmbedUrl(videoId: string): string {
  const params = new URLSearchParams({
    autoplay: "0",
    controls: "0",
    disablekb: "0",
    enablejsapi: "1",
    fs: "0",
    iv_load_policy: "3",
    origin: location.origin,
    playsinline: "1",
    rel: "0",
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

export function previewPlaybackCommand(
  videoId: string,
  segment: Segment,
): PreviewPlaybackCommand {
  return {
    args: [
      {
        endSeconds: Math.round(segment.endMs) / 1_000,
        startSeconds: Math.round(segment.startMs) / 1_000,
        videoId,
      },
    ],
    event: "command",
    func: "loadVideoById",
  };
}
