import {
  EXPORT_RECOVERY_KEY,
  isFreshExportRecovery,
} from "../export-recovery.ts";
import { isFreshPopupRecovery, POPUP_RECOVERY_KEY } from "../popup-recovery.ts";
import { loadDraft } from "../storage.ts";

export async function reopenPendingExport(): Promise<void> {
  const stored = await chrome.storage.local.get(EXPORT_RECOVERY_KEY);
  await chrome.storage.local.remove(EXPORT_RECOVERY_KEY);
  const recovery = stored[EXPORT_RECOVERY_KEY];
  if (!isFreshExportRecovery(recovery)) {
    return;
  }
  const draft = await loadDraft(recovery.videoId);
  if (draft?.generationId !== recovery.generationId) {
    return;
  }
  const url = new URL(chrome.runtime.getURL("editor/editor.html"));
  url.searchParams.set("video", recovery.videoId);
  url.searchParams.set("resumeExport", recovery.action);
  url.searchParams.set("generation", recovery.generationId);
  await chrome.tabs.create({ url: url.href });
}

export async function reopenPendingPopup(): Promise<void> {
  const stored = await chrome.storage.local.get(POPUP_RECOVERY_KEY);
  await chrome.storage.local.remove(POPUP_RECOVERY_KEY);
  if (!isFreshPopupRecovery(stored[POPUP_RECOVERY_KEY])) {
    return;
  }
  await chrome.action.openPopup();
}
