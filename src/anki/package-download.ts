import { packageFilename } from "../domain/deck.ts";
import type { Draft } from "../domain/types.ts";

export const PACKAGE_OPEN_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ["downloads", "downloads.open"],
};

const DOWNLOAD_CREATION_TIMEOUT_MS = 10_000;

export const PACKAGE_DELIVERY_STATUS = {
  completed: "Package downloaded. Draft kept.",
  started: "Package download started. Draft kept.",
  openReady: "Permission granted. Click Open in Anki.",
  pending:
    "Package download has not finished. Try Open in Anki again when it finishes.",
  interrupted: "Package download did not finish. Draft kept.",
  invalidated: "Draft changed. Download a new .apkg before opening it in Anki.",
  manual:
    "Package download started. Draft kept. Open the .apkg from Chrome Downloads or File Explorer.",
  missing: "Downloaded package is missing. Download a new .apkg.",
  openAccepted: "Open request sent. Confirm the import in Anki.",
  openRejected:
    "Could not open the downloaded package. Open it from Chrome Downloads or File Explorer.",
} as const;

// Shown inside the fixed-width package button, which the spoken announcements
// above overflow. The popup and the editor share the button, so share these.
export const PACKAGE_BUSY_LABEL = {
  building: "Building…",
  capturing: "Capturing…",
} as const;

export type PackageDeliveryOutcome =
  | "cancelled"
  | "completed"
  | "interrupted"
  | "started"
  | "superseded";

export type PackageOpenOutcome =
  | "accepted"
  | "missing"
  | "pending"
  | "rejected"
  | "superseded"
  | "unavailable";

export interface PackageDeliverySnapshot {
  downloadUrl: string;
  downloadId: number | null;
  draftFingerprint: string;
  draftVideoId: string;
}

export function isPackageDeliverySnapshot(
  value: unknown,
): value is PackageDeliverySnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<PackageDeliverySnapshot>;
  return (
    typeof snapshot.downloadUrl === "string" &&
    snapshot.downloadUrl.startsWith(
      `blob:chrome-extension://${chrome.runtime.id}/`,
    ) &&
    (snapshot.downloadId === null ||
      (Number.isSafeInteger(snapshot.downloadId) &&
        (snapshot.downloadId ?? -1) >= 0)) &&
    typeof snapshot.draftFingerprint === "string" &&
    typeof snapshot.draftVideoId === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(snapshot.draftVideoId)
  );
}

interface PackageDeliveryOptions {
  build: (draft: Draft) => Promise<Uint8Array>;
  prepareDraft: () => Promise<Draft | null>;
}

export class PackageDelivery {
  #attempt: symbol | null = null;
  #downloadId: number | null = null;
  #downloadUrl: string | null = null;
  #draftFingerprint: string | null = null;
  #draftVideoId: string | null = null;
  #needsFreshPackage = false;
  #openPermissionsGranted = false;

  get canOpen(): boolean {
    return this.#downloadId !== null || this.#downloadUrl !== null;
  }

  get openPermissionsGranted(): boolean {
    return this.#openPermissionsGranted;
  }

  markOpenPermissionsGranted(): void {
    this.#openPermissionsGranted = true;
  }

  snapshot(): PackageDeliverySnapshot | null {
    if (!this.#downloadUrl || !this.#draftFingerprint || !this.#draftVideoId) {
      return null;
    }
    return {
      downloadUrl: this.#downloadUrl,
      downloadId: this.#downloadId,
      draftFingerprint: this.#draftFingerprint,
      draftVideoId: this.#draftVideoId,
    };
  }

  restore(snapshot: PackageDeliverySnapshot): void {
    this.reset();
    this.#downloadUrl = snapshot.downloadUrl;
    this.#downloadId = snapshot.downloadId;
    this.#draftFingerprint = snapshot.draftFingerprint;
    this.#draftVideoId = snapshot.draftVideoId;
  }

  get draftVideoId(): string | null {
    return this.#draftVideoId;
  }

  get needsFreshPackage(): boolean {
    return this.#needsFreshPackage;
  }

  reset(): void {
    this.#clear();
    this.#needsFreshPackage = false;
  }

  invalidateForUserChange(): boolean {
    if (this.#attempt !== null || this.canOpen) {
      this.#clear();
      this.#needsFreshPackage = true;
    }
    return this.#needsFreshPackage;
  }

