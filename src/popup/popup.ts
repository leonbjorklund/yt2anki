import { buildApkg } from "../anki/apkg.ts";
import { PLAYBACK_FAILURE_MESSAGE } from "../anki/export-validation.ts";
import {
  PACKAGE_BUSY_LABEL,
  PACKAGE_DELIVERY_STATUS,
  PackageDelivery,
} from "../anki/package-download.ts";
import { baseLanguage, supportedCaptionTracks } from "../domain/language.ts";
import {
  type CaptionTrack,
  DRAFT_SCHEMA_VERSION,
  type SourceVideo,
} from "../domain/types.ts";
import type {
  AppResponse,
  GenerateData,
  GenerationMessage,
  InspectData,
} from "../messages.ts";
import {
  isPopupPermissionResume,
  type PopupPermissionRequest,
  type PopupPermissionResume,
  YOUTUBE_PREVIEW_PERMISSIONS,
} from "../popup-permission.ts";
import {
  APP_PROTOCOL_VERSION,
  isFreshPopupRecovery,
  POPUP_RECOVERY_KEY,
  type PopupRecovery,
} from "../popup-recovery.ts";
import {
  loadDraft,
  reserveVideoDeckName,
  StaleDraftError,
  withCurrentDraft,
} from "../storage.ts";

const captionFields = element<HTMLDivElement>("caption-fields");
const heading = element<HTMLHeadingElement>("heading");
const targetTrack = element<HTMLSelectElement>("target-track");
const translationField = element<HTMLLabelElement>("translation-field");
const translationTrack = element<HTMLSelectElement>("translation-track");
const status = element<HTMLParagraphElement>("status");
const progress = element<HTMLElement>("progress");
const action = element<HTMLButtonElement>("primary-action");
const actionLabel = element<HTMLElement>("primary-action-label");
const packageLabel = element<HTMLElement>("package-action-label");
const downloadApkg = element<HTMLButtonElement>("download-apkg");
// Routine progress text, as opposed to an outcome worth keeping announced.
const BUSY_ANNOUNCEMENTS = new Set([
  "Building package…",
  "Capturing captions…",
  "Preparing preview…",
]);
const YOUTUBE_PREVIEW_RULE_ID = 153;

let tabId: number | null = null;
let inspection: InspectData | null = null;
let captureRateLimited = false;
const packageDelivery = new PackageDelivery();

void initialize();

targetTrack.addEventListener("change", () => {
  if (!inspection) {
    return;
  }
  const invalidated = packageDelivery.invalidateForUserChange();
  populateTranslationTracks(
    supportedCaptionTracks(inspection.video.tracks),
    translationTrack.value,
  );
  showReadyActions();
  if (invalidated) {
    showStatus(PACKAGE_DELIVERY_STATUS.invalidated);
  }
});
translationTrack.addEventListener("change", () => {
  const invalidated = packageDelivery.invalidateForUserChange();
  showReadyActions();
  if (invalidated) {
    showStatus(PACKAGE_DELIVERY_STATUS.invalidated);
  }
});
action.addEventListener("click", () => {
  void (inspection ? runPrimaryAction() : initialize());
});
downloadApkg.addEventListener("click", () => {
  void (packageDelivery.canOpen
    ? openPackageInAnki()
    : downloadPackageForOpening());
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  const changed = packageDelivery.draftVideoId
    ? changes[`draft:${packageDelivery.draftVideoId}`]
    : undefined;
  if (areaName !== "local" || !changed) {
    return;
  }
  if (!packageDelivery.invalidateForDraftChange(changed.newValue)) {
    return;
  }
  resetPackageLabel();
  showStatus(PACKAGE_DELIVERY_STATUS.invalidated);
});

