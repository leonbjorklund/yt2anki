import { baseVideoDeckName } from "./domain/deck.ts";
import type { Draft, UserSettings } from "./domain/types.ts";
import { DRAFT_SCHEMA_VERSION } from "./domain/types.ts";

const SETTINGS_KEY = "settings";
const DECK_OWNERS_KEY = "deck-owners:v2";

interface DeckOwners {
  byDeck: Record<string, string>;
  byVideo: Record<string, string>;
}

export class StaleDraftError extends Error {
  constructor() {
    super(
      "This Draft was replaced by a newer generation. Use the newer editor tab.",
    );
  }
}

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<UserSettings> | undefined;
  return {
    hasPreviousSelection: stored?.hasPreviousSelection === true,
    targetLanguageCode: stringOrNull(stored?.targetLanguageCode),
    translationLanguageCode: stringOrNull(stored?.translationLanguageCode),
  };
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadDraft(videoId: string): Promise<Draft | null> {
  return navigator.locks.request(draftLock(videoId), () => readDraft(videoId));
}

export async function saveDraft(draft: Draft): Promise<void> {
  await navigator.locks.request(draftLock(draft.video.videoId), async () => {
    await assertCurrentDraft(draft);
    await chrome.storage.local.set({ [draftKey(draft.video.videoId)]: draft });
  });
}

export async function replaceDraft(draft: Draft): Promise<void> {
  await navigator.locks.request(draftLock(draft.video.videoId), () =>
    chrome.storage.local.set({ [draftKey(draft.video.videoId)]: draft }),
  );
}

export async function withCurrentDraft<T>(
  draft: Draft,
  action: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(draftLock(draft.video.videoId), async () => {
    await assertCurrentDraft(draft);
    return action();
  });
}

export async function reserveVideoDeckName(
  title: string,
  videoId: string,
): Promise<string> {
  return navigator.locks.request("yt2anki:deck-owners", async () => {
    const owners = await getDeckOwners();
    const existing = owners.byVideo[videoId];
    if (existing) {
      return existing;
    }
    const base = baseVideoDeckName(title);
    const owner = owners.byDeck[base];
    const deckName = owner && owner !== videoId ? `${base} [${videoId}]` : base;
    const deckNameOwner = owners.byDeck[deckName];
    if (deckNameOwner && deckNameOwner !== videoId) {
      throw new Error(
        "A different Source Video already reserved both collision-safe deck names.",
      );
    }
    owners.byDeck[deckName] = videoId;
    owners.byVideo[videoId] = deckName;
    await saveDeckOwners(owners);
    return deckName;
  });
}

function draftKey(videoId: string): string {
  return `draft:${videoId}`;
}

function draftLock(videoId: string): string {
  return `yt2anki:draft:${videoId}`;
}

async function assertCurrentDraft(draft: Draft): Promise<void> {
  const current = await readDraft(draft.video.videoId);
  if (current?.generationId !== draft.generationId) {
    throw new StaleDraftError();
  }
}

async function readDraft(videoId: string): Promise<Draft | null> {
  const key = draftKey(videoId);
  const result = await chrome.storage.local.get(key);
  const stored = result[key] as unknown;
  if (!stored || typeof stored !== "object") {
    return null;
  }
  const draft = stored as Draft;
  if (
    draft.version !== DRAFT_SCHEMA_VERSION ||
    typeof draft.translationFirst !== "boolean"
  ) {
    return null;
  }
  return draft;
}

async function getDeckOwners(): Promise<DeckOwners> {
  const result = await chrome.storage.local.get(DECK_OWNERS_KEY);
  const value = result[DECK_OWNERS_KEY] as Partial<DeckOwners> | undefined;
  return {
    byDeck: isStringRecord(value?.byDeck) ? value.byDeck : {},
    byVideo: isStringRecord(value?.byVideo) ? value.byVideo : {},
  };
}

async function saveDeckOwners(owners: DeckOwners): Promise<void> {
  await chrome.storage.local.set({ [DECK_OWNERS_KEY]: owners });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
