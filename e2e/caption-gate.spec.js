import { mergeAgreedCaptionContinuations } from "../src/domain/captions.ts";
import { normalizeCaptionTrackKind } from "../src/domain/language.ts";
import {
  expect,
  extensionMessage,
  extensionStorage,
  test,
} from "./fixtures.js";
import {
  assertPlayerStatePreserved,
  readPlayerState,
  waitForPlayerReady,
} from "./player-state.js";

const PEPPA_FIXTURE = {
  expectedSegmentCount: 93,
  expectedTargetCount: 97,
  expectedTranslationCount: 97,
  target: ["zh-Hans", "zh-CN", "zh"],
  translation: ["en-GB", "en"],
  videoId: "APv9hfjYRY0",
};

const SESSIONS = [
  [
    {
      expectedTargetCount: 319,
      target: ["zh", "zh-Hans", "zh-CN"],
      videoId: "boMXFNybOXY",
    },
    PEPPA_FIXTURE,
    { expectedTargetCount: 177, target: ["ja"], videoId: "lXcXkOa5LAU" },
    {
      expectedTargetCount: 696,
      expectedTranslationCount: 696,
      target: ["ja"],
      translation: ["en"],
      videoId: "vB-cLybOu-4",
    },
  ],
  [
    PEPPA_FIXTURE,
    {
      expectedTargetCount: 154,
      expectedTranslationCount: 154,
      target: ["ja"],
      translation: ["en"],
      videoId: "rUA0Ll5lbAs",
    },
    {
      expectedTargetCount: 235,
      expectedTranslationCount: 236,
      target: ["en"],
      translation: ["zh-CN", "zh-Hans", "zh"],
      videoId: "BHY0FxzoKZE",
    },
    {
      expectedTargetCount: 203,
      expectedTranslationCount: 137,
      target: ["en"],
      translation: ["ja"],
      videoId: "n3Xv_g3g-mA",
    },
  ],
  [
    PEPPA_FIXTURE,
    {
      expectedTargetCount: 286,
      expectedTranslationCount: 303,
      target: ["en"],
      translation: ["fr"],
      videoId: "arj7oStGLkU",
    },
    {
      expectedTargetCount: 425,
      expectedTranslationCount: 422,
      target: ["en"],
      translation: ["es"],
      videoId: "Ks-_Mh1QhMc",
    },
    {
      expectedTargetCount: 244,
      expectedTranslationCount: 244,
      target: ["en"],
      translation: ["es"],
      videoId: "UF8uR6Z6KLc",
    },
  ],
];

const requestedVideoId = process.env.CAPTION_GATE_VIDEO;
if (
  requestedVideoId &&
  !SESSIONS.flat().some(({ videoId }) => videoId === requestedVideoId)
) {
  throw new Error(
    `CAPTION_GATE_VIDEO does not match a gate fixture: ${requestedVideoId}`,
  );
}

test.describe("caption capture compatibility gate", () => {
  test.describe.configure({ timeout: 360_000 });

  for (const [sessionIndex, fixtures] of SESSIONS.entries()) {
    test(`passes fresh session ${sessionIndex + 1}`, async ({ extension }) => {
      for (const fixture of fixtures) {
        if (requestedVideoId && fixture.videoId !== requestedVideoId) {
          continue;
        }
        const evidence = await captureCase(extension, fixture);
        console.log(
          "yt2anki caption gate evidence:",
          JSON.stringify({ session: sessionIndex + 1, ...evidence }),
        );
      }
    });
  }
});

