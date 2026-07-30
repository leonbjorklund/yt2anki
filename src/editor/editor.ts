import {
  AnkiConnectKeyRejectedError,
  AnkiConnectKeyRequiredError,
  AnkiConnectPartialError,
  sendDraftToAnki,
} from "../anki/connect.ts";
import { buildApkg, downloadApkg } from "../anki/apkg.ts";
import {
  resolveVideoDeckName,
} from "../domain/deck.ts";
import type { Draft, Segment } from "../domain/types.ts";
import { translateMissingSegments } from "../gemini.ts";
import {
  forgetAnkiConnectKey,
  forgetGeminiKey,
  getAnkiConnectKey,
  getDeckOwners,
  getDraft,
  getGeminiKey,
  rememberDeckOwner,
  removeDraft,
  saveAnkiConnectKey,
  saveDraft,
  saveGeminiKey,
} from "../storage.ts";

const title = element<HTMLHeadingElement>("video-title");
const languagePair = element<HTMLSpanElement>("language-pair");
const editor = element<HTMLElement>("editor");
const fatalError = element<HTMLParagraphElement>("fatal-error");
const saveState = element<HTMLSpanElement>("save-state");
const selectionSummary =
  element<HTMLElement>("selection-summary");
const segmentList = element<HTMLDivElement>("segment-list");
const preview = element<HTMLIFrameElement>("preview");
const previewTime = element<HTMLSpanElement>("preview-time");
const replay = element<HTMLButtonElement>("replay");
const selectAll = element<HTMLButtonElement>("select-all");
const clearSelection =
  element<HTMLButtonElement>("clear-selection");
const discard = element<HTMLButtonElement>("discard");
const discardDialog =
  element<HTMLDialogElement>("discard-dialog");
const confirmDiscard =
  element<HTMLButtonElement>("confirm-discard");
const geminiPanel =
  element<HTMLElement>("gemini-panel");
const geminiKey = element<HTMLInputElement>("gemini-key");
const translate = element<HTMLButtonElement>("translate");
const forgetGemini =
  element<HTMLButtonElement>("forget-gemini");
const translationStatus =
  element<HTMLParagraphElement>("translation-status");
const ankiKeyPanel =
  element<HTMLElement>("anki-key-panel");
const ankiKey = element<HTMLInputElement>("anki-key");
const saveAnkiKey = element<HTMLButtonElement>("save-anki-key");
const forgetAnki = element<HTMLButtonElement>("forget-anki");
const exportStatus =
  element<HTMLParagraphElement>("export-status");
const sendAnki = element<HTMLButtonElement>("send-anki");
const downloadButton =
  element<HTMLButtonElement>("download-apkg");

let draft: Draft;
let activeIndex = 0;
let saveTimer: number | null = null;
let savePromise: Promise<void> | null = null;
let exported = false;

void initialize();

async function initialize(): Promise<void> {
  const videoId = new URL(location.href).searchParams.get("video") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    showFatal("This editor URL does not identify a valid Source Video.");
    return;
  }

  const loaded = await getDraft(videoId);
  if (!loaded || loaded.version !== 1) {
    showFatal("This Draft no longer exists.");
    return;
  }
  draft = loaded;
  title.textContent = draft.video.title;
  languagePair.textContent =
    `${draft.targetTrack.name} → ${draft.nativeTrack?.name ?? "No native captions"}`;
  document.title = `${draft.video.title} — yt2anki`;
  renderSegments();
  renderChecks();
  await renderKeyState();
  const savedIndex = draft.segments.findIndex(
    (segment) => segment.identity === draft.activeSegmentIdentity,
  );
  setActiveSegment(savedIndex >= 0 ? savedIndex : 0, false, false);
  updateSummary();
  updateExportState();
  saveState.textContent = "Saved";
  editor.hidden = false;
  bindEvents();
}

