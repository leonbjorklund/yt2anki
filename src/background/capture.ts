import { validateCapturedCues } from "../domain/capture.ts";
import { normalizeCaptionTrackKind } from "../domain/language.ts";
import type {
  CaptionCapture,
  CaptionTrack,
  SourceCapture,
  SourceVideo,
} from "../domain/types.ts";
import { appError } from "./errors.ts";

export type SourceTabPolicy = "recovery" | "toolbar-action";

export async function inspectSourceTab(
  tabId: number,
  policy: SourceTabPolicy = "toolbar-action",
): Promise<SourceVideo> {
  await validateTab(tabId, policy);
  await installCaptureBridge(tabId);
  const results = await chrome.scripting.executeScript({
    args: ["inspect", []],
    func: invokeCaptureBridge,
    target: { tabId },
    world: "MAIN",
  });
  const result = injectionResult(results[0]);
  const video = sourceVideo(result);
  if (!video) {
    throw appError(
      "CAPTURE_FAILED",
      result === undefined || result === null
        ? "YouTube player metadata could not be read because the page returned no data."
        : "YouTube player metadata could not be read.",
    );
  }
  return video;
}

export async function captureSourceTab(
  tabId: number,
  tracks: CaptionTrack[],
  policy: SourceTabPolicy = "toolbar-action",
): Promise<SourceCapture> {
  await validateTab(tabId, policy);
  await installCaptureBridge(tabId);
  const results = await chrome.scripting.executeScript({
    args: ["capture", tracks],
    func: invokeCaptureBridge,
    target: { tabId },
    world: "MAIN",
  });
  const result = injectionResult(results[0]);
  const capture = sourceCapture(result, tracks);
  if (!capture) {
    throw appError("CAPTURE_FAILED", "YouTube captions could not be captured.");
  }
  return capture;
}

export async function resolveSourceTabId(
  recordedTabId: number,
  videoId: string,
): Promise<number> {
  try {
    const recordedTab = await chrome.tabs.get(recordedTabId);
    if (youtubeVideoId(recordedTab.url) === videoId) {
      return recordedTabId;
    }
  } catch {
    // Chrome assigns new tab IDs after the guarded manual-test restart.
  }

  const matchingTab = (await chrome.tabs.query({})).find(
    (tab) => typeof tab.id === "number" && youtubeVideoId(tab.url) === videoId,
  );
  if (matchingTab?.id === undefined) {
    throw appError(
      "TAB_UNAVAILABLE",
      "Reopen the Source Video before exporting.",
    );
  }
  return matchingTab.id;
}

export function capturedCaptions(
  captures: CaptionCapture[],
  trackId: string,
): CaptionCapture {
  const capture = captures.find((item) => item.trackId === trackId);
  if (!capture) {
    throw appError(
      "CAPTURE_FAILED",
      `The selected caption track was not captured: ${trackId}`,
    );
  }
  return capture;
}

async function invokeCaptureBridge(
  method: "capture" | "inspect",
  tracks: CaptionTrack[],
): Promise<unknown> {
  const api = (
    window as Window & {
      __yt2ankiCapture?: {
        capture(requestedTracks: CaptionTrack[]): Promise<unknown>;
        inspect(): unknown;
      };
    }
  ).__yt2ankiCapture;
  try {
    if (!api) {
      throw new Error("Capture bridge did not initialize");
    }
    return await (method === "inspect" ? api.inspect() : api.capture(tracks));
  } catch (error) {
    const possibleCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return {
      __yt2ankiCaptureError: {
        code:
          possibleCode === "CAPTION_RATE_LIMITED"
            ? "CAPTION_RATE_LIMITED"
            : "CAPTURE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function installCaptureBridge(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    files: ["capture-main.js"],
    target: { tabId },
    world: "MAIN",
  });
}

async function validateTab(
  tabId: number,
  policy: SourceTabPolicy,
): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw appError("TAB_UNAVAILABLE", "The Source Video tab is unavailable.");
  }

  if (policy === "toolbar-action" && !tab.active) {
    throw appError(
      "TAB_UNAVAILABLE",
      "The Source Video tab is no longer active.",
    );
  }

  if (youtubeVideoId(tab.url) === null) {
    throw appError("NOT_YOUTUBE_WATCH", "Open a YouTube video to continue.");
  }
}