async function initialize(): Promise<void> {
  clearPackageDelivery();
  inspection = null;
  tabId = null;
  heading.textContent = "Checking caption tracks…";
  captionFields.hidden = true;
  action.hidden = true;
  downloadApkg.hidden = true;
  downloadApkg.disabled = true;
  status.hidden = true;

  const resume = await claimPopupPermissionResume();
  if (resume) {
    tabId = resume.tabId;
  } else {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      showUnavailableState("Open a YouTube video", true);
      return;
    }
    const editorUrl = new URL(chrome.runtime.getURL("editor/editor.html"));
    // Chrome can omit tab URLs without a host grant, even for our own editor.
    const tabUrl =
      tab.url ??
      chrome.extension.getViews({ tabId: tab.id, type: "tab" })[0]?.location
        .href;
    if (tabUrl) {
      const activeUrl = new URL(tabUrl);
      if (
        activeUrl.protocol === editorUrl.protocol &&
        activeUrl.host === editorUrl.host &&
        activeUrl.pathname === editorUrl.pathname
      ) {
        const videoId = activeUrl.searchParams.get("video");
        const draft = videoId ? await loadDraft(videoId) : null;
        heading.textContent = draft?.video.title || "yt2anki";
        return;
      }
    }
    tabId = tab.id;
  }

  const response = await sendMessage<InspectData>({
    tabId,
    type: resume ? "inspect-recovery" : "inspect",
  });
  if (!response.ok) {
    const retry = response.error.code !== "NOT_YOUTUBE_WATCH";
    showUnavailableState(retry ? "Try again" : "Open a YouTube video", !retry);
    return;
  }
  if (
    response.data.protocolVersion !== APP_PROTOCOL_VERSION ||
    response.data.draftSchemaVersion !== DRAFT_SCHEMA_VERSION
  ) {
    heading.textContent = "yt2anki";
    await reloadOutdatedBackground();
    return;
  }

  inspection = response.data;
  const tracks = supportedCaptionTracks(inspection.video.tracks);
  heading.textContent = `${tracks.length} caption ${tracks.length === 1 ? "track" : "tracks"}`;
  captionFields.hidden = tracks.length === 0;
  translationField.hidden = tracks.length < 2;
  if (tracks.length === 0) {
    action.hidden = true;
    showStatus("No supported captions");
    return;
  }
  populateTargetTracks(tracks);
  populateTranslationTracks(tracks);
  showReadyActions();
  if (resume) {
    if (resume.action === "preview") {
      await runPrimaryAction(resume);
    } else {
      await restorePackageOpening(resume);
    }
  }
}

function showUnavailableState(label: string, disabled: boolean): void {
  heading.textContent = "yt2anki";
  captionFields.hidden = true;
  showState(label, disabled);
}

async function reloadOutdatedBackground(): Promise<void> {
  showState("Updating extension…", true);
  try {
    const stored = await chrome.storage.local.get(POPUP_RECOVERY_KEY);
    if (isFreshPopupRecovery(stored[POPUP_RECOVERY_KEY])) {
      showState("Retry extension update", false);
      return;
    }
    const recovery: PopupRecovery = {
      protocolVersion: APP_PROTOCOL_VERSION,
      requestedAt: Date.now(),
    };
    await chrome.storage.local.set({ [POPUP_RECOVERY_KEY]: recovery });
    chrome.runtime.reload();
  } catch {
    showState("Retry extension update", false);
  }
}

function populateTargetTracks(tracks: CaptionTrack[]): void {
  targetTrack.replaceChildren(
    ...tracks.map((track) => trackOption(track, tracks)),
  );
  targetTrack.value =
    preferredTrackId(tracks, inspection?.settings.targetLanguageCode) ??
    tracks[0]?.id ??
    "";
}

function populateTranslationTracks(
  tracks: CaptionTrack[],
  currentId?: string,
): void {
  const candidates = tracks.filter((track) => track.id !== targetTrack.value);
  const noSecondTrack = new Option("–", "");
  noSecondTrack.setAttribute("aria-label", "No second track");
  translationTrack.replaceChildren(
    noSecondTrack,
    ...candidates.map((track) => trackOption(track, tracks)),
  );

  if (currentId !== undefined) {
    translationTrack.value = candidates.some((track) => track.id === currentId)
      ? currentId
      : "";
    return;
  }
  const preferredLanguage = inspection?.settings.hasPreviousSelection
    ? inspection.settings.translationLanguageCode
    : navigator.language;
  translationTrack.value =
    preferredTrackId(candidates, preferredLanguage) ?? "";
}