function bindEvents(): void {
  segmentList.addEventListener("click", (event) => {
    const target = event.target as Element;
    const row = target.closest<HTMLElement>(".segment-row");
    if (row) {
      const index = Number(row.dataset.index);
      if (index !== activeIndex || target.closest(".cue-button")) {
        setActiveSegment(index, true);
      }
    }
  });
  segmentList.addEventListener("input", (event) => {
    const input = event.target as HTMLTextAreaElement;
    const index = Number(input.dataset.index);
    const segment = draft.segments[index];
    if (!segment) {
      return;
    }
    if (input.dataset.field === "target") {
      segment.target = input.value;
    } else if (input.dataset.field === "translation") {
      segment.translation = input.value;
      if (input.value.trim()) {
        segment.alignmentQuality = "matched";
      }
    }
    updateRow(index);
    updateGeminiPanel();
    updateExportState();
    queueSave();
  });
  segmentList.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== "checkbox") {
      return;
    }
    const index = Number(input.dataset.index);
    const segment = draft.segments[index];
    if (segment) {
      segment.selected = input.checked;
      updateRow(index);
      updateSummary();
      updateExportState();
      queueSave();
    }
  });
  replay.addEventListener("click", () => setActiveSegment(activeIndex, false));
  selectAll.addEventListener("click", () => {
    for (const segment of draft.segments) {
      segment.selected = hasRequiredText(segment);
    }
    renderSelection();
  });
  clearSelection.addEventListener("click", () => {
    for (const segment of draft.segments) {
      segment.selected = false;
    }
    renderSelection();
  });
  discard.addEventListener("click", () => discardDialog.showModal());
  confirmDiscard.addEventListener("click", () => void discardCurrentDraft());
  translate.addEventListener("click", () => void runTranslation());
  forgetGemini.addEventListener("click", () => void forgetGeminiSecret());
  forgetAnki.addEventListener("click", () => void forgetAnkiSecret());
  saveAnkiKey.addEventListener("click", () => void exportToAnki());
  ankiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void exportToAnki();
    }
  });
  sendAnki.addEventListener("click", () => void exportToAnki());
  downloadButton.addEventListener("click", () => void exportApkg());
}

function renderSegments(): void {
  const fragment = document.createDocumentFragment();
  draft.segments.forEach((segment, index) => {
    const row = document.createElement("article");
    row.className = "segment-row";
    row.dataset.index = index.toString();

    const heading = document.createElement("div");
    heading.className = "segment-heading";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = segment.selected;
    checkbox.dataset.index = index.toString();
    checkbox.setAttribute("aria-label", `Select Segment ${index + 1}`);

    const cue = document.createElement("button");
    cue.className = "cue-button";
    cue.type = "button";
    cue.dataset.index = index.toString();
    cue.textContent = `${String(index + 1).padStart(3, "0")}  ${formatRange(segment)}`;

    const rowStatus = document.createElement("span");
    rowStatus.className = "row-status";
    rowStatus.dataset.role = "status";

    heading.append(checkbox, cue, rowStatus);
    row.append(
      heading,
      textField("Target", "target", segment.target, index),
      textField(
        "Translation",
        "translation",
        segment.translation,
        index,
      ),
    );
    fragment.append(row);
  });
  segmentList.replaceChildren(fragment);
  draft.segments.forEach((_segment, index) => updateRow(index));
}

function textField(
  labelText: string,
  field: "target" | "translation",
  value: string,
  index: number,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field-label";
  const text = document.createElement("span");
  text.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.dataset.field = field;
  textarea.dataset.index = index.toString();
  textarea.value = value;
  textarea.rows = 2;
  label.append(text, textarea);
  return label;
}

function updateRow(index: number): void {
  const segment = draft.segments[index];
  const row = rowAt(index);
  if (!segment || !row) {
    return;
  }
  row.classList.toggle("invalid", segment.selected && !hasRequiredText(segment));
  const status = row.querySelector<HTMLElement>('[data-role="status"]');
  if (status) {
    status.textContent = rowStatusText(segment);
  }
}

function setActiveSegment(
  index: number,
  scroll: boolean,
  saveChange = true,
): void {
  const segment = draft.segments[index];
  if (!segment) {
    return;
  }
  rowAt(activeIndex)?.classList.remove("active");
  activeIndex = index;
  const row = rowAt(activeIndex);
  row?.classList.add("active");
  if (scroll) {
    row?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "nearest",
    });
  }

  const params = new URLSearchParams({
    autoplay: "1",
    controls: "1",
    end: Math.ceil(segment.endMs / 1_000).toString(),
    playsinline: "1",
    rel: "0",
    start: Math.floor(segment.startMs / 1_000).toString(),
  });
  preview.src =
    `https://www.youtube.com/embed/${draft.video.videoId}?${params.toString()}`;
  previewTime.textContent = formatRange(segment);
  if (draft.activeSegmentIdentity !== segment.identity) {
    draft.activeSegmentIdentity = segment.identity;
    if (saveChange) {
      queueSave();
    }
  }
}

function updateSummary(): void {
  const selected = selectedSegments().length;
  selectionSummary.textContent =
    `${draft.segments.length} Segments · ${selected} selected`;
}

function renderSelection(): void {
  draft.segments.forEach((segment, index) => {
    const checkbox = rowAt(index)?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (checkbox) {
      checkbox.checked = segment.selected;
    }
    updateRow(index);
  });
  updateSummary();
  updateExportState();
  queueSave();
}

