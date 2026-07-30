import {
  alignNativeCaptions,
  buildTargetSegments,
  mergeCaptionCues,
  parseJson3Captions,
} from "./domain/captions.ts";
import { matchManualTrack, manualTracks } from "./domain/language.ts";
import type {
  CaptionCapture,
  CaptionTrack,
  Draft,
  SourceCapture,
  SourceVideo,
} from "./domain/types.ts";
import {
  isAppMessage,
  type AppError,
  type AppMessage,
  type AppResponse,
  type GenerateMessage,
  type InspectData,
} from "./messages.ts";
import {
  getDraft,
  getSettings,
  saveDraft,
  saveSettings,
} from "./storage.ts";

const YOUTUBE_PREVIEW_PERMISSION = "https://www.youtube.com/*";

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    sendResponse: (response: AppResponse<unknown>) => void,
  ) => {
    if (!isAppMessage(message)) {
      sendResponse(failure("INVALID_REQUEST", "Unknown extension request."));
      return false;
    }

    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          error: normalizeError(error),
          ok: false,
        });
      });
    return true;
  },
);

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.includes(YOUTUBE_PREVIEW_PERMISSION)) {
    void chrome.action.openPopup().catch(() => undefined);
  }
});

async function handleMessage(
  message: AppMessage,
): Promise<AppResponse<InspectData | null>> {
  if (message.type === "inspect") {
    const video = await inspectSourceTab(message.tabId);
    const [settings, draft] = await Promise.all([
      getSettings(),
      getDraft(video.videoId),
    ]);
    return {
      data: {
        draftSegmentCount: draft?.segments.length ?? 0,
        settings,
        video,
      },
      ok: true,
    };
  }

  await generateDraft(message);
  return { data: null, ok: true };
}

async function generateDraft(message: GenerateMessage): Promise<void> {
  const video = await inspectSourceTab(message.tabId);
  const existing = await getDraft(video.videoId);
  if (existing) {
    return openEditor(video.videoId);
  }

  const tracks = manualTracks(video.tracks);
  const targetTrackCandidate = resolveTrack(
    tracks,
    message.targetLocale,
    message.targetTrackId,
    true,
  );
  if (!targetTrackCandidate) {
    throw appError(
      "NO_TARGET_TRACK",
      "No matching manual Target Language caption track is available.",
    );
  }
  const targetTrack = targetTrackCandidate;
  const nativeTrack = resolveTrack(
    tracks.filter((track) => track.id !== targetTrack.id),
    message.nativeLocale,
    message.nativeTrackId,
    false,
  );
  const trackIds = [
    targetTrack.id,
    ...(nativeTrack ? [nativeTrack.id] : []),
  ];
  const capture = await captureSourceTab(message.tabId, trackIds);
  if (capture.video.videoId !== video.videoId) {
    throw appError(
      "CAPTURE_FAILED",
      "The Source Video changed during caption capture. Try again.",
    );
  }
  const targetJson = capturedJson(capture.captions, targetTrack.id);
  const targetCaptions = mergeCaptionCues(parseJson3Captions(targetJson));

  if (targetCaptions.length === 0) {
    throw appError(
      "CAPTURE_FAILED",
      "The Target Language caption track contained no usable speech.",
    );
  }

  let segments = await buildTargetSegments({
    captions: targetCaptions,
    durationMs:
      video.durationMs ||
      Math.max(...targetCaptions.map((caption) => caption.endMs)),
    track: targetTrack,
    videoId: video.videoId,
  });

  if (nativeTrack) {
    const nativeJson = capturedJson(capture.captions, nativeTrack.id);
    segments = alignNativeCaptions(
      segments,
      mergeCaptionCues(parseJson3Captions(nativeJson)),
    );
  }

  const draft: Draft = {
    activeSegmentIdentity: segments[0]!.identity,
    nativeLocale: message.nativeLocale,
    nativeTrack,
    segments,
    sourceTabId: message.tabId,
    targetLocale: message.targetLocale,
    targetTrack,
    version: 1,
    video: capture.video,
  };

  await Promise.all([
    saveDraft(draft),
    saveSettings({
      nativeLocale: message.nativeLocale,
      targetLocale: message.targetLocale,
    }),
  ]);
  await openEditor(video.videoId);
}

function resolveTrack(
  tracks: CaptionTrack[],
  locale: string,
  selectedId: string | undefined,
  required: boolean,
): CaptionTrack | null {
  if (selectedId) {
    const selected = tracks.find((track) => track.id === selectedId);
    if (selected) {
      return selected;
    }
  }

  const match = matchManualTrack(tracks, locale);
  if (match.status === "matched") {
    return match.track;
  }
  if (match.status === "ambiguous") {
    throw appError(
      "AMBIGUOUS_TRACK",
      `Choose the manual ${required ? "Target" : "Native"} Language caption track.`,
    );
  }
  if (required) {
    throw appError(
      "NO_TARGET_TRACK",
      "No matching manual Target Language caption track is available.",
    );
  }
  return null;
}

