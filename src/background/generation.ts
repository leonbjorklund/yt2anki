import {
  alignTranslationCaptions,
  buildTargetSegments,
  mergeAgreedCaptionContinuations,
} from "../domain/captions.ts";
import { supportedCaptionTracks } from "../domain/language.ts";
import type { CaptionTrack, Draft } from "../domain/types.ts";
import { DRAFT_SCHEMA_VERSION } from "../domain/types.ts";
import type { GenerateData, GenerationMessage } from "../messages.ts";
import { replaceDraft, saveSettings } from "../storage.ts";
import {
  capturedCaptions,
  captureSourceTab,
  inspectSourceTab,
} from "./capture.ts";
import { appError } from "./errors.ts";

export async function generateDraft(
  message: GenerationMessage,
): Promise<GenerateData> {
  return navigator.locks.request(
    `yt2anki:generation:${message.tabId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw appError(
          "CAPTURE_FAILED",
          "Caption capture is already running for this Source Video.",
        );
      }
      return generateDraftWithLock(message);
    },
  );
}

async function generateDraftWithLock(
  message: GenerationMessage,
): Promise<GenerateData> {
  const sourceTabPolicy =
    message.type === "generate-preview" ? "recovery" : "toolbar-action";
  const inspectedVideo = await inspectSourceTab(message.tabId, sourceTabPolicy);
  if (
    message.type !== "generate" &&
    inspectedVideo.videoId !== message.videoId
  ) {
    throw appError(
      "CAPTURE_FAILED",
      message.type === "generate-package"
        ? "The Source Video changed before package capture. Try again."
        : "The Source Video changed before preview capture. Try again.",
    );
  }
  const tracks = supportedCaptionTracks(inspectedVideo.tracks);
  const targetTrack = selectedTrack(tracks, message.targetTrackId, "Track one");
  const translationTrack = message.translationTrackId
    ? selectedTrack(tracks, message.translationTrackId, "Track two")
    : null;
  if (translationTrack?.id === targetTrack.id) {
    throw appError(
      "INVALID_REQUEST",
      "Choose a different caption track for Track two or leave it empty.",
    );
  }

  const capture = await captureSourceTab(
    message.tabId,
    [targetTrack, ...(translationTrack ? [translationTrack] : [])],
    sourceTabPolicy,
  );
  if (capture.video.videoId !== inspectedVideo.videoId) {
    throw appError(
      "CAPTURE_FAILED",
      "The Source Video changed during caption capture. Try again.",
    );
  }

  const targetCaptions = capturedCaptions(
    capture.captions,
    targetTrack.id,
  ).captions;
  if (targetCaptions.length === 0) {
    throw appError("CAPTURE_FAILED", "Track one contained no usable speech.");
  }

  const translationCaptions = translationTrack
    ? capturedCaptions(capture.captions, translationTrack.id).captions
    : [];
  const segmentCaptions = translationTrack
    ? mergeAgreedCaptionContinuations(targetCaptions, translationCaptions)
    : targetCaptions;
  let segments = await buildTargetSegments({
    captions: segmentCaptions,
    track: targetTrack,
    videoId: inspectedVideo.videoId,
  });

  if (translationTrack) {
    segments = alignTranslationCaptions(segments, translationCaptions);
  }

  const draft: Draft = {
    generationId: crypto.randomUUID(),
    segments,
    sourceTabId: message.tabId,
    targetTrack,
    translationTrack,
    translationFirst: false,
    version: DRAFT_SCHEMA_VERSION,
    video: capture.video,
  };

  await Promise.all([
    replaceDraft(draft),
    saveSettings({
      hasPreviousSelection: true,
      targetLanguageCode: targetTrack.languageCode,
      translationLanguageCode: translationTrack?.languageCode ?? null,
    }),
  ]);
  if (message.type !== "generate-package") {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `editor/editor.html?video=${encodeURIComponent(inspectedVideo.videoId)}`,
      ),
    });
  }
  return {
    generationId: draft.generationId,
    videoId: draft.video.videoId,
  };
}

function selectedTrack(
  tracks: CaptionTrack[],
  id: string,
  role: "Track one" | "Track two",
): CaptionTrack {
  const selected = tracks.find((track) => track.id === id);
  if (!selected) {
    throw appError(
      role === "Track one" ? "NO_TARGET_TRACK" : "CAPTURE_FAILED",
      `The selected ${role} caption track is unavailable.`,
    );
  }
  return selected;
}