async function runPrimaryAction(
  resumed: PopupPermissionResume | null = null,
): Promise<void> {
  if (action.disabled) {
    return;
  }

  clearPackageDelivery();
  showState("Generating", true);
  progress.textContent = "Preparing preview…";
  downloadApkg.disabled = true;
  let resume = resumed;
  try {
    if (
      !resume &&
      !(await chrome.permissions.contains(YOUTUBE_PREVIEW_PERMISSIONS))
    ) {
      resume = await requestPopupPermissionResume("preview");
      if (!resume) {
        showReadyActions();
        return;
      }
    }
  } catch {
    showState("Retry preview setup", false);
    downloadApkg.disabled = false;
    return;
  }
  if (resume && !restorePopupPermissionSelection(resume)) {
    return;
  }
  const captured = await captureDraft(resume ? "generate-preview" : "generate");
  if (!captured) {
    // captureDraft has already announced why. Clearing here would wipe that
    // message out of the live region before it is read.
    downloadApkg.disabled = action.disabled;
    return;
  }
  clearBusyAnnouncement();
  window.close();
}

async function captureDraft(
  generationType: GenerationMessage["type"],
): Promise<GenerateData | null> {
  if (!inspection || tabId === null || !targetTrack.value) {
    return null;
  }

  if (generationType !== "generate-package") {
    showState("Generating", true);
    progress.textContent = "Preparing preview…";
    try {
      await prepareVideoPreview();
    } catch {
      showState("Retry preview setup", false);
      return null;
    }
  }

  if (generationType === "generate-package") {
    showState("Editor Preview", true);
    packageLabel.textContent = PACKAGE_BUSY_LABEL.capturing;
  } else {
    showState("Generating", true);
  }
  progress.textContent = "Capturing captions…";
  const response = await sendMessage<GenerateData>({
    tabId,
    targetTrackId: targetTrack.value,
    ...(translationTrack.value
      ? { translationTrackId: translationTrack.value }
      : {}),
    ...(generationType !== "generate"
      ? { videoId: inspection.video.videoId }
      : {}),
    type: generationType,
  });
  if (!response.ok) {
    const { code, message } = response.error;
    if (code === "CAPTION_RATE_LIMITED") {
      captureRateLimited = true;
    }
    const chooseTrack =
      code === "NO_TARGET_TRACK" || message.includes("Caption Track");
    const blocked =
      code === "CAPTION_RATE_LIMITED" ||
      code === "TAB_UNAVAILABLE" ||
      chooseTrack;
    showState(
      code === "CAPTION_RATE_LIMITED"
        ? "Try again later"
        : code === "TAB_UNAVAILABLE"
          ? "Open the Source Video"
          : chooseTrack
            ? "Choose another caption track"
            : "Try capture again",
      blocked,
      blocked ? message : "",
    );
    return null;
  }
  return response.data;
}

async function downloadPackageForOpening(): Promise<void> {
  if (downloadApkg.disabled) {
    return;
  }

  resetPackageLabel();
  setPackageBusy(true);
  try {
    const delivery = await packageDelivery.run({
      build: async (draft) => {
        const preflight = await sendMessage<SourceVideo>({
          tabId: draft.sourceTabId,
          type: "preflight",
          videoId: draft.video.videoId,
        });
        if (!preflight.ok) {
          throw new Error(preflight.error.message);
        }
        draft.video.compatibility = preflight.data.compatibility;
        if (!Object.values(draft.video.compatibility).every(Boolean)) {
          throw new Error(PLAYBACK_FAILURE_MESSAGE);
        }
        return withCurrentDraft(draft, async () =>
          buildApkg({
            deckName: await reserveVideoDeckName(
              draft.video.title,
              draft.video.videoId,
            ),
            draft,
            segments: draft.segments.filter((segment) => segment.selected),
          }),
        );
      },
      prepareDraft: async () => {
        const captured = await captureDraft("generate-package");
        if (!captured) {
          return null;
        }
        packageLabel.textContent = PACKAGE_BUSY_LABEL.building;
        progress.textContent = "Building package…";
        const draft = await loadDraft(captured.videoId);
        if (
          !draft ||
          draft.video.videoId !== captured.videoId ||
          draft.generationId !== captured.generationId
        ) {
          throw new StaleDraftError();
        }
        return draft;
      },
    });
    if (delivery === "cancelled" || delivery === "superseded") {
      clearBusyAnnouncement();
      return;
    }
    packageLabel.textContent = packageDelivery.canOpen
      ? "Open in Anki"
      : "Download .apkg";
    showStatus(PACKAGE_DELIVERY_STATUS[delivery]);
  } catch (error) {
    showStatus(
      error instanceof Error ? error.message : "Package export failed.",
    );
  } finally {
    // Do not clear #progress here. showStatus has just written the outcome to
    // it, and wiping the live region in the same task swallows the
    // announcement. The paths with nothing to announce clear it themselves.
    setPackageBusy(false);
  }
}