function renderChecks(): void {
  setCheck("check-captions", Boolean(draft.targetTrack));
  setCheck("check-embeddable", draft.video.compatibility.embeddable);
  setCheck("check-vp9", draft.video.compatibility.hasVp9);
  setCheck("check-opus", draft.video.compatibility.hasOpus);
}

async function renderKeyState(): Promise<void> {
  const [storedGemini, storedAnki] = await Promise.all([
    getGeminiKey(),
    getAnkiConnectKey(),
  ]);
  geminiKey.placeholder = storedGemini ? "Stored key" : "";
  forgetGemini.hidden = !storedGemini;
  ankiKey.placeholder = storedAnki ? "Stored key" : "";
  forgetAnki.hidden = !storedAnki;
  ankiKeyPanel.hidden = true;
  updateGeminiPanel();
}

function updateExportState(preserveStatus = false): void {
  const selected = selectedSegments();
  const compatible =
    draft.video.compatibility.embeddable &&
    draft.video.compatibility.hasVp9 &&
    draft.video.compatibility.hasOpus;
  const valid =
    !exported &&
    compatible &&
    selected.length > 0 &&
    selected.every(hasRequiredText);
  sendAnki.disabled = !valid;
  downloadButton.disabled = !valid;

  if (exported) {
    return;
  }
  if (preserveStatus) {
    return;
  }
  if (!compatible) {
    exportStatus.textContent =
      "Export is blocked because this video failed a playback check.";
  } else if (selected.length === 0) {
    exportStatus.textContent = "Select at least one Segment.";
  } else if (selected.some((segment) => !hasRequiredText(segment))) {
    exportStatus.textContent =
      "Every selected Segment needs Target and Translation text.";
  } else {
    exportStatus.textContent = "";
  }
}

async function runTranslation(): Promise<void> {
  const typed = geminiKey.value.trim();
  let key = typed || (await getGeminiKey());
  if (!key) {
    translationStatus.textContent = "Enter a Gemini API key.";
    return;
  }
  if (typed) {
    await saveGeminiKey(typed);
    geminiKey.value = "";
    geminiKey.placeholder = "Stored key";
    forgetGemini.hidden = false;
    key = typed;
  }

  translate.disabled = true;
  translationStatus.textContent = "Translating…";
  try {
    await translateMissingSegments({
      apiKey: key,
      nativeLocale: draft.nativeLocale,
      onBatch: async (translations) => {
        for (const item of translations) {
          const index = draft.segments.findIndex(
            (segment) => segment.identity === item.id,
          );
          const segment = draft.segments[index];
          if (!segment) {
            continue;
          }
          segment.translation = item.translation;
          segment.alignmentQuality = "matched";
          const textarea = rowAt(index)?.querySelector<HTMLTextAreaElement>(
            'textarea[data-field="translation"]',
          );
          if (textarea) {
            textarea.value = item.translation;
          }
          updateRow(index);
        }
        await saveDraft(draft);
        saveState.textContent = "Saved";
        updateExportState();
      },
      segments: draft.segments,
      targetLocale: draft.targetLocale,
    });
    translationStatus.textContent = "Translations complete.";
    updateGeminiPanel();
  } catch (error) {
    translationStatus.textContent =
      error instanceof Error ? error.message : "Translation failed.";
  } finally {
    translate.disabled = false;
  }
}

async function exportToAnki(): Promise<void> {
  if (sendAnki.disabled) {
    return;
  }
  setExportBusy(true, "Sending to Anki…");
  try {
    const typedKey = ankiKey.value.trim();
    if (typedKey) {
      await saveAnkiConnectKey(typedKey);
      ankiKey.value = "";
      ankiKey.placeholder = "Stored key";
      forgetAnki.hidden = false;
    }
    const deckName = await resolveCurrentDeckName();
    const result = await sendDraftToAnki({
      apiKey: typedKey || (await getAnkiConnectKey()),
      deckName,
      draft,
      segments: selectedSegments(),
    });
    await completeExport(
      deckName,
      `${result.added} added, ${result.existing} already existed.`,
    );
  } catch (error) {
    if (
      error instanceof AnkiConnectKeyRequiredError ||
      error instanceof AnkiConnectKeyRejectedError
    ) {
      showAnkiKeyPrompt(
        "Enter the API key configured in AnkiConnect, then try again.",
      );
    } else if (error instanceof AnkiConnectPartialError) {
      exportStatus.textContent =
        `${error.added} added before AnkiConnect stopped. The Draft was kept.`;
    } else {
      exportStatus.textContent =
        error instanceof Error ? error.message : "Anki export failed.";
    }
  } finally {
    if (!exported) {
      setExportBusy(false);
    }
  }
}

