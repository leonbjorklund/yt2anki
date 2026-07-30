import { canonicalLocale } from "./domain/language.ts";
import type {
  SourceVideo,
  UserSettings,
} from "./domain/types.ts";

export type AppErrorCode =
  | "AMBIGUOUS_TRACK"
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
  type: "inspect";
}

export interface GenerateMessage {
  nativeLocale: string;
  nativeTrackId?: string;
  tabId: number;
  targetLocale: string;
  targetTrackId?: string;
  type: "generate";
}

export type AppMessage = GenerateMessage | InspectMessage;

export interface InspectData {
  draftSegmentCount: number;
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
  if (value.type === "inspect") {
    return true;
  }
  return (
    value.type === "generate" &&
    typeof value.nativeLocale === "string" &&
    canonicalLocale(value.nativeLocale) !== null &&
    typeof value.targetLocale === "string" &&
    canonicalLocale(value.targetLocale) !== null &&
    [value.nativeTrackId, value.targetTrackId].every(
      (id) =>
        id === undefined ||
        (typeof id === "string" && Boolean(id.trim())),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
