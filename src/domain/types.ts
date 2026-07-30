export interface CaptionTrack {
  id: string;
  languageCode: string;
  name: string;
  kind: string | null;
}

export interface PlaybackCompatibility {
  embeddable: boolean;
  hasOpus: boolean;
  hasVp9: boolean;
}

export interface SourceVideo {
  compatibility: PlaybackCompatibility;
  durationMs: number;
  title: string;
  tracks: CaptionTrack[];
  videoId: string;
}

export interface CaptionCue {
  endMs: number;
  startMs: number;
  text: string;
}

export interface MergedCaption {
  endMs: number;
  startMs: number;
  text: string;
}

export type AlignmentQuality = "matched" | "missing" | "weak";

export interface Segment {
  alignmentQuality: AlignmentQuality;
  endMs: number;
  identity: string;
  selected: boolean;
  sourceEndMs: number;
  sourceStartMs: number;
  startMs: number;
  target: string;
  translation: string;
}

export interface Draft {
  activeSegmentIdentity: string;
  nativeLocale: string;
  nativeTrack: CaptionTrack | null;
  segments: Segment[];
  sourceTabId: number;
  targetLocale: string;
  targetTrack: CaptionTrack;
  version: 1;
  video: SourceVideo;
}

export interface CaptionCapture {
  json3: unknown;
  trackId: string;
}

export interface SourceCapture {
  captions: CaptionCapture[];
  video: SourceVideo;
}

export interface UserSettings {
  nativeLocale: string;
  targetLocale: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  nativeLocale: "en-GB",
  targetLocale: "zh-Hans",
};
