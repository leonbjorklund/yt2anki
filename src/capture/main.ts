import type {
  CaptionCapture,
  CaptionTrack,
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

interface YouTubePlayer extends HTMLElement {
  getOption?: (namespace: string, option: string) => unknown;
  getOptions?: () => string[];
  getPlayerResponse?: () => unknown;
  loadModule?: (name: string) => void;
  setOption?: (namespace: string, option: string, value: unknown) => void;
  unloadModule?: (name: string) => void;
}

interface CaptureApi {
  capture(trackIds: string[]): Promise<SourceCapture>;
  inspect(): SourceVideo;
}

declare global {
  interface Window {
    __yt2ankiCapture?: CaptureApi;
    ytInitialPlayerResponse?: unknown;
    ytInitialData?: unknown;
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
    string(details.videoId) || new URL(location.href).searchParams.get("v") || "";

  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    throw new Error("This is not a supported YouTube watch page");
  }

  return {
    compatibility: {
      embeddable:
        playability.playableInEmbed === true && status === "OK",
      hasOpus: formats.some((format) =>
        /audio\/webm[^;]*;\s*codecs="[^"]*opus/iu.test(string(format.mimeType)),
      ),
      hasVp9: formats.some((format) =>
        /video\/webm[^;]*;\s*codecs="[^"]*(?:vp9|vp09)/iu.test(
          string(format.mimeType),
        ),
      ),
    },
    durationMs: Math.max(
      0,
      Math.round(Number(string(details.lengthSeconds) || 0) * 1_000),
    ),
    title: string(details.title) || document.title.replace(/\s+- YouTube$/u, ""),
    tracks: captionTracks(response).map(({ summary }) => summary),
    videoId,
  };
}

async function capture(trackIds: string[]): Promise<SourceCapture> {
  if (
    !Array.isArray(trackIds) ||
    trackIds.length === 0 ||
    trackIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("At least one caption track is required");
  }

  const video = inspect();
  const player = getPlayer();
  const available = captionTracks(playerResponse());
  const requested = trackIds.map((id) => {
    const track = available.find(({ summary }) => summary.id === id);
    if (!track || track.summary.kind?.toLowerCase() === "asr") {
      throw new Error(`Manual caption track is unavailable: ${id}`);
    }
    return track;
  });

  const namespaces = safeCall(() => player.getOptions?.(), []);
  const captionsWereLoaded =
    Array.isArray(namespaces) && namespaces.includes("captions");
  const originalTrack = safeCall(
    () => player.getOption?.("captions", "track"),
    null,
  );
  const captures: CaptionCapture[] = [];

  try {
    player.loadModule?.("captions");
    for (const track of requested) {
      captures.push({
        json3: await captureTrack(
          player,
          track.raw,
          video.durationMs,
        ),
        trackId: track.summary.id,
      });
    }
  } finally {
    try {
      player.setOption?.(
        "captions",
        "track",
        originalTrack && typeof originalTrack === "object" ? originalTrack : {},
      );
      if (!captionsWereLoaded) {
        player.unloadModule?.("captions");
      }
    } catch {
      // Capture restoration is best-effort after the original state is saved.
    }
  }

  return { captions: captures, video };
}

async function captureTrack(
  player: YouTubePlayer,
  track: RawCaptionTrack,
  durationMs: number,
): Promise<unknown> {
  const languageCode = string(track.languageCode);
  const interceptor = interceptTimedText(languageCode);

  try {
    const current = safeCall(
      () => player.getOption?.("captions", "track"),
      null,
    );
    if (record(current).vssId === track.vssId) {
      player.setOption?.("captions", "track", {});
      await delay(100);
    }

    player.setOption?.("captions", "track", track);
    await delay(100);

    const transcriptPanel = await fetchTranscriptPanelJson3(
      languageCode,
      durationMs,
    );
    if (transcriptPanel) {
      return transcriptPanel;
    }

    const playerResult = await Promise.race([
      interceptor.result,
      delay(3_000).then(() => null),
    ]);
    if (playerResult) {
      return playerResult;
    }

    const direct = await fetchJson3(string(track.baseUrl));
    if (direct) {
      return direct;
    }

    const lateResult = await Promise.race([
      interceptor.result,
      delay(5_000).then(() => null),
    ]);
    if (lateResult) {
      return lateResult;
    }
    throw new Error(`Timed-text response was not captured for ${languageCode}`);
  } finally {
    interceptor.restore();
  }
}

