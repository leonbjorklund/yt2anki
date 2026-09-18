import { parseJson3Captions } from "../domain/captions.ts";
import {
  CAPTURE_END_TOLERANCE_MS,
  CAPTURE_RATE_LIMIT_MESSAGE,
  validateCapturedCues,
} from "../domain/capture.ts";
import { normalizeCaptionTrackKind } from "../domain/language.ts";
import type {
  CaptionCapture,
  CaptionCue,
  CaptionTrack,
  PreciseCaptionPayload,
  SourceCapture,
  SourceVideo,
} from "../domain/types.ts";

interface RawCaptionTrack {
  baseUrl?: unknown;
  kind?: unknown;
  languageCode?: unknown;
  name?: unknown;
  vssId?: unknown;
}

interface AvailableCaptionTrack {
  raw: RawCaptionTrack;
  summary: CaptionTrack;
}

interface YouTubePlayer extends HTMLElement {
  getPlayerResponse?: () => unknown;
}

interface CaptureApi {
  capture(tracks: CaptionTrackIdentity[]): Promise<SourceCapture>;
  inspect(): SourceVideo;
}

type CaptionTrackIdentity = Pick<CaptionTrack, "id" | "kind" | "languageCode">;

interface CaptionCache {
  captions: Record<string, CaptionCue[]>;
  videoId: string;
  version: 2;
}

const CAPTURE_LISTENERS_VERSION = 1;
const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_TIMED_TEXT_BYTES = 5_000_000;
// Treat this private compatibility profile as one unit and rerun the live
// caption gate before changing any field.
const YOUTUBE_CAPTION_CLIENT = {
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  name: "VISIONOS",
  number: "101",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  version: "1.02",
} as const;

declare global {
  interface Window {
    __yt2ankiCaptionCache?: CaptionCache;
    __yt2ankiCapture?: CaptureApi;
    __yt2ankiCaptureListeners?: number;
    ytInitialPlayerResponse?: unknown;
    ytcfg?: {
      get(key: string): unknown;
    };
    ytplayer?: {
      config?: {
        args?: {
          raw_player_response?: unknown;
        };
      };
    };
  }
}

// Keyed by version, not by the bridge object: re-injecting an updated bundle
// into a tab that still holds an older bridge must still install the listeners.
if (window.__yt2ankiCaptureListeners !== CAPTURE_LISTENERS_VERSION) {
  window.__yt2ankiCaptureListeners = CAPTURE_LISTENERS_VERSION;
  window.navigation.addEventListener("currententrychange", () => {
    const cache = window.__yt2ankiCaptionCache;
    const url = new URL(location.href);
    if (
      cache &&
      (url.pathname !== "/watch" || url.searchParams.get("v") !== cache.videoId)
    ) {
      delete window.__yt2ankiCaptionCache;
    }
  });
  window.addEventListener("pagehide", () => {
    delete window.__yt2ankiCaptionCache;
  });
}

window.__yt2ankiCapture = {
  capture,
  inspect,
};

function inspect(): SourceVideo {
  const response = playerResponse();
  const details = record(response.videoDetails);
  const playability = record(response.playabilityStatus);
  const streaming = record(response.streamingData);
  const formats = [
    ...array(streaming.formats),
    ...array(streaming.adaptiveFormats),
  ].map(record);
  const status =
    typeof playability.status === "string" ? playability.status : "";
  const videoId =
    string(details.videoId) ||
    new URL(location.href).searchParams.get("v") ||
    "";

  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    throw new Error("This is not a supported YouTube watch page");
  }

  return {
    compatibility: {
      embeddable: playability.playableInEmbed === true && status === "OK",
      hasOpus: formats.some((format) =>
        /audio\/webm[^;]*;\s*codecs="[^"]*opus/iu.test(string(format.mimeType)),
      ),
      hasVp9: formats.some((format) =>
        /video\/webm[^;]*;\s*codecs="[^"]*(?:vp9|vp09)/iu.test(
          string(format.mimeType),
        ),
      ),
    },
    durationMs: durationMs(details.lengthSeconds),
    title:
      string(details.title) || document.title.replace(/\s+- YouTube$/u, ""),
    tracks: captionTracks(response)
      .filter(isSupportedCaptionTrack)
      .map(({ summary }) => summary),
    videoId,
  };
}

function durationMs(lengthSeconds: unknown): number {
  const seconds = Number(string(lengthSeconds));
  return Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1_000))
    : 0;
}