async function inspectSourceTab(tabId: number): Promise<SourceVideo> {
  await validateTab(tabId);
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
      "YouTube player metadata could not be read.",
    );
  }
  return video;
}

async function captureSourceTab(
  tabId: number,
  trackIds: string[],
): Promise<SourceCapture> {
  await validateTab(tabId);
  await installCaptureBridge(tabId);
  const results = await chrome.scripting.executeScript({
    args: ["capture", trackIds],
    func: invokeCaptureBridge,
    target: { tabId },
    world: "MAIN",
  });
  const result = injectionResult(results[0]);
  const capture = sourceCapture(result);
  if (!capture) {
    throw appError(
      "CAPTURE_FAILED",
      "YouTube timed text could not be captured.",
    );
  }
  return capture;
}

async function invokeCaptureBridge(
  method: "capture" | "inspect",
  trackIds: string[],
): Promise<unknown> {
  const api = (
    window as Window & {
      __yt2ankiCapture?: {
        capture(ids: string[]): Promise<unknown>;
        inspect(): unknown;
      };
    }
  ).__yt2ankiCapture;
  try {
    if (!api) {
      throw new Error("Capture bridge did not initialize");
    }
    return await (method === "inspect"
      ? api.inspect()
      : api.capture(trackIds));
  } catch (error) {
    return {
      __yt2ankiCaptureError:
        error instanceof Error ? error.message : String(error),
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

async function validateTab(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw appError("TAB_UNAVAILABLE", "The Source Video tab is unavailable.");
  }

  if (!tab.active) {
    throw appError(
      "TAB_UNAVAILABLE",
      "The Source Video tab is no longer active.",
    );
  }

  if (!tab.url || !isYouTubeWatchUrl(tab.url)) {
    throw appError(
      "NOT_YOUTUBE_WATCH",
      "Open a YouTube video to continue.",
    );
  }
}

function isYouTubeWatchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.hostname === "www.youtube.com" ||
        url.hostname === "youtube.com" ||
        url.hostname === "m.youtube.com") &&
      url.pathname === "/watch" &&
      /^[A-Za-z0-9_-]{11}$/u.test(url.searchParams.get("v") ?? "")
    );
  } catch {
    return false;
  }
}

function capturedJson(
  captures: CaptionCapture[],
  trackId: string,
): unknown {
  const capture = captures.find((item) => item.trackId === trackId);
  if (!capture) {
    throw appError(
      "CAPTURE_FAILED",
      `The selected caption track was not captured: ${trackId}`,
    );
  }
  return capture.json3;
}

async function openEditor(videoId: string): Promise<void> {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      `editor/editor.html?video=${encodeURIComponent(videoId)}`,
    ),
  });
}

function appError(
  code: AppError["code"],
  message: string,
): AppError {
  return { code, message };
}

function failure(
  code: AppError["code"],
  message: string,
): AppResponse<never> {
  return { error: appError(code, message), ok: false };
}

function normalizeError(error: unknown): AppError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    return error as AppError;
  }
  return appError(
    "CAPTURE_FAILED",
    error instanceof Error
      ? error.message
      : "YouTube caption capture failed.",
  );
}

function injectionResult(
  injection: chrome.scripting.InjectionResult<unknown> | undefined,
): unknown {
  const possibleError = (
    injection as
      | (chrome.scripting.InjectionResult<unknown> & { error?: unknown })
      | undefined
  )?.error;
  if (possibleError) {
    const message =
      typeof possibleError === "string"
        ? possibleError
        : possibleError &&
            typeof possibleError === "object" &&
            "message" in possibleError
          ? String(possibleError.message)
          : "The injected YouTube capture failed.";
    throw appError("CAPTURE_FAILED", message);
  }
  const result = injection?.result;
  if (
    isRecord(result) &&
    typeof result.__yt2ankiCaptureError === "string"
  ) {
    throw appError("CAPTURE_FAILED", result.__yt2ankiCaptureError);
  }
  return result;
}

function sourceCapture(value: unknown): SourceCapture | null {
  if (!isRecord(value) || !Array.isArray(value.captions)) {
    return null;
  }
  const video = sourceVideo(value.video);
  const captions = value.captions
    .map((item): CaptionCapture | null => {
      if (
        !isRecord(item) ||
        typeof item.trackId !== "string" ||
        !isRecord(item.json3) ||
        !Array.isArray(item.json3.events)
      ) {
        return null;
      }
      return { json3: item.json3, trackId: item.trackId };
    });
  return video && captions.every((item) => item !== null)
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
  return Boolean(value) && typeof value === "object";
}
