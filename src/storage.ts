import {
  DEFAULT_SETTINGS,
  type Draft,
  type UserSettings,
} from "./domain/types.ts";

const SETTINGS_KEY = "settings";
const GEMINI_KEY = "secret:gemini";
const ANKI_CONNECT_KEY = "secret:anki-connect";
const DECK_OWNERS_KEY = "deck-owners";

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<UserSettings> | undefined;
  return {
    nativeLocale: stored?.nativeLocale || DEFAULT_SETTINGS.nativeLocale,
    targetLocale: stored?.targetLocale || DEFAULT_SETTINGS.targetLocale,
  };
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getDraft(videoId: string): Promise<Draft | null> {
  const key = draftKey(videoId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as Draft | undefined) ?? null;
}

export async function saveDraft(draft: Draft): Promise<void> {
  await chrome.storage.local.set({ [draftKey(draft.video.videoId)]: draft });
}

export async function removeDraft(videoId: string): Promise<void> {
  await chrome.storage.local.remove(draftKey(videoId));
}

export async function getGeminiKey(): Promise<string> {
  return getSecret(GEMINI_KEY);
}

export async function saveGeminiKey(value: string): Promise<void> {
  await saveSecret(GEMINI_KEY, value);
}

export async function forgetGeminiKey(): Promise<void> {
  await chrome.storage.local.remove(GEMINI_KEY);
}

export async function getAnkiConnectKey(): Promise<string> {
  return getSecret(ANKI_CONNECT_KEY);
}

export async function saveAnkiConnectKey(value: string): Promise<void> {
  await saveSecret(ANKI_CONNECT_KEY, value);
}

export async function forgetAnkiConnectKey(): Promise<void> {
  await chrome.storage.local.remove(ANKI_CONNECT_KEY);
}

export async function getDeckOwners(): Promise<Record<string, string>> {
  const result = await chrome.storage.local.get(DECK_OWNERS_KEY);
  const value = result[DECK_OWNERS_KEY];
  return value && typeof value === "object"
    ? (value as Record<string, string>)
    : {};
}

export async function rememberDeckOwner(
  deckName: string,
  videoId: string,
): Promise<void> {
  await navigator.locks.request("yt2anki:deck-owners", async () => {
    const owners = await getDeckOwners();
    owners[deckName] = videoId;
    await chrome.storage.local.set({ [DECK_OWNERS_KEY]: owners });
  });
}

function draftKey(videoId: string): string {
  return `draft:${videoId}`;
}

async function getSecret(key: string): Promise<string> {
  const result = await chrome.storage.local.get(key);
  const value = result[key];
  return typeof value === "string" ? value : "";
}

async function saveSecret(key: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Key cannot be empty");
  }
  await chrome.storage.local.set({ [key]: trimmed });
}