async function capture(
  trackIdentities: CaptionTrackIdentity[],
): Promise<SourceCapture> {
  if (
    !Array.isArray(trackIdentities) ||
    trackIdentities.length === 0 ||
    trackIdentities.some(
      (track) =>
        !track ||
        typeof track !== "object" ||
        typeof track.id !== "string" ||
        !track.id.trim() ||
        typeof track.languageCode !== "string" ||
        !track.languageCode.trim() ||
        (track.kind != null && typeof track.kind !== "string"),
    ) ||
    new Set(trackIdentities.map((track) => track.id)).size !==
      trackIdentities.length
  ) {
    throw new Error("Distinct supported Caption Track identities are required");
  }

  const video = inspect();
  const available = captionTracks(playerResponse()).filter(
    isSupportedCaptionTrack,
  );
  const requested = trackIdentities.map((expected) => {
    const track = available.find(
      ({ summary }) =>
        summary.id === expected.id &&
        summary.languageCode === expected.languageCode &&
        normalizeCaptionTrackKind(summary.kind) ===
          normalizeCaptionTrackKind(expected.kind),
    );
    if (!track) {
      throw new Error(`Supported Caption Track changed: ${expected.id}`);
    }
    return track;
  });
  const cache = captionCache(video.videoId);
  for (const { summary } of requested) {
    const key = captionCacheKey(summary);
    const cached = validateCapturedCues(cache.captions[key], {
      durationMs: video.durationMs,
    });
    if (cached) {
      cache.captions[key] = cached;
    } else {
      delete cache.captions[key];
    }
  }
  const allCached = requested.every(
    ({ summary }) => cache.captions[captionCacheKey(summary)],
  );
  const freshResponse = allCached
    ? null
    : await freshPlayerResponse(video.videoId);
  const freshTracks = freshResponse
    ? captionTracks(freshResponse).filter(isSupportedCaptionTrack)
    : [];
  const captures: CaptionCapture[] = [];
  const stagedCaptures: Record<string, CaptionCue[]> = {};

  for (const selected of requested) {
    const cacheKey = captionCacheKey(selected.summary);
    let captions = cache.captions[cacheKey];
    if (!captions) {
      const matches = freshTracks.filter(
        ({ summary }) =>
          summary.id === selected.summary.id &&
          summary.languageCode === selected.summary.languageCode &&
          normalizeCaptionTrackKind(summary.kind) ===
            normalizeCaptionTrackKind(selected.summary.kind),
      );
      const fresh = matches[0];
      if (matches.length !== 1 || !fresh) {
        throw new Error(
          `Fresh caption metadata did not contain the selected track: ${selected.summary.name}`,
        );
      }
      const fetched = await fetchCaptionTrack(
        fresh.raw,
        video.durationMs,
        video.videoId,
      );
      if (!fetched) {
        throw new Error(
          `Precise captions are unavailable for ${selected.summary.name}`,
        );
      }
      captions = fetched;
      stagedCaptures[cacheKey] = captions;
    }
    assertCurrentTracks(video.videoId, [selected.summary]);
    captures.push({ captions, trackId: selected.summary.id });
  }

  const currentVideo = assertCurrentTracks(
    video.videoId,
    requested.map(({ summary }) => summary),
  );
  Object.assign(cache.captions, stagedCaptures);
  return {
    captions: captures,
    video: currentVideo,
  };
}

async function fetchCaptionTrack(
  track: RawCaptionTrack,
  durationMs: number,
  videoId: string,
): Promise<CaptionCue[] | null> {
  if (!validRawTimedTextUrl(track, videoId)) {
    return null;
  }
  const url = new URL(string(track.baseUrl));
  const requiresPoToken = url.searchParams
    .getAll("exp")
    .some((experiment) => experiment === "xpe" || experiment === "xpv");
  if (requiresPoToken && !url.searchParams.get("pot")) {
    return null;
  }
  url.searchParams.set("fmt", "json3");
  url.searchParams.delete("xosf");
  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    throwIfRateLimited(response);
    if (!response.ok) {
      return null;
    }
    const json3 = parseJson3(await boundedResponseText(response), durationMs);
    if (!json3) {
      return null;
    }
    const captions = parseJson3Captions(json3);
    return validateCapturedCues(captions, { durationMs });
  } catch (error) {
    if (isRateLimitError(error)) {
      throw error;
    }
    return null;
  }
}

