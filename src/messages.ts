import type { SourceVideo, UserSettings } from "./domain/types.ts";

export type AppErrorCode =
  | "CAPTION_RATE_LIMITED"
  | "CAPTURE_FAILED"
  | "INVALID_REQUEST"
  | "NO_TARGET_TRACK"
  | "NOT_YOUTUBE_WATCH"
  | "TAB_UNAVAILABLE";

export interface AppError {
  code: AppErrorCode;
  message: string;
}

export type AppResponse<T> =
  | { data: T; ok: true }
  | { error: AppError; ok: false };

export interface InspectMessage {
  tabId: number;
  type: "inspect" | "inspect-recovery";
}

export interface PreflightMessage {
  tabId: number;
  type: "preflight";
  videoId: string;
}

interface GenerationFields {
  tabId: number;
  targetTrackId: string;
  translationTrackId?: string;
}

export type GenerationMessage =
  | (GenerationFields & { type: "generate" })
  | (GenerationFields & {
      type: "generate-package" | "generate-preview";
      videoId: string;
    });

export interface GenerateData {
  generationId: string;
  videoId: string;
}

export type AppMessage = GenerationMessage | InspectMessage | PreflightMessage;

export interface InspectData {
  draftSchemaVersion: number;
  protocolVersion: number;
  settings: UserSettings;
  video: SourceVideo;
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (
    !isRecord(value) ||
    typeof value.tabId !== "number" ||
    !Number.isInteger(value.tabId) ||
    value.tabId < 0
  ) {
    return false;
  }
  if (value.type === "inspect" || value.type === "inspect-recovery") {
    return true;
  }
  if (value.type === "preflight") {
    return isVideoId(value.videoId);
  }
  const validGeneration =
    (value.type === "generate" ||
      value.type === "generate-package" ||
      value.type === "generate-preview") &&
    typeof value.targetTrackId === "string" &&
    Boolean(value.targetTrackId.trim()) &&
    (value.translationTrackId === undefined ||
      (typeof value.translationTrackId === "string" &&
        Boolean(value.translationTrackId.trim()) &&
        value.translationTrackId !== value.targetTrackId));
  return (
    validGeneration && (value.type === "generate" || isVideoId(value.videoId))
  );
}

function isVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
