import { buildApkg } from "../anki/apkg.ts";
import { PLAYBACK_FAILURE_MESSAGE } from "../anki/export-validation.ts";
import {
  PACKAGE_BUSY_LABEL,
  PACKAGE_DELIVERY_STATUS,
  PACKAGE_OPEN_PERMISSIONS,
  PackageDelivery,
} from "../anki/package-download.ts";
import type { Draft, Segment, SourceVideo } from "../domain/types.ts";
import {
  EXPORT_RECOVERY_KEY,
  type ExportRecovery,
} from "../export-recovery.ts";
import type { AppResponse } from "../messages.ts";
import {
  loadDraft,
  reserveVideoDeckName,
  StaleDraftError,
  withCurrentDraft,
} from "../storage.ts";
import type { DraftAutosave } from "./draft-autosave.ts";
import { hasTargetText, shortTrackName } from "./segments.ts";

export interface EditorLifecycle {
  mode: "editable" | "stale";
}

interface ExportElements {
  packageActionLabel: HTMLElement;
  download: HTMLButtonElement;
  exportStatus: HTMLElement;
  exportProgress: HTMLElement;
}

interface ExportControllerOptions {
  autosave: DraftAutosave;
  backgroundReloadAttempted: boolean;
  draft: Draft;
  elements: ExportElements;
  lifecycle: EditorLifecycle;
  onStale: (error: StaleDraftError) => void;
  selectedSegments: () => Segment[];
  setEditingDisabled: (disabled: boolean) => void;
}

export interface ExportController {
  initialize: () => Promise<void>;
  onDraftChanged: () => void;
  resume: () => Promise<void>;
}