async function captureCase(extension, fixture) {
  const { context, messenger, worker } = extension;
  const source = await context.newPage();
  const captionResponses = [];
  const playerRequests = [];
  let captureStarted = false;
  let editor;
  try {
    source.on("request", (request) => {
      if (!captureStarted) return;
      const url = new URL(request.url());
      if (url.pathname === "/youtubei/v1/player") {
        playerRequests.push(observeRequest(request));
      }
      if (url.pathname === "/api/timedtext") {
        captionResponses.push(observeRequest(request));
      }
    });
    await source.goto(`https://www.youtube.com/watch?v=${fixture.videoId}`, {
      timeout: 45_000,
      waitUntil: "domcontentloaded",
    });
    const playerBefore = await waitForPlayerReady(source);
    const [tab] = await worker.evaluate(
      (videoId) =>
        chrome.tabs.query({
          url: `https://www.youtube.com/watch?v=${videoId}*`,
        }),
      fixture.videoId,
    );
    expect(tab?.id).toBeTruthy();
    const inspection = await extensionMessage(messenger, {
      tabId: tab.id,
      type: "inspect",
    });
    expect(inspection.ok, JSON.stringify(inspection)).toBe(true);
    const targetTrack = preferredTrack(
      inspection.data.video.tracks,
      fixture.target,
    );
    const translationTrack = fixture.translation
      ? preferredTrack(
          inspection.data.video.tracks.filter(
            (track) => track.id !== targetTrack.id,
          ),
          fixture.translation,
        )
      : null;
    const startedAt = performance.now();
    captureStarted = true;
    const editorPromise = context
      .waitForEvent("page", {
        predicate: (page) =>
          page.url().includes(`/editor/editor.html?video=${fixture.videoId}`),
        timeout: 30_000,
      })
      .catch(() => null);
    const generation = await extensionMessage(messenger, {
      tabId: tab.id,
      targetTrackId: targetTrack.id,
      translationTrackId: translationTrack?.id,
      type: "generate",
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    const [payloads, observedPlayerRequests] = await Promise.all([
      Promise.all(captionResponses),
      Promise.all(playerRequests),
    ]);
    const rateLimited = [...payloads, ...observedPlayerRequests].some(
      ({ status }) => status === 429,
    );
    if (!generation.ok) {
      console.log(
        "yt2anki caption gate failure evidence:",
        JSON.stringify({
          captionResponses: payloads.map((response) => redactRequest(response)),
          elapsedMs,
          generation,
          playerRequests: observedPlayerRequests.map((request) =>
            redactRequest(request),
          ),
          rateLimited,
          videoId: fixture.videoId,
        }),
      );
    }
    expect(generation.ok, JSON.stringify(generation)).toBe(true);
    const playerAfter = await readPlayerState(source);
    const playerObservationElapsedMs = Math.round(
      performance.now() - startedAt,
    );
    editor = await editorPromise;
    expect(editor).toBeTruthy();
    const draft = (await extensionStorage(worker))[`draft:${fixture.videoId}`];
    expect(draft).toBeTruthy();
    expect(rateLimited).toBe(false);
    expect(observedPlayerRequests).toHaveLength(1);
    const [{ body: freshPlayerBody, ...freshPlayerRequest }] =
      observedPlayerRequests;
    assertPinnedPlayerRequest(freshPlayerRequest, fixture.videoId);
    expect(freshPlayerBody).not.toBe("");
    const freshPlayer = JSON.parse(freshPlayerBody);
    expect(freshPlayer.videoDetails?.videoId).toBe(fixture.videoId);
    expect(payloads).toHaveLength(translationTrack ? 2 : 1);
    for (const payload of payloads) {
      const url = new URL(payload.url);
      expect(payload.method).toBe("GET");
      expect(payload.status).toBe(200);
      expect(payload.cookie).toBeUndefined();
      expect(payload.requestBody).toBeNull();
      expect(url.searchParams.get("fmt")).toBe("json3");
      expect(url.searchParams.has("c")).toBe(false);
    }

    const targetCues = cuesForTrack(payloads, targetTrack, freshPlayer);
    const translationCues = translationTrack
      ? cuesForTrack(payloads, translationTrack, freshPlayer)
      : [];
    // The capture gate checks transport and track identity. Continuation rules
    // have independent synthetic and captured-video coverage in unit tests.
    const expectedSegments = mergeAgreedCaptionContinuations(
      targetCues,
      translationCues,
    );
    expect(
      draft.segments.map(({ endMs, startMs, target }) => ({
        endMs,
        startMs,
        text: target,
      })),
    ).toEqual(expectedSegments);
    expect(targetCues).toHaveLength(fixture.expectedTargetCount);
    if (fixture.expectedSegmentCount !== undefined) {
      expect(draft.segments).toHaveLength(fixture.expectedSegmentCount);
    }
    let translationEvents = 0;
    if (translationTrack) {
      translationEvents = translationCues.length;
      expect(translationCues).toHaveLength(fixture.expectedTranslationCount);
      expect(draft.segments.map(({ translation }) => translation)).toEqual(
        expectedSegments.map((target) =>
          expectedTranslationText(target, translationCues),
        ),
      );
    }
    expect(draft.targetTrack.id).toBe(targetTrack.id);
    expect(draft.translationTrack?.id ?? null).toBe(
      translationTrack?.id ?? null,
    );
    assertPlayerStatePreserved(
      playerBefore,
      playerAfter,
      playerObservationElapsedMs,
    );
    return {
      elapsedMs,
      playerRequests: observedPlayerRequests.length,
      segments: draft.segments.length,
      targetEvents: targetCues.length,
      targetLanguage: targetTrack.languageCode,
      timedTextRequests: payloads.length,
      translationEvents,
      translationLanguage: translationTrack?.languageCode ?? null,
      videoId: fixture.videoId,
    };
  } finally {
    captureStarted = false;
    await editor?.close().catch(() => undefined);
    await worker
      .evaluate(
        (videoId) => chrome.storage.local.remove(`draft:${videoId}`),
        fixture.videoId,
      )
      .catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

// This evidence is read and pasted by hand, so it must carry no credential.
// A failing gate is exactly the case where the cookie-free contract may have
// broken, so the cookie header, the signed timed-text URL, and the visitor
// identifier are all reduced to presence rather than value.
function redactRequest({
  body,
  cookie,
  requestBody,
  url,
  visitorData,
  ...rest
}) {
  return {
    ...rest,
    bodyLength: body.length,
    hasCookie: Boolean(cookie),
    hasVisitorData: Boolean(visitorData),
    requestBody: redactVisitorData(requestBody),
    url: redactUrl(url),
  };
}

function redactVisitorData(requestBody) {
  return typeof requestBody === "string"
    ? requestBody.replace(
        /"visitorData":"[^"]*"/gu,
        '"visitorData":"[redacted]"',
      )
    : requestBody;
}

// Keeps which parameters were sent, drops every value. Timed-text URLs carry a
// signature and an expiry that identify the session.
function redactUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}?${[...parsed.searchParams.keys()].sort().join(",")}`;
  } catch {
    return "[unparsable]";
  }
}

async function observeRequest(request) {
  const [headers, response] = await Promise.all([
    request.allHeaders(),
    request.response(),
  ]);
  let body = "";
  try {
    body = (await response?.text()) ?? "";
  } catch {}
  return {
    body,
    clientName: headers["x-youtube-client-name"],
    clientVersion: headers["x-youtube-client-version"],
    contentType: headers["content-type"],
    cookie: headers.cookie,
    method: request.method(),
    requestBody: request.postData(),
    status: response?.status() ?? null,
    url: request.url(),
    visitorData: headers["x-goog-visitor-id"],
  };
}

function assertPinnedPlayerRequest(request, videoId) {
  const url = new URL(request.url);
  expect(request.method).toBe("POST");
  expect(url.pathname).toBe("/youtubei/v1/player");
  expect(url.search).toBe("?prettyPrint=false");
  expect(url.searchParams.has("key")).toBe(false);
  expect(request.clientName).toBe("101");
  expect(request.clientVersion).toBe("1.02");
  expect(request.contentType).toBe("application/json");
  expect(request.cookie).toBeUndefined();
  expect(request.status).toBe(200);
  expect(request.requestBody).not.toBeNull();

  const body = JSON.parse(request.requestBody);
  const client = body.context?.client;
  const { hl, visitorData, ...fixedClient } = client;
  expect(hl).toEqual(expect.any(String));
  expect(hl).not.toBe("");
  expect(fixedClient).toEqual({
    clientName: "VISIONOS",
    clientVersion: "1.02",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    timeZone: "UTC",
    utcOffsetMinutes: 0,
  });
  expect(body).toEqual({
    contentCheckOk: true,
    context: {
      client: {
        ...fixedClient,
        hl,
        ...(visitorData ? { visitorData } : {}),
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
      },
    },
    racyCheckOk: true,
    videoId,
  });
  expect(request.visitorData).toBe(visitorData);
}

function expectedTranslationText(target, translationCues) {
  return translationCues
    .filter(
      (cue) =>
        Math.min(target.endMs, cue.endMs) >
        Math.max(target.startMs, cue.startMs),
    )
    .sort((left, right) => left.startMs - right.startMs)
    .reduce((text, cue) => joinExpectedCaptionText(text, cue.text), "");
}

function joinExpectedCaptionText(left, right) {
  if (!left) return right;
  const needsSpace =
    !/\s$/u.test(left) &&
    !/^\s/u.test(right) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left) &&
    !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana},.!?，。！？；;：:]/u.test(
      right,
    );
  return `${left}${needsSpace ? " " : ""}${right}`;
}

function cuesForTrack(payloads, track, freshPlayer) {
  const rawTracks =
    freshPlayer.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const exactTracks = rawTracks.filter(
    (candidate) =>
      candidate.vssId === track.id &&
      candidate.languageCode === track.languageCode &&
      normalizeCaptionTrackKind(candidate.kind ?? null) ===
        normalizeCaptionTrackKind(track.kind),
  );
  expect(exactTracks).toHaveLength(1);
  const expectedUrl = new URL(exactTracks[0].baseUrl);
  expectedUrl.searchParams.set("fmt", "json3");
  expectedUrl.searchParams.delete("xosf");
  const matches = payloads.filter(
    (payload) => payload.url === expectedUrl.href,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0].body).not.toBe("");
  return parseGateJson3(matches[0].body);
}

function parseGateJson3(body) {
  const input = JSON.parse(body);
  expect(Array.isArray(input.events)).toBe(true);
  const parsed = input.events
    .map((event) => {
      if (!event || typeof event !== "object" || !Array.isArray(event.segs)) {
        return null;
      }
      const text = event.segs
        .map((segment) =>
          segment && typeof segment.utf8 === "string" ? segment.utf8 : "",
        )
        .join("")
        .normalize("NFC")
        .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      const nonSpeechOnly =
        /^(?:[[(（【]\s*)?(?:music|applause|laughter|laughs|cheering|silence|音乐|音樂|掌声|掌聲|笑声|笑聲|欢呼|歡呼)(?:\s*[\])）】])?[.!。！]*$/iu;
      if (!text || nonSpeechOnly.test(text) || /^[\s♪♫♬♩]+$/u.test(text)) {
        return null;
      }
      expect(Number.isFinite(event.tStartMs)).toBe(true);
      expect(Number.isFinite(event.dDurationMs)).toBe(true);
      expect(event.tStartMs).toBeGreaterThanOrEqual(0);
      expect(event.dDurationMs).toBeGreaterThan(0);
      return {
        append: event.aAppend === 1,
        endMs: event.tStartMs + event.dDurationMs,
        startMs: event.tStartMs,
        text,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs);

  const cues = [];
  const exactCues = new Set();
  for (const cue of parsed) {
    const previous = cues.at(-1);
    if (
      cue.append &&
      previous &&
      cue.startMs === previous.startMs &&
      cue.endMs === previous.endMs
    ) {
      previous.text = joinExpectedCaptionText(previous.text, cue.text);
      exactCues.add(gateCueKey(previous));
      continue;
    }
    const key = gateCueKey(cue);
    if (exactCues.has(key)) continue;
    exactCues.add(key);
    cues.push({ endMs: cue.endMs, startMs: cue.startMs, text: cue.text });
  }
  return cues;
}

function gateCueKey(cue) {
  return `${cue.startMs}\0${cue.endMs}\0${cue.text}`;
}

function preferredTrack(tracks, preferences) {
  const track = preferences
    .map((languageCode) =>
      tracks.find(
        (candidate) =>
          candidate.languageCode.toLowerCase() === languageCode.toLowerCase(),
      ),
    )
    .find(Boolean);
  if (!track) {
    throw new Error(
      `No track offers ${preferences.join(", ")}: ${JSON.stringify(tracks)}`,
    );
  }
  return track;
}