async function fetchTranscriptPanelJson3(
  languageCode: string,
  durationMs: number,
): Promise<unknown | null> {
  const config = findTranscriptPanelConfig(window.ytInitialData);
  const ytcfg = window.ytcfg;
  if (!config || !ytcfg) {
    return null;
  }

  const apiKey = string(safeCall(() => ytcfg.get("INNERTUBE_API_KEY"), ""));
  const rawContext = safeCall(
    () => ytcfg.get("INNERTUBE_CONTEXT"),
    null,
  );
  if (!apiKey || !isRecord(rawContext)) {
    return null;
  }

  try {
    const context = structuredClone(rawContext);
    const client = record(context.client);
    client.hl = languageCode;
    context.client = client;
    const clientName = safeCall(
      () => ytcfg.get("INNERTUBE_CONTEXT_CLIENT_NAME"),
      "",
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (clientName !== "") {
      headers["X-YouTube-Client-Name"] = String(clientName);
    }
    if (typeof client.clientVersion === "string") {
      headers["X-YouTube-Client-Version"] = client.clientVersion;
    }
    if (typeof client.visitorData === "string") {
      headers["X-Goog-Visitor-Id"] = client.visitorData;
    }

    const response = await fetch(
      `/youtubei/v1/get_panel?prettyPrint=false&key=${encodeURIComponent(apiKey)}`,
      {
        body: JSON.stringify({
          context,
          panelId: config.panelId,
          params: config.params,
        }),
        credentials: "same-origin",
        headers,
        method: "POST",
      },
    );
    if (!response.ok) {
      return null;
    }
    return transcriptPanelToJson3(await response.json(), durationMs);
  } catch {
    return null;
  }
}

function findTranscriptPanelConfig(value: unknown): {
  panelId: string;
  params: string;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const stack: unknown[] = [value];
  const visited = new Set<unknown>();
  let inspected = 0;

  while (stack.length > 0 && inspected < 20_000) {
    const current = stack.pop();
    if (!isRecord(current) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    inspected += 1;

    const endpoint = record(current.showEngagementPanelEndpoint);
    const configuration = record(endpoint.globalConfiguration);
    const identifier = record(endpoint.identifier);
    const params = string(configuration.params);
    const panelId = string(identifier.tag);
    if (params && panelId === "PAmodern_transcript_view") {
      return { panelId, params };
    }
    stack.push(...Object.values(current));
  }
  return null;
}

function transcriptPanelToJson3(
  value: unknown,
  durationMs: number,
): unknown | null {
  const content = record(record(value).content);
  const panel = record(content.engagementPanelSectionListRenderer);
  const sectionList = record(record(panel.content).sectionListRenderer);
  const items = array(sectionList.contents).flatMap((section) =>
    array(record(record(section).itemSectionRenderer).contents),
  );
  const entries = items
    .map((item) => {
      const marker = record(record(item).macroMarkersPanelItemViewModel);
      const timeline = record(record(marker.item).timelineItemViewModel);
      const segment = array(timeline.contentItems)
        .map(record)
        .map((contentItem) =>
          record(contentItem.transcriptSegmentViewModel),
        )
        .find((candidate) => string(candidate.simpleText));
      const endpoint = record(
        record(record(marker.onTap).innertubeCommand).watchEndpoint,
      );
      const seconds =
        typeof endpoint.startTimeSeconds === "number"
          ? endpoint.startTimeSeconds
          : Number.NaN;
      return {
        fallbackStartMs: Number.isFinite(seconds)
          ? Math.round(seconds * 1_000)
          : Number.NaN,
        text: segment ? string(segment.simpleText) : "",
      };
    })
    .filter((entry) => entry.text);
  if (entries.length === 0) {
    return null;
  }

  const syncedTimes = transcriptPanelTimes(value);
  const starts =
    syncedTimes.length === entries.length
      ? syncedTimes
      : entries.map((entry) => entry.fallbackStartMs);
  if (starts.some((start) => !Number.isFinite(start))) {
    return null;
  }

  return {
    events: entries.map((entry, index) => {
      const startMs = starts[index]!;
      const nextStart = starts[index + 1];
      const endMs = Math.max(
        startMs + 1,
        Math.min(
          nextStart ?? startMs + 2_000,
          startMs + 10_000,
          durationMs > startMs ? durationMs : startMs + 2_000,
        ),
      );
      return {
        dDurationMs: Math.max(1, endMs - startMs),
        segs: [{ utf8: entry.text }],
        tStartMs: startMs,
      };
    }),
  };
}

function transcriptPanelTimes(value: unknown): number[] {
  const framework = record(record(value).frameworkUpdates);
  const update = record(framework.entityBatchUpdate);
  for (const mutation of array(update.mutations).map(record)) {
    const entity = record(
      record(mutation.payload).timedMarkersListSyncEntity,
    );
    const timedList = record(entity.timedListData);
    const times = array(timedList.sections).flatMap((section) =>
      array(record(section).timedSyncDataList)
        .map(record)
        .map((item) => {
          const value = item.videoTimeMs;
          return typeof value === "number" ||
            (typeof value === "string" && value.trim() !== "")
            ? Number(value)
            : Number.NaN;
        })
        .filter(Number.isFinite),
    );
    if (times.length > 0) {
      return times;
    }
  }
  return [];
}

function interceptTimedText(languageCode: string): {
  restore(): void;
  result: Promise<unknown>;
} {
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap<XMLHttpRequest, string>();
  let resolveResult: (value: unknown) => void = () => {};
  let settled = false;
  const result = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });

  const accept = (url: string, body: string) => {
    if (settled || !isMatchingTimedText(url, languageCode)) {
      return;
    }
    const parsed = parseJson3(body);
    if (parsed) {
      settled = true;
      resolveResult(parsed);
    }
  };

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch.call(this, input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (isMatchingTimedText(url, languageCode)) {
      void response
        .clone()
        .text()
        .then((body) => accept(url, body))
        .catch(() => undefined);
    }
    return response;
  };

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    requestUrls.set(this, String(url));
    originalOpen.call(
      this,
      method,
      String(url),
      async ?? true,
      username ?? null,
      password ?? null,
    );
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    this.addEventListener(
      "load",
      () => {
        const url = requestUrls.get(this) ?? this.responseURL;
        if (!isMatchingTimedText(url, languageCode)) {
          return;
        }
        try {
          const text =
            typeof this.responseText === "string"
              ? this.responseText
              : JSON.stringify(this.response);
          accept(url, text);
        } catch {
          // Reading responseText can fail for non-text response types.
        }
      },
      { once: true },
    );
    originalSend.call(this, body);
  };

  return {
    restore() {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    },
    result,
  };
}