async function exportApkg(): Promise<void> {
  setExportBusy(true, "Building package…");
  try {
    const deckName = await resolveCurrentDeckName();
    const bytes = await buildApkg({
      deckName,
      draft,
      segments: selectedSegments(),
    });
    downloadApkg(bytes, draft);
    await completeExport(deckName, "Package downloaded.");
  } catch (error) {
    exportStatus.textContent =
      error instanceof Error ? error.message : "Package export failed.";
  } finally {
    if (!exported) {
      setExportBusy(false);
    }
  }
}

async function completeExport(
  deckName: string,
  message: string,
): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  exported = true;
  await savePromise?.catch(() => undefined);
  try {
    await rememberDeckOwner(deckName, draft.video.videoId);
    await removeDraft(draft.video.videoId);
  } catch (error) {
    exported = false;
    throw error;
  }
  exportStatus.textContent = message;
  sendAnki.disabled = true;
  downloadButton.disabled = true;
  discard.disabled = true;
  saveState.textContent = "Exported";
}

function setExportBusy(busy: boolean, message = ""): void {
  segmentList.inert = busy;
  for (const control of [
    selectAll,
    clearSelection,
    discard,
    translate,
    geminiKey,
    forgetGemini,
    ankiKey,
    saveAnkiKey,
    forgetAnki,
  ]) {
    control.disabled = busy;
  }
  sendAnki.disabled = busy;
  downloadButton.disabled = busy;
  if (message) {
    exportStatus.textContent = message;
  }
  if (!busy) {
    updateExportState(true);
  }
}

function queueSave(): void {
  if (exported) {
    return;
  }
  saveState.textContent = "Saving…";
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(async () => {
    saveTimer = null;
    if (exported) {
      return;
    }
    const pending = (savePromise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => saveDraft(draft));
    savePromise = pending;
    try {
      await pending;
      if (savePromise === pending && saveTimer === null) {
        saveState.textContent = "Saved";
      }
    } catch {
      saveState.textContent = "Save failed";
    } finally {
      if (savePromise === pending) {
        savePromise = null;
      }
    }
  }, 300);
}

async function discardCurrentDraft(): Promise<void> {
  await removeDraft(draft.video.videoId);
  try {
    await chrome.tabs.update(draft.sourceTabId, { active: true });
  } catch {
    // The Source Video tab may have been closed.
  }
  window.close();
}

async function forgetGeminiSecret(): Promise<void> {
  await forgetGeminiKey();
  geminiKey.value = "";
  geminiKey.placeholder = "";
  forgetGemini.hidden = true;
  translationStatus.textContent = "Gemini key removed.";
  updateGeminiPanel();
}

function showAnkiKeyPrompt(message: string): void {
  ankiKeyPanel.hidden = false;
  saveAnkiKey.hidden = false;
  exportStatus.textContent = message;
  requestAnimationFrame(() => {
    ankiKey.scrollIntoView({ block: "center" });
    ankiKey.focus();
  });
}

async function forgetAnkiSecret(): Promise<void> {
  await forgetAnkiConnectKey();
  ankiKey.value = "";
  ankiKey.placeholder = "";
  forgetAnki.hidden = true;
  ankiKeyPanel.hidden = true;
  saveAnkiKey.hidden = true;
  exportStatus.textContent = "AnkiConnect key removed.";
}

async function resolveCurrentDeckName(): Promise<string> {
  return resolveVideoDeckName(
    draft.video.title,
    draft.video.videoId,
    await getDeckOwners(),
  );
}

function selectedSegments(): Segment[] {
  return draft.segments.filter((segment) => segment.selected);
}

function hasRequiredText(segment: Segment): boolean {
  return Boolean(segment.target.trim() && segment.translation.trim());
}

function updateGeminiPanel(): void {
  const needsTranslation = draft.segments.some(
    (segment) => !segment.translation.trim(),
  );
  geminiPanel.hidden =
    Boolean(draft.nativeTrack) ||
    (!needsTranslation && forgetGemini.hidden);
}

function rowStatusText(segment: Segment): string {
  if (!hasRequiredText(segment)) {
    return "Needs text";
  }
  if (segment.alignmentQuality === "weak") {
    return "Check alignment";
  }
  return "";
}

function rowAt(index: number): HTMLElement | null {
  return segmentList.querySelector(`[data-index="${index}"].segment-row`);
}

function setCheck(id: string, pass: boolean): void {
  element<HTMLElement>(id).classList.toggle("pass", pass);
}

function formatRange(segment: Segment): string {
  return `${formatTime(segment.startMs)}–${formatTime(segment.endMs)}`;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function showFatal(message: string): void {
  title.textContent = "Draft unavailable";
  fatalError.textContent = message;
  fatalError.hidden = false;
  discard.hidden = true;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}