async function freshPlayerResponse(
  videoId: string,
): Promise<Record<string, unknown>> {
  const ytcfg = window.ytcfg;
  const pageContext = record(
    safeCall(() => ytcfg?.get("INNERTUBE_CONTEXT"), null),
  );
  const pageClient = record(pageContext.client);
  const visitorData = string(pageClient.visitorData);
  const context = {
    client: {
      clientName: YOUTUBE_CAPTION_CLIENT.name,
      clientVersion: YOUTUBE_CAPTION_CLIENT.version,
      deviceMake: YOUTUBE_CAPTION_CLIENT.deviceMake,
      deviceModel: YOUTUBE_CAPTION_CLIENT.deviceModel,
      hl:
        string(pageClient.hl) ||
        document.documentElement.lang ||
        navigator.language ||
        "en",
      osName: YOUTUBE_CAPTION_CLIENT.osName,
      osVersion: YOUTUBE_CAPTION_CLIENT.osVersion,
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      ...(visitorData ? { visitorData } : {}),
    },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-YouTube-Client-Name": YOUTUBE_CAPTION_CLIENT.number,
    "X-YouTube-Client-Version": YOUTUBE_CAPTION_CLIENT.version,
  };
  if (visitorData) {
    headers["X-Goog-Visitor-Id"] = visitorData;
  }

  try {
    const response = await fetch("/youtubei/v1/player?prettyPrint=false", {
      body: JSON.stringify({
        contentCheckOk: true,
        context,
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
          },
        },
        racyCheckOk: true,
        videoId,
      }),
      credentials: "omit",
      headers,
      method: "POST",
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    throwIfRateLimited(response);
    const parsed = response.ok
      ? parseObject(await boundedResponseText(response))
      : null;
    if (
      !parsed ||
      string(record(parsed.playabilityStatus).status) !== "OK" ||
      string(record(parsed.videoDetails).videoId) !== videoId
    ) {
      throw new Error("Fresh YouTube caption metadata is unavailable");
    }
    return parsed;
  } catch (error) {
    if (isRateLimitError(error)) {
      throw error;
    }
    throw new Error("Fresh YouTube caption metadata is unavailable");
  }
}

