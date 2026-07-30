import { matchManualTrack, manualTracks } from "../domain/language.ts";
import type { CaptionTrack } from "../domain/types.ts";
import type {
  AppResponse,
  InspectData,
} from "../messages.ts";

const videoTitle = element<HTMLParagraphElement>("video-title");
const languageFields = element<HTMLDivElement>("language-fields");
const targetLocale = element<HTMLSelectElement>("target-locale");
const nativeLocale = element<HTMLSelectElement>("native-locale");
const targetTrackField =
  element<HTMLLabelElement>("target-track-field");
const nativeTrackField =
  element<HTMLLabelElement>("native-track-field");
const targetTrack = element<HTMLSelectElement>("target-track");
const nativeTrack = element<HTMLSelectElement>("native-track");
const status = element<HTMLParagraphElement>("status");
const action = element<HTMLButtonElement>("primary-action");
const YOUTUBE_PREVIEW_PERMISSION = "https://www.youtube.com/*";
const YOUTUBE_PREVIEW_RULE_ID = 153;

let tabId: number | null = null;
let inspection: InspectData | null = null;

void initialize();

targetLocale.addEventListener("change", () => {
  if (inspection && inspection.draftSegmentCount === 0) {
    populateNativeLocaleSelect(
      nativeLocale,
      nativeLocale.value,
      inspection.video.tracks,
      targetLocale.value,
    );
  }
  updateEligibility();
});
nativeLocale.addEventListener("change", updateEligibility);
action.addEventListener("click", () => {
  void (inspection ? runPrimaryAction() : initialize());
});

async function initialize(): Promise<void> {
  inspection = null;
  tabId = null;
  videoTitle.textContent = "";
  videoTitle.hidden = true;
  languageFields.hidden = true;
  status.textContent = "Checking this video…";
  action.textContent = "Generate cards";
  action.disabled = true;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) {
    showFailure("The active tab is unavailable.");
    return;
  }
  tabId = tab.id;

  const response = await sendMessage<InspectData>({
    tabId,
    type: "inspect",
  });
  if (!response.ok) {
    if (response.error.code === "CAPTURE_FAILED") {
      showRetry(response.error.message);
    } else {
      showFailure(response.error.message);
    }
    return;
  }

  inspection = response.data;
  videoTitle.textContent = inspection.video.title;
  videoTitle.hidden = false;
  languageFields.hidden = false;
  populateTargetLocaleSelect(
    targetLocale,
    inspection.settings.targetLocale,
    inspection.video.tracks,
  );
  populateNativeLocaleSelect(
    nativeLocale,
    inspection.settings.nativeLocale,
    inspection.video.tracks,
    targetLocale.value,
  );
  updateEligibility();
}

function updateEligibility(): void {
  if (!inspection) {
    return;
  }
  if (inspection.draftSegmentCount > 0) {
    targetTrackField.hidden = true;
    nativeTrackField.hidden = true;
    const count = inspection.draftSegmentCount;
    status.textContent =
      `${count} saved ${count === 1 ? "segment" : "segments"}.`;
    action.textContent = "Resume draft";
    action.disabled = false;
    return;
  }

  const tracks = manualTracks(inspection.video.tracks);
  const targetMatch = matchManualTrack(tracks, targetLocale.value);
  const nativeMatch = matchManualTrack(
    tracks.filter(
      (track) => track.languageCode !== targetLocale.value,
    ),
    nativeLocale.value,
  );

  updateTrackChoice(targetTrackField, targetTrack, targetMatch);
  updateTrackChoice(nativeTrackField, nativeTrack, nativeMatch);

  if (targetMatch.status === "missing") {
    status.textContent =
      "No matching manual Target Language captions.";
    action.disabled = true;
    return;
  }

  status.textContent =
    targetMatch.status === "ambiguous" ||
    nativeMatch.status === "ambiguous"
      ? "Choose the caption track to use."
      : nativeMatch.status === "missing"
        ? "Manual Target captions found. Gemini will translate."
        : "Manual captions found.";
  action.textContent = "Generate cards";
  action.disabled = false;
}

