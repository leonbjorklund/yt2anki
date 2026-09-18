import type { Draft } from "../domain/types.ts";
import { StaleDraftError, saveDraft } from "../storage.ts";

interface DraftAutosaveOptions {
  draft: Draft;
  isWritable: () => boolean;
  onFailure: () => void;
  onSaved: () => void;
  onSaving: () => void;
  onStale: (error: StaleDraftError) => void;
}

export interface DraftAutosave {
  flush: () => Promise<void>;
  queue: () => void;
}

export function createDraftAutosave({
  draft,
  isWritable,
  onFailure,
  onSaved,
  onSaving,
  onStale,
}: DraftAutosaveOptions): DraftAutosave {
  let timer: number | null = null;
  let pendingSave: Promise<void> | null = null;

  function queue(): void {
    if (!isWritable()) {
      return;
    }
    onSaving();
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      if (!isWritable()) {
        return;
      }
      const pending = (pendingSave ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => saveDraft(draft));
      pendingSave = pending;
      void pending
        .then(() => {
          if (pendingSave === pending && timer === null) {
            onSaved();
          }
        })
        .catch((error: unknown) => {
          if (error instanceof StaleDraftError) {
            onStale(error);
          } else {
            onFailure();
          }
        })
        .finally(() => {
          if (pendingSave === pending) {
            pendingSave = null;
          }
        });
    }, 300);
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await pendingSave;
    await saveDraft(draft);
    onSaved();
  }

  return { flush, queue };
}