async function requestPopupPermissionResume(
  requestedAction: PopupPermissionResume["action"],
): Promise<PopupPermissionResume | null> {
  if (!inspection || tabId === null || !targetTrack.value) {
    return null;
  }
  const snapshot = packageDelivery.snapshot();
  if (requestedAction === "open-package" && !snapshot) return null;
  const request: PopupPermissionRequest = {
    ...(requestedAction === "open-package" && snapshot
      ? { action: "open-package" as const, package: snapshot }
      : { action: "preview" as const }),
    tabId,
    targetTrackId: targetTrack.value,
    ...(translationTrack.value
      ? { translationTrackId: translationTrack.value }
      : {}),
    type: "request-popup-permission",
    videoId: inspection.video.videoId,
  };
  const response = (await chrome.runtime.sendMessage(request)) as
    | { attemptId?: unknown }
    | undefined;
  if (typeof response?.attemptId !== "string") {
    return null;
  }
  return claimPopupPermissionResume(response.attemptId);
}

async function claimPopupPermissionResume(
  attemptId?: string,
): Promise<PopupPermissionResume | null> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      ...(attemptId ? { attemptId } : {}),
      type: "claim-popup-permission-resume",
    });
    return isPopupPermissionResume(response) ? response : null;
  } catch {
    return null;
  }
}

function restorePopupPermissionSelection(
  resume: PopupPermissionResume,
): boolean {
  if (
    !inspection ||
    tabId !== resume.tabId ||
    inspection.video.videoId !== resume.videoId
  ) {
    return rejectPopupPermissionResume("Source Video changed. Try again.");
  }
  const tracks = supportedCaptionTracks(inspection.video.tracks);
  if (!tracks.some((track) => track.id === resume.targetTrackId)) {
    return rejectPopupPermissionResume(
      "Caption Track changed. Choose another caption track.",
    );
  }
  targetTrack.value = resume.targetTrackId;
  populateTranslationTracks(tracks, resume.translationTrackId ?? "");
  if (
    resume.translationTrackId &&
    translationTrack.value !== resume.translationTrackId
  ) {
    return rejectPopupPermissionResume(
      "Caption Track changed. Choose another caption track.",
    );
  }
  return true;
}

function rejectPopupPermissionResume(message: string): false {
  showReadyActions();
  showStatus(message);
  return false;
}

async function openPackageInAnki(): Promise<void> {
  if (!packageDelivery.canOpen || downloadApkg.disabled) {
    return;
  }
  const actionWasDisabled = action.disabled;
  setPackageBusy(true);
  try {
    if (!packageDelivery.openPermissionsGranted) {
      progress.textContent = "Requesting permission…";
      const resume = await requestPopupPermissionResume("open-package");
      if (resume?.action === "open-package")
        await restorePackageOpening(resume);
      return;
    }
    const outcome = await packageDelivery.open();
    if (outcome === "accepted") {
      showStatus(PACKAGE_DELIVERY_STATUS.openAccepted);
    } else if (outcome === "missing") {
      showReadyActions();
      showStatus(PACKAGE_DELIVERY_STATUS.missing);
    } else if (outcome === "rejected") {
      resetPackageLabel();
      showStatus(PACKAGE_DELIVERY_STATUS.openRejected);
    } else if (outcome === "pending") {
      showStatus(PACKAGE_DELIVERY_STATUS.pending);
    }
  } finally {
    action.disabled = actionWasDisabled;
    setPackageBusy(false);
  }
}