function youtubeVideoId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const videoId = url.searchParams.get("v") ?? "";
    return (url.hostname === "www.youtube.com" ||
      url.hostname === "youtube.com" ||
      url.hostname === "m.youtube.com") &&
      url.pathname === "/watch" &&
      /^[A-Za-z0-9_-]{11}$/u.test(videoId)
      ? videoId
      : null;
  } catch {
    return null;
  }
}

function injectionResult(
  injection: chrome.scripting.InjectionResult<unknown> | undefined,
): unknown {
  const result = injection?.result;
  if (isRecord(result) && isRecord(result.__yt2ankiCaptureError)) {
    const captureError = result.__yt2ankiCaptureError;
    const code =
      captureError.code === "CAPTION_RATE_LIMITED"
        ? "CAPTION_RATE_LIMITED"
        : "CAPTURE_FAILED";
    throw appError(
      code,
      typeof captureError.message === "string"
        ? captureError.message
        : "YouTube caption capture failed.",
    );
  }
  return result;
}

function sourceCapture(
  value: unknown,
  requestedTracks: CaptionTrack[],
): SourceCapture | null {
  if (!isRecord(value) || !Array.isArray(value.captions)) {
    return null;
  }
  const video = sourceVideo(value.video);
  if (!video || value.captions.length !== requestedTracks.length) {
    return null;
  }
  const seenTrackIds = new Set<string>();
  const captions = value.captions.map((item): CaptionCapture | null => {
    if (!isRecord(item) || typeof item.trackId !== "string") {
      return null;
    }
    const normalizedCues = validateCapturedCues(item.captions, {
      durationMs: video.durationMs,
    });
    if (
      !requestedTracks.some(
        (expected) =>
          expected.id === item.trackId &&
          video.tracks.some(
            (track) =>
              track.id === expected.id &&
              track.languageCode === expected.languageCode &&
              normalizeCaptionTrackKind(track.kind) ===
                normalizeCaptionTrackKind(expected.kind),
          ),
      ) ||
      seenTrackIds.has(item.trackId) ||
      !normalizedCues
    ) {
      return null;
    }
    seenTrackIds.add(item.trackId);
    return {
      captions: normalizedCues,
      trackId: item.trackId,
    };
  });
  return captions.every((item) => item !== null)
    ? { captions: captions as CaptionCapture[], video }
    : null;
}

function sourceVideo(value: unknown): SourceVideo | null {
  if (!isRecord(value) || !isRecord(value.compatibility)) {
    return null;
  }
  const compatibility = value.compatibility;
  const tracks = Array.isArray(value.tracks)
    ? value.tracks.map(captionTrack)
    : [];
  if (
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.videoId !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/u.test(value.videoId) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !Array.isArray(value.tracks) ||
    tracks.some((track) => track === null) ||
    ![
      compatibility.embeddable,
      compatibility.hasOpus,
      compatibility.hasVp9,
    ].every((item) => typeof item === "boolean")
  ) {
    return null;
  }
  return {
    compatibility: {
      embeddable: compatibility.embeddable as boolean,
      hasOpus: compatibility.hasOpus as boolean,
      hasVp9: compatibility.hasVp9 as boolean,
    },
    durationMs: value.durationMs,
    title: value.title,
    tracks: tracks as CaptionTrack[],
    videoId: value.videoId,
  };
}

function captionTrack(value: unknown): CaptionTrack | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.languageCode !== "string" ||
    !value.languageCode ||
    typeof value.name !== "string" ||
    (value.kind !== null && typeof value.kind !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    languageCode: value.languageCode,
    name: value.name,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