  invalidateForDraftChange(newValue: unknown): boolean {
    if (
      (this.#attempt === null && !this.canOpen) ||
      JSON.stringify(newValue) === this.#draftFingerprint
    ) {
      return false;
    }
    this.#clear();
    this.#needsFreshPackage = true;
    return true;
  }

  async run({
    build,
    prepareDraft,
  }: PackageDeliveryOptions): Promise<PackageDeliveryOutcome> {
    this.reset();
    const canTrackCompletion = await chrome.permissions
      .contains(PACKAGE_OPEN_PERMISSIONS)
      .catch(() => false);
    this.#openPermissionsGranted = canTrackCompletion;
    const draft = await prepareDraft();
    if (!draft) {
      return "cancelled";
    }
    const attempt = Symbol("package-attempt");
    try {
      this.#attempt = attempt;
      this.#draftFingerprint = JSON.stringify(draft);
      this.#draftVideoId = draft.video.videoId;
      const bytes = await build(draft);
      if (this.#attempt !== attempt) {
        return "superseded";
      }
      const delivery = await downloadPackage(bytes, draft, canTrackCompletion);
      if (this.#attempt !== attempt) {
        return "superseded";
      }
      if (delivery === "interrupted") {
        return delivery;
      }
      this.#attempt = null;
      this.#downloadId = delivery.downloadId;
      this.#downloadUrl = delivery.url;
      return delivery.downloadId === null ? "started" : "completed";
    } catch (error) {
      if (this.#attempt !== attempt) {
        return "superseded";
      }
      throw error;
    } finally {
      if (this.#attempt === attempt) {
        this.#attempt = null;
        this.#draftFingerprint = null;
        this.#draftVideoId = null;
      }
    }
  }

  open(): Promise<PackageOpenOutcome> {
    const downloadId = this.#downloadId;
    const downloadUrl = this.#downloadUrl;
    if (downloadUrl === null) {
      return Promise.resolve("unavailable");
    }
    const isCurrent = (): boolean =>
      this.#downloadId === downloadId && this.#downloadUrl === downloadUrl;
    return new Promise((resolve) => {
      const reject = (): void => {
        if (!isCurrent()) {
          resolve("superseded");
          return;
        }
        this.reset();
        resolve("rejected");
      };
      try {
        // Keep open inside Chrome's first callback after the click so it retains
        // the user gesture. Permission prompting is a separate caller action.
        chrome.downloads.search(
          downloadId === null ? { url: downloadUrl } : { id: downloadId },
          (items) => {
            const lookupFailed = chrome.runtime.lastError;
            if (!isCurrent()) {
              resolve("superseded");
              return;
            }
            if (lookupFailed) {
              reject();
              return;
            }
            const [item] = items;
            if (
              items.length !== 1 ||
              !item ||
              (downloadId === null
                ? item.url !== downloadUrl
                : item.id !== downloadId) ||
              item.exists !== true
            ) {
              this.#clear();
              this.#needsFreshPackage = true;
              resolve("missing");
              return;
            }
            if (item.danger !== "safe" || item.state === "interrupted") {
              reject();
              return;
            }
            if (item.state !== "complete") {
              resolve("pending");
              return;
            }
            try {
              void chrome.downloads
                .open(item.id)
                .then(
                  () => resolve(isCurrent() ? "accepted" : "superseded"),
                  reject,
                );
            } catch {
              reject();
            }
          },
        );
      } catch {
        reject();
      }
    });
  }

  #clear(): void {
    this.#openPermissionsGranted = false;
    this.#attempt = null;
    this.#downloadId = null;
    this.#downloadUrl = null;
    this.#draftFingerprint = null;
    this.#draftVideoId = null;
  }
}

export async function downloadPackage(
  bytes: Uint8Array,
  draft: Draft,
  canTrackCompletion: boolean,
): Promise<"interrupted" | { downloadId: number | null; url: string }> {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = packageFilename(draft.video.title, draft.video.videoId);
  if (!canTrackCompletion) {
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { downloadId: null, url };
  }

  return new Promise((resolve, reject) => {
    let downloadId: number | null = null;
    let settled = false;
    let creationTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      // Revoke first: if the downloads permission was revoked mid-export the
      // listener calls below throw, and the package would stay pinned in memory.
      URL.revokeObjectURL(url);
      clearTimeout(creationTimeout);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.downloads.onErased.removeListener(onErased);
    };
    const complete = (): void => {
      if (settled || downloadId === null) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ downloadId, url });
    };
    const interrupt = (error: unknown = null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === null) {
        resolve("interrupted");
      } else {
        reject(error);
      }
    };
    const acceptItem = (item: chrome.downloads.DownloadItem): void => {
      if (item.danger !== "safe" || item.state === "interrupted") {
        interrupt();
      } else if (item.state === "complete") {
        complete();
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) {
        return;
      }
      if (delta.danger?.current && delta.danger.current !== "safe") {
        interrupt();
        return;
      }
      if (delta.state?.current === "interrupted") {
        interrupt();
      } else if (delta.state?.current === "complete") {
        complete();
      }
    };
    const onCreated = (item: chrome.downloads.DownloadItem): void => {
      if (downloadId !== null || item.url !== url) {
        return;
      }
      downloadId = item.id;
      acceptItem(item);
      if (settled) {
        return;
      }
      void chrome.downloads
        .search({ id: item.id })
        .then(([current]) => {
          if (current?.id !== item.id) {
            interrupt();
            return;
          }
          acceptItem(current);
        })
        .catch(() => interrupt());
    };
    const onErased = (erasedId: number): void => {
      if (erasedId === downloadId) {
        interrupt();
      }
    };

    try {
      chrome.downloads.onCreated.addListener(onCreated);
      chrome.downloads.onChanged.addListener(onChanged);
      chrome.downloads.onErased.addListener(onErased);
      creationTimeout = setTimeout(
        () => interrupt(),
        DOWNLOAD_CREATION_TIMEOUT_MS,
      );
      anchor.click();
    } catch (error) {
      interrupt(error);
    }
  });
}
