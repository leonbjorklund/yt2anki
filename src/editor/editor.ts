import { chineseSegmentField } from "../domain/language.ts";
import type { Draft } from "../domain/types.ts";
import type { ExportAction } from "../export-recovery.ts";
import { loadDraft, type StaleDraftError } from "../storage.ts";
import { createDraftAutosave, type DraftAutosave } from "./draft-autosave.ts";
import {
  createExportController,
  type EditorLifecycle,
  type ExportController,
} from "./export-controller.ts";
import { createPreviewController } from "./preview.ts";
import { createSegmentEditor, shortTrackName } from "./segments.ts";

const title = element<HTMLHeadingElement>("video-title");
const editor = element<HTMLElement>("editor");
const fatalError = element<HTMLParagraphElement>("fatal-error");
const saveState = element<HTMLSpanElement>("save-state");
const draftStatus = element<HTMLParagraphElement>("draft-status");
const selectionSummary = element<HTMLElement>("selection-summary");
const pinyinStatus = element<HTMLElement>("pinyin-status");
const segmentList = element<HTMLTableSectionElement>("segment-list");
const bulkSelection = element<HTMLInputElement>("select-all");
const pinyinHeading = element<HTMLTableCellElement>("pinyin-heading");
const targetHeading = element<HTMLElement>("target-heading-label");
const translationHeading = element<HTMLElement>("translation-heading-label");
const previewFrame = element<HTMLIFrameElement>("preview");
const previewControls = element<HTMLElement>("preview-controls");
const previewTime = element<HTMLSpanElement>("preview-time");
const replay = element<HTMLButtonElement>("replay");
const previewTarget = element<HTMLTextAreaElement>("preview-target");
const previewPinyinField = element<HTMLElement>("preview-pinyin-field");
const previewPinyin = element<HTMLTextAreaElement>("preview-pinyin");
const previewTranslation = element<HTMLTextAreaElement>("preview-translation");
const generatePinyin = element<HTMLButtonElement>("generate-pinyin");
const packageActionLabel = element<HTMLElement>("package-action-label");
const exportStatus = element<HTMLParagraphElement>("export-status");
const downloadButton = element<HTMLButtonElement>("download-apkg");
const RESUME_EXPORT_PARAM = "resumeExport";
const RECOVERY_GENERATION_PARAM = "generation";

void initialize();

async function initialize(): Promise<void> {
  const videoId = new URL(location.href).searchParams.get("video") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    showFatal("This editor URL does not identify a valid Source Video.");
    return;
  }
  const draft = await loadDraft(videoId);
  if (!draft) {
    showFatal("This Draft no longer exists.");
    return;
  }

  const resumeExportAction = takeResumeExportAction(draft);
  title.textContent = draft.video.title;
  targetHeading.textContent = shortTrackName(draft.targetTrack.name);
  translationHeading.textContent = draft.translationTrack
    ? shortTrackName(draft.translationTrack.name)
    : "Track two";
  element<HTMLElement>("preview-target-label").textContent =
    targetHeading.textContent;
  element<HTMLElement>("preview-translation-label").textContent =
    translationHeading.textContent;
  const pinyinSource = chineseSegmentField(
    draft.targetTrack,
    draft.translationTrack,
  );
  if (pinyinSource === "translation") {
    translationHeading.parentElement?.append(generatePinyin);
  }
  title.title = draft.video.title;
  document.title = `${draft.video.title} — yt2anki`;

  const lifecycle: EditorLifecycle = {
    mode: "editable",
  };
  const preview = createPreviewController({
    controls: previewControls,
    frame: previewFrame,
    replay,
    time: previewTime,
    videoId: draft.video.videoId,
  });
  preview.showInitial();

  let autosave: DraftAutosave;
  let exporter: ExportController;
  const segments = createSegmentEditor({
    bulkSelection,
    draft,
    generatePinyin,
    list: segmentList,
    onChange: () => {
      exporter.onDraftChanged();
      autosave.queue();
    },
    onPreview: preview.play,
    onSelect: preview.select,
    pinyinHeading,
    pinyinStatus,
    previewPinyin,
    previewPinyinField,
    previewTarget,
    previewTranslation,
    summary: selectionSummary,
    translationHeading: element<HTMLTableCellElement>("translation-heading"),
  });

  function markDraftStale(error: StaleDraftError): void {
    if (lifecycle.mode === "stale") {
      return;
    }
    lifecycle.mode = "stale";
    saveState.textContent = "";
    showDraftProblem(error.message);
    disableAllEditorControls();
  }

  autosave = createDraftAutosave({
    draft,
    isWritable: () => lifecycle.mode === "editable",
    onFailure: () => {
      saveState.textContent = "";
      showDraftProblem(
        "Draft could not be saved. Your latest changes may be lost if you close this editor.",
      );
    },
    onSaved: () => {
      saveState.textContent = "";
      if (lifecycle.mode === "editable") {
        clearDraftProblem();
      }
    },
    onSaving: () => {
      saveState.textContent = "Saving…";
    },
    onStale: markDraftStale,
  });

  exporter = createExportController({
    autosave,
    backgroundReloadAttempted: resumeExportAction !== null,
    draft,
    elements: {
      packageActionLabel,
      download: downloadButton,
      exportStatus,
      exportProgress: element<HTMLElement>("export-progress"),
    },
    lifecycle,
    onStale: markDraftStale,
    selectedSegments: segments.selectedSegments,
    setEditingDisabled: (disabled) => {
      segments.setDisabled(disabled);
      preview.disable(disabled);
    },
  });

  segments.render();
  await exporter.initialize();
  saveState.textContent = "";
  editor.hidden = false;
  if (resumeExportAction) {
    await exporter.resume();
  }
}

function showDraftProblem(message: string): void {
  draftStatus.textContent = message;
  draftStatus.hidden = false;
}

function clearDraftProblem(): void {
  draftStatus.textContent = "";
  draftStatus.hidden = true;
}

function disableAllEditorControls(): void {
  segmentList.inert = true;
  for (const control of editor.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
  >("button, input, textarea")) {
    control.disabled = true;
  }
}

function takeResumeExportAction(draft: Draft): ExportAction | null {
  const url = new URL(location.href);
  const action = url.searchParams.get(RESUME_EXPORT_PARAM);
  const generationId = url.searchParams.get(RECOVERY_GENERATION_PARAM);
  url.searchParams.delete(RESUME_EXPORT_PARAM);
  url.searchParams.delete(RECOVERY_GENERATION_PARAM);
  history.replaceState(null, "", url);
  return generationId === draft.generationId && action === "apkg"
    ? action
    : null;
}

function showFatal(message: string): void {
  // #video-title lives inside the still-hidden editor, so the page has no
  // heading here. The tab title is the only place the state can be named.
  document.title = "Draft unavailable - yt2anki";
  fatalError.textContent = message;
  fatalError.hidden = false;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}