async function restorePackageOpening(
  resume: Extract<PopupPermissionResume, { action: "open-package" }>,
): Promise<void> {
  if (!restorePopupPermissionSelection(resume)) return;
  const draft = await loadDraft(resume.videoId);
  if (JSON.stringify(draft) !== resume.package.draftFingerprint) {
    clearPackageDelivery();
    showReadyActions();
    showStatus(PACKAGE_DELIVERY_STATUS.invalidated);
    return;
  }
  packageDelivery.restore(resume.package);
  if (resume.granted) packageDelivery.markOpenPermissionsGranted();
  setPackageBusy(false);
  showStatus(
    resume.granted
      ? PACKAGE_DELIVERY_STATUS.openReady
      : PACKAGE_DELIVERY_STATUS.manual,
  );
}

function setPackageBusy(busy: boolean): void {
  targetTrack.disabled = busy;
  translationTrack.disabled = busy;
  if (busy) {
    action.disabled = true;
    downloadApkg.disabled = true;
    return;
  }
  if (actionLabel.textContent === "Editor Preview") {
    action.disabled = false;
  }
  downloadApkg.disabled = action.disabled;
  packageLabel.textContent = packageDelivery.canOpen
    ? "Open in Anki"
    : "Download .apkg";
}

function resetPackageLabel(): void {
  packageLabel.textContent = "Download .apkg";
}

function clearPackageDelivery(): void {
  packageDelivery.reset();
  resetPackageLabel();
}

async function prepareVideoPreview(): Promise<void> {
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
}

function preferredTrackId(
  tracks: CaptionTrack[],
  preferredLanguage: string | null | undefined,
): string | null {
  if (!preferredLanguage) {
    return null;
  }
  const exact = tracks.find(
    (track) =>
      track.languageCode.toLowerCase() === preferredLanguage.toLowerCase(),
  );
  if (exact) {
    return exact.id;
  }
  const preferredBase = baseLanguage(preferredLanguage);
  return (
    tracks.find((track) => baseLanguage(track.languageCode) === preferredBase)
      ?.id ?? null
  );
}

function trackOption(
  track: CaptionTrack,
  tracks: CaptionTrack[],
): HTMLOptionElement {
  const duplicates = tracks.filter(
    (candidate) => candidate.name === track.name,
  );
  const suffix =
    duplicates.length > 1 ? ` ${duplicates.indexOf(track) + 1}` : "";
  return new Option(`${track.name}${suffix}`, track.id);
}

function showState(label: string, disabled: boolean, message = ""): void {
  action.hidden = false;
  actionLabel.textContent = label;
  action
    .querySelector("svg")
    ?.toggleAttribute("hidden", label === "Open a YouTube video");
  action.disabled = disabled;
  // Capture failures, including the HTTP 429 message, arrive here. They have to
  // reach #progress too, because #status carries no live region of its own.
  status.textContent = message;
  status.hidden = !message;
  progress.textContent = message;
}

function showReadyActions(): void {
  if (captureRateLimited) {
    return;
  }
  showState("Editor Preview", false);
  downloadApkg.hidden = false;
  downloadApkg.disabled = false;
  packageLabel.textContent = "Download .apkg";
}

// Retires routine progress without erasing an outcome that was just announced.
function clearBusyAnnouncement(): void {
  if (BUSY_ANNOUNCEMENTS.has(progress.textContent ?? "")) {
    progress.textContent = "";
  }
}

function showStatus(message: string): void {
  status.textContent = message;
  status.hidden = false;
  // #progress is the popup's only live region. #status is hidden until it has
  // text, and a region absent from the accessibility tree does not announce
  // the message that reveals it, so it carries no role of its own.
  progress.textContent = message;
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