export function createExportController({
  autosave,
  backgroundReloadAttempted: initialReloadAttempted,
  draft,
  elements,
  lifecycle,
  onStale,
  selectedSegments,
  setEditingDisabled,
}: ExportControllerOptions): ExportController {
  let backgroundReloadAttempted = initialReloadAttempted;
  const packageDelivery = new PackageDelivery();
  const targetName = shortTrackName(draft.targetTrack.name);
  let busy = false;

  async function initialize(): Promise<void> {
    elements.download.addEventListener("click", () => {
      void (packageDelivery.canOpen ? openPackageInAnki() : exportApkg());
    });
    chrome.storage.onChanged.addListener(onStoredDraftChanged);
    updateState();
  }

  function updateState(preserveStatus = false): void {
    const selected = selectedSegments();
    const incomplete = draft.segments.filter(
      (segment) => !hasTargetText(segment),
    );
    const incompleteSelected = selected.filter(
      (segment) => !hasTargetText(segment),
    );
    const valid =
      lifecycle.mode === "editable" &&
      selected.length > 0 &&
      incompleteSelected.length === 0;
    elements.download.disabled = busy || !valid;
    elements.packageActionLabel.textContent = packageDelivery.canOpen
      ? "Open in Anki"
      : "Download .apkg";

    if (lifecycle.mode !== "editable") {
      return;
    }
    if (preserveStatus) {
      return;
    }
    if (packageDelivery.needsFreshPackage) {
      showExportStatus(PACKAGE_DELIVERY_STATUS.invalidated);
      return;
    }
    if (selected.length === 0) {
      showExportStatus("Select at least one Segment.");
    } else if (incompleteSelected.length > 0) {
      showExportStatus(
        incompleteSelected.length === 1
          ? `1 selected Segment needs ${targetName} text.`
          : `${incompleteSelected.length} selected Segments need ${targetName} text.`,
      );
    } else if (incomplete.length > 0) {
      showExportStatus(
        incomplete.length === 1
          ? `1 Segment without ${targetName} text is not selected.`
          : `${incomplete.length} Segments without ${targetName} text are not selected.`,
      );
    } else {
      showExportStatus("");
    }
  }

  async function exportApkg(): Promise<void> {
    if (elements.download.disabled) {
      return;
    }
    resetPackageLabel();
    setBusy(true, "Building package…", PACKAGE_BUSY_LABEL.building);
    try {
      const delivery = await packageDelivery.run({
        build: async (currentDraft) => {
          await refreshPlaybackCompatibility();
          return withCurrentDraft(currentDraft, async () =>
            buildApkg({
              deckName: await reserveVideoDeckName(
                draft.video.title,
                draft.video.videoId,
              ),
              draft: currentDraft,
              segments: selectedSegments(),
            }),
          );
        },
        prepareDraft: async () => {
          await autosave.flush();
          return draft;
        },
      });
      if (delivery === "cancelled" || delivery === "superseded") {
        // Nothing to announce, so clear the busy text rather than leaving the
        // live region stuck on "Building package…".
        elements.exportProgress.textContent = "";
        return;
      }

      showExportStatus(PACKAGE_DELIVERY_STATUS[delivery]);
    } catch (error) {
      if (error instanceof StaleDraftError) {
        onStale(error);
      } else {
        showExportStatus(
          error instanceof Error ? error.message : "Package export failed.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function openPackageInAnki(): Promise<void> {
    if (!packageDelivery.canOpen || elements.download.disabled) {
      return;
    }
    setBusy(true);
    try {
      if (!packageDelivery.openPermissionsGranted) {
        elements.exportProgress.textContent = "Requesting permission…";
        const snapshot = packageDelivery.snapshot();
        const granted = await chrome.permissions
          .request(PACKAGE_OPEN_PERMISSIONS)
          .catch(() => false);
        if (packageDelivery.snapshot()?.downloadUrl !== snapshot?.downloadUrl)
          return;
        if (granted) packageDelivery.markOpenPermissionsGranted();
        showExportStatus(
          granted
            ? PACKAGE_DELIVERY_STATUS.openReady
            : PACKAGE_DELIVERY_STATUS.manual,
        );
        return;
      }
      const outcome = await packageDelivery.open();
      if (outcome === "accepted") {
        showExportStatus(PACKAGE_DELIVERY_STATUS.openAccepted);
      } else if (outcome === "missing") {
        resetPackageLabel();
        showExportStatus(PACKAGE_DELIVERY_STATUS.missing);
      } else if (outcome === "rejected") {
        resetPackageLabel();
        showExportStatus(PACKAGE_DELIVERY_STATUS.openRejected);
      } else if (outcome === "pending") {
        showExportStatus(PACKAGE_DELIVERY_STATUS.pending);
      }
    } finally {
      setBusy(false);
    }
  }

  function onDraftChanged(): void {
    packageDelivery.invalidateForUserChange();
    updateState();
  }

  // #export-progress is the export live region, alongside #save-state and
  // #pinyin-status for their own concerns. #export-status collapses while
  // empty, and a region absent from the accessibility tree does not announce
  // the text that brings it back, so it carries no role of its own.
  function showExportStatus(message: string): void {
    elements.exportStatus.textContent = message;
    elements.exportProgress.textContent = message;
  }

  function resetPackageLabel(): void {
    elements.packageActionLabel.textContent = "Download .apkg";
  }

  async function onStoredDraftChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): Promise<void> {
    const changed = changes[`draft:${draft.video.videoId}`];
    if (areaName !== "local" || !changed) {
      return;
    }
    const current = await loadDraft(draft.video.videoId);
    if (current?.generationId !== draft.generationId) {
      packageDelivery.reset();
      resetPackageLabel();
      showExportStatus("");
      onStale(new StaleDraftError());
      return;
    }
    if (packageDelivery.invalidateForDraftChange(current)) {
      resetPackageLabel();
      showExportStatus(PACKAGE_DELIVERY_STATUS.invalidated);
    }
  }

  async function refreshPlaybackCompatibility(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      tabId: draft.sourceTabId,
      type: "preflight",
      videoId: draft.video.videoId,
    })) as AppResponse<SourceVideo>;
    if (!response.ok) {
      if (response.error.code === "INVALID_REQUEST") {
        if (!backgroundReloadAttempted) {
          backgroundReloadAttempted = true;
          await reloadExtensionForExport();
          await new Promise<never>(() => undefined);
        }
        throw new Error(
          "yt2anki could not refresh its background process. Reopen the editor and try again.",
        );
      }
      throw new Error(response.error.message);
    }
    draft.video.compatibility = response.data.compatibility;
    if (!Object.values(draft.video.compatibility).every(Boolean)) {
      throw new Error(PLAYBACK_FAILURE_MESSAGE);
    }
  }

  async function reloadExtensionForExport(): Promise<void> {
    const recovery: ExportRecovery = {
      action: "apkg",
      generationId: draft.generationId,
      requestedAt: Date.now(),
      videoId: draft.video.videoId,
    };
    await chrome.storage.local.set({ [EXPORT_RECOVERY_KEY]: recovery });
    chrome.runtime.reload();
  }

  // The announcement stays descriptive; the button label has to fit the fixed
  // package-button width, which the spoken form overflows.
  function setBusy(value: boolean, message = "", label = message): void {
    busy = value;
    setEditingDisabled(busy || lifecycle.mode === "stale");
    // Leaving busy must not clear the live region: the caller has already
    // announced the outcome there, and wiping it in the same task can swallow
    // the announcement before a screen reader reads it.
    if (message) {
      elements.exportStatus.textContent = "";
      elements.exportProgress.textContent = message;
    }
    updateState(true);
    if (busy && message) elements.packageActionLabel.textContent = label;
  }

  return {
    initialize,
    onDraftChanged,
    resume: () => exportApkg(),
  };
}