function assertCurrentTracks(
  videoId: string,
  expectedTracks: CaptionTrack[],
): SourceVideo {
  const currentVideo = inspect();
  if (currentVideo.videoId !== videoId) {
    throw new Error("The Source Video changed during caption capture");
  }
  for (const expected of expectedTracks) {
    const matches = currentVideo.tracks.filter(
      (track) =>
        track.id === expected.id &&
        track.languageCode === expected.languageCode &&
        normalizeCaptionTrackKind(track.kind) ===
          normalizeCaptionTrackKind(expected.kind),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Supported Caption Track changed during capture: ${expected.id}`,
      );
    }
  }
  return currentVideo;
}

function captionCache(videoId: string): CaptionCache {
  if (
    window.__yt2ankiCaptionCache?.videoId !== videoId ||
    window.__yt2ankiCaptionCache.version !== 2
  ) {
    window.__yt2ankiCaptionCache = { captions: {}, videoId, version: 2 };
  }
  return window.__yt2ankiCaptionCache;
}

function captionCacheKey(track: CaptionTrackIdentity): string {
  return JSON.stringify([
    track.id,
    track.languageCode,
    normalizeCaptionTrackKind(track.kind),
  ]);
}

function throwIfRateLimited(response: Response): void {
  if (response.status === 429) {
    throw Object.assign(new Error(CAPTURE_RATE_LIMIT_MESSAGE), {
      code: "CAPTION_RATE_LIMITED" as const,
    });
  }
}

function isRateLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CAPTION_RATE_LIMITED"
  );
}

function validRawTimedTextUrl(
  track: RawCaptionTrack,
  videoId: string,
): boolean {
  try {
    const url = new URL(string(track.baseUrl));
    const languageCode = string(track.languageCode);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.youtube.com" &&
      url.pathname === "/api/timedtext" &&
      url.searchParams.get("v") === videoId &&
      url.searchParams.get("lang") === languageCode &&
      ["", "standard"].includes(
        url.searchParams.get("kind")?.trim().toLowerCase() ?? "",
      ) &&
      !url.searchParams.has("tlang")
    );
  } catch {
    return false;
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_TIMED_TEXT_BYTES
  ) {
    return "";
  }
  if (!response.body) {
    return "";
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let body = "";
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return body + decoder.decode();
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_TIMED_TEXT_BYTES) {
      await reader.cancel();
      return "";
    }
    body += decoder.decode(value, { stream: true });
  }
}

function parseObject(body: string): Record<string, unknown> | null {
  const cleaned = body.replace(/^\)\]\}'\s*/u, "").trim();
  if (!cleaned) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJson3(
  body: string,
  durationMs: number,
): PreciseCaptionPayload | null {
  const parsed = parseObject(body);
  if (!parsed || !Array.isArray(parsed.events)) {
    return null;
  }
  const events = [] as PreciseCaptionPayload["events"];
  for (const rawEvent of parsed.events) {
    const event = record(rawEvent);
    const rawSegments = array(event.segs);
    if (rawSegments.length === 0) {
      continue;
    }
    const segments = rawSegments.map(record);
    if (segments.some((segment) => typeof segment.utf8 !== "string")) {
      return null;
    }
    const text = segments.map((segment) => string(segment.utf8)).join("");
    if (!text.trim()) {
      continue;
    }
    const startMs = event.tStartMs;
    const eventDurationMs = event.dDurationMs;
    if (
      (event.aAppend !== undefined && event.aAppend !== 1) ||
      typeof startMs !== "number" ||
      !Number.isFinite(startMs) ||
      startMs < 0 ||
      typeof eventDurationMs !== "number" ||
      !Number.isFinite(eventDurationMs) ||
      eventDurationMs <= 0 ||
      (durationMs > 0 &&
        startMs + eventDurationMs > durationMs + CAPTURE_END_TOLERANCE_MS)
    ) {
      return null;
    }
    events.push({
      ...(event.aAppend === 1 ? { aAppend: 1 as const } : {}),
      dDurationMs: eventDurationMs,
      segs: segments.map((segment) => ({ utf8: string(segment.utf8) })),
      tStartMs: startMs,
    });
  }
  return events.length > 0 ? { events } : null;
}

function captionTracks(
  response: Record<string, unknown>,
): AvailableCaptionTrack[] {
  const captions = record(response.captions);
  const renderer = record(captions.playerCaptionsTracklistRenderer);
  return array(renderer.captionTracks)
    .map(record)
    .map((track) => {
      const languageCode = string(track.languageCode);
      const kind = string(track.kind) || null;
      const id = string(track.vssId);
      return {
        raw: track,
        summary: {
          id,
          kind,
          languageCode,
          name: captionTrackName(track.name) || languageCode,
        },
      };
    })
    .filter(({ summary }) => Boolean(summary.id && summary.languageCode));
}

function isSupportedCaptionTrack(track: {
  raw: RawCaptionTrack;
  summary: CaptionTrack;
}): boolean {
  if (
    track.raw.kind !== undefined &&
    track.raw.kind !== null &&
    typeof track.raw.kind !== "string"
  ) {
    return false;
  }
  const metadataKind = track.summary.kind?.trim().toLowerCase() ?? "";
  if (metadataKind !== "" && metadataKind !== "standard") {
    return false;
  }
  const baseUrl = string(track.raw.baseUrl);
  if (!baseUrl) {
    return false;
  }
  try {
    const parameters = new URL(baseUrl, location.origin).searchParams;
    const urlKind = parameters.get("kind")?.trim().toLowerCase() ?? "";
    return (
      (urlKind === "" || urlKind === "standard") && !parameters.has("tlang")
    );
  } catch {
    return false;
  }
}

function captionTrackName(value: unknown): string {
  const name = record(value);
  if (typeof name.simpleText === "string") {
    return name.simpleText;
  }
  return array(name.runs)
    .map(record)
    .map((run) => string(run.text))
    .join("");
}

function playerResponse(): Record<string, unknown> {
  const player = getPlayer();
  const videoId = new URL(location.href).searchParams.get("v");
  const candidates: unknown[] = [
    safeCall(() => player.getPlayerResponse?.(), null),
    window.ytInitialPlayerResponse,
    window.ytplayer?.config?.args?.raw_player_response,
  ];

  for (const candidate of candidates) {
    const parsed =
      typeof candidate === "string"
        ? safeCall(() => JSON.parse(candidate) as unknown, null)
        : candidate;
    const response = record(parsed);
    const details = record(response.videoDetails);
    if (videoId && string(details.videoId) === videoId) {
      return response;
    }
  }
  throw new Error("The active Source Video player response is unavailable");
}

function getPlayer(): YouTubePlayer {
  const player = document.getElementById(
    "movie_player",
  ) as YouTubePlayer | null;
  if (!player?.getPlayerResponse) {
    throw new Error("The active YouTube player is unavailable");
  }
  return player;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback() ?? fallback;
  } catch {
    return fallback;
  }
}