async function runPrimaryAction(): Promise<void> {
  if (!inspection || tabId === null) {
    return;
  }

  action.disabled = true;
  try {
    if (!(await prepareVideoPreview())) {
      showRetry("Allow YouTube access to play Segment previews.");
      return;
    }
  } catch {
    showRetry("Video preview could not be prepared.");
    return;
  }

  if (inspection.draftSegmentCount > 0) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `editor/editor.html?video=${encodeURIComponent(inspection.video.videoId)}`,
      ),
    });
    window.close();
    return;
  }

  action.textContent = "Capturing…";
  status.textContent = "Capturing the active player’s manual captions…";
  const response = await sendMessage<null>({
    nativeLocale: nativeLocale.value,
    ...(nativeTrackField.hidden
      ? {}
      : { nativeTrackId: nativeTrack.value }),
    tabId,
    targetLocale: targetLocale.value,
    ...(targetTrackField.hidden
      ? {}
      : { targetTrackId: targetTrack.value }),
    type: "generate",
  });
  if (!response.ok) {
    showFailure(response.error.message);
    action.textContent = "Try again";
    action.disabled = false;
    return;
  }
  window.close();
}

async function prepareVideoPreview(): Promise<boolean> {
  const granted = await chrome.permissions.request({
    origins: [YOUTUBE_PREVIEW_PERMISSION],
  });
  if (!granted) {
    return false;
  }

  const extensionId = chrome.runtime.id;
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        action: {
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: `https://yt2anki.${extensionId}/`,
            },
          ],
          type: "modifyHeaders",
        },
        condition: {
          initiatorDomains: [extensionId],
          regexFilter: "^https://www\\.youtube\\.com/embed/",
          resourceTypes: ["sub_frame"],
        },
        id: YOUTUBE_PREVIEW_RULE_ID,
        priority: 1,
      },
    ],
    removeRuleIds: [YOUTUBE_PREVIEW_RULE_ID],
  });
  return true;
}

function updateTrackChoice(
  field: HTMLLabelElement,
  select: HTMLSelectElement,
  match: ReturnType<typeof matchManualTrack>,
): void {
  field.hidden = match.status !== "ambiguous";
  select.replaceChildren();
  if (match.status !== "ambiguous") {
    return;
  }
  for (const track of match.tracks) {
    select.add(
      new Option(`${track.name} (${track.languageCode})`, track.id),
    );
  }
}

function populateTargetLocaleSelect(
  select: HTMLSelectElement,
  savedLocale: string,
  tracks: CaptionTrack[],
): void {
  const manual = manualTracks(tracks);
  const locales = localeTracks(manual);
  select.replaceChildren();
  if (locales.size === 0) {
    select.add(new Option("No target captions", savedLocale));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  addLocaleOptions(select, locales);
  const savedMatch = matchManualTrack(manual, savedLocale);
  select.value =
    locales.has(savedLocale)
      ? savedLocale
      : savedMatch.status === "matched"
        ? savedMatch.track.languageCode
        : locales.keys().next().value!;
}

function populateNativeLocaleSelect(
  select: HTMLSelectElement,
  savedLocale: string,
  tracks: CaptionTrack[],
  targetLanguageCode: string,
): void {
  const candidates = manualTracks(tracks).filter(
    (track) => track.languageCode !== targetLanguageCode,
  );
  const locales = localeTracks(candidates);
  const savedMatch = matchManualTrack(candidates, savedLocale);
  select.replaceChildren();

  if (locales.size === 0) {
    select.add(new Option("No native captions", savedLocale));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  if (savedMatch.status === "missing") {
    select.add(new Option("No native captions", savedLocale));
  } else if (savedMatch.status === "ambiguous") {
    select.add(new Option("Choose native captions", savedLocale));
  }
  addLocaleOptions(select, locales);
  select.value =
    savedMatch.status === "matched"
      ? savedMatch.track.languageCode
      : savedLocale;
}

function localeTracks(tracks: CaptionTrack[]): Map<string, CaptionTrack> {
  const locales = new Map<string, CaptionTrack>();
  for (const track of tracks) {
    if (!locales.has(track.languageCode)) {
      locales.set(track.languageCode, track);
    }
  }
  return locales;
}

function addLocaleOptions(
  select: HTMLSelectElement,
  locales: Map<string, CaptionTrack>,
): void {
  for (const [locale, track] of locales) {
    select.add(new Option(track.name, locale));
  }
}

function showFailure(message: string): void {
  status.textContent = message;
  action.disabled = true;
}

function showRetry(message: string): void {
  status.textContent = message;
  action.textContent = "Try again";
  action.disabled = false;
}

async function sendMessage<T>(message: object): Promise<AppResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(message)) as AppResponse<T>;
  } catch {
    return {
      error: {
        code: "TAB_UNAVAILABLE",
        message: "The extension background process is unavailable.",
      },
      ok: false,
    };
  }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}
