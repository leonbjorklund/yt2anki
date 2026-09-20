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

export interface PreciseCaptionEvent {
  aAppend?: 1;
  dDurationMs: number;
  segs: Array<{ utf8: string }>;
  tStartMs: number;
}

export interface PreciseCaptionPayload {
  events: PreciseCaptionEvent[];
}

export interface Segment {
  endMs: number;
  identity: string;
  mergeSources?: [Segment, Segment];
  pinyin: string;
  selected: boolean;
  startMs: number;
  target: string;
  translation: string;
}

export const DRAFT_SCHEMA_VERSION = 9 as const;

export interface Draft {
  translationFirst: boolean;
  generationId: string;
  segments: Segment[];
  sourceTabId: number;
  targetTrack: CaptionTrack;
  translationTrack: CaptionTrack | null;
  version: typeof DRAFT_SCHEMA_VERSION;
  video: SourceVideo;
}

export interface CaptionCapture {
  captions: CaptionCue[];
  trackId: string;
}

export interface SourceCapture {
  captions: CaptionCapture[];
  video: SourceVideo;
}

export interface UserSettings {
  hasPreviousSelection: boolean;
  targetLanguageCode: string | null;
  translationLanguageCode: string | null;
}