async function fetchJson3(baseUrl: string): Promise<unknown | null> {
  if (!baseUrl) {
    return null;
  }
  try {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set("fmt", "json3");
    const response = await fetch(url, {
      credentials: "include",
    });
    return response.ok ? parseJson3(await response.text()) : null;
  } catch {
    return null;
  }
}

function parseJson3(body: string): unknown | null {
  const cleaned = body.replace(/^\)\]\}'\s*/u, "").trim();
  if (!cleaned) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isRecord(parsed) && Array.isArray(parsed.events) ? parsed : null;
  } catch {
    return null;
  }
}

function isMatchingTimedText(url: string, languageCode: string): boolean {
  if (!/\/api\/timedtext|[?&]fmt=json3/iu.test(url)) {
    return false;
  }
  try {
    const requestedLanguage = new URL(url, location.origin).searchParams.get("lang");
    return !requestedLanguage || requestedLanguage === languageCode;
  } catch {
    return true;
  }
}

function captionTracks(response: Record<string, unknown>): Array<{
  raw: RawCaptionTrack;
  summary: CaptionTrack;
}> {
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
  const player = document.getElementById("movie_player") as YouTubePlayer | null;
  if (!player?.getPlayerResponse || !player.setOption) {
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
  return Boolean(value) && typeof value === "object";
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback() ?? fallback;
  } catch {
    return fallback;
  }
}

function delay(milliseconds: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), milliseconds);
  });
}
