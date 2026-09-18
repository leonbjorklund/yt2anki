import {
  isPackageDeliverySnapshot,
  PACKAGE_OPEN_PERMISSIONS,
  type PackageDeliverySnapshot,
} from "./anki/package-download.ts";
export const YOUTUBE_PREVIEW_PERMISSIONS: chrome.permissions.Permissions = {
  origins: ["https://www.youtube.com/*"],
};

const POPUP_PERMISSION_RESUME_MAX_AGE_MS = 60_000;

interface PopupPermissionSelection {
  tabId: number;
  targetTrackId: string;
  translationTrackId?: string;
  videoId: string;
}

export type PopupPermissionIntent = PopupPermissionSelection &
  (
    | { action: "preview" }
    | { action: "open-package"; package: PackageDeliverySnapshot }
  );

export type PopupPermissionRequest = PopupPermissionIntent & {
  type: "request-popup-permission";
};

export type PopupPermissionResume = PopupPermissionIntent & {
  attemptId: string;
  granted: boolean;
  requestedAt: number;
};

export interface PopupPermissionResumeClaim {
  attemptId?: string;
  type: "claim-popup-permission-resume";
}

interface PopupPermissionDependencies {
  contains: (permissions: chrome.permissions.Permissions) => Promise<boolean>;
  now: () => number;
  openPopup: () => Promise<void>;
  randomId: () => string;
  request: (permissions: chrome.permissions.Permissions) => Promise<boolean>;
}

export class PopupPermissionCoordinator {
  readonly #dependencies: PopupPermissionDependencies;
  #pending: PopupPermissionResume | null = null;

  constructor(
    dependencies: PopupPermissionDependencies = {
      contains: (permissions) => chrome.permissions.contains(permissions),
      now: () => Date.now(),
      openPopup: () => chrome.action.openPopup(),
      randomId: () => crypto.randomUUID(),
      request: (permissions) => chrome.permissions.request(permissions),
    },
  ) {
    this.#dependencies = dependencies;
  }

  async request(
    message: PopupPermissionRequest,
  ): Promise<{ attemptId: string } | null> {
    const permissions =
      message.action === "preview"
        ? YOUTUBE_PREVIEW_PERMISSIONS
        : PACKAGE_OPEN_PERMISSIONS;
    const previousPermission = this.#dependencies
      .contains(permissions)
      .catch(() => false);
    const permissionRequest = this.#dependencies
      .request(permissions)
      .catch(() => false);
    const [wasGranted, granted] = await Promise.all([
      previousPermission,
      permissionRequest,
    ]);
    if (message.action === "preview" && !granted) {
      this.#pending = null;
      return null;
    }
    const attemptId = this.#dependencies.randomId();
    this.#pending = {
      ...(message.action === "preview"
        ? { action: "preview" as const }
        : { action: "open-package" as const, package: message.package }),
      attemptId,
      granted,
      requestedAt: this.#dependencies.now(),
      tabId: message.tabId,
      targetTrackId: message.targetTrackId,
      ...(message.translationTrackId
        ? { translationTrackId: message.translationTrackId }
        : {}),
      videoId: message.videoId,
    };
    if (!wasGranted) {
      await this.#dependencies.openPopup().catch(() => undefined);
    }
    return { attemptId };
  }

  claim(message: PopupPermissionResumeClaim): PopupPermissionResume | null {
    const pending = this.#pending;
    if (!pending) {
      return null;
    }
    const age = this.#dependencies.now() - pending.requestedAt;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > POPUP_PERMISSION_RESUME_MAX_AGE_MS
    ) {
      this.#pending = null;
      return null;
    }
    if (
      message.attemptId !== undefined &&
      message.attemptId !== pending.attemptId
    ) {
      return null;
    }
    this.#pending = null;
    return pending;
  }
}

export function isPopupPermissionRequest(
  value: unknown,
): value is PopupPermissionRequest {
  return (
    isRecord(value) &&
    value.type === "request-popup-permission" &&
    isPopupPermissionIntent(value)
  );
}

export function isPopupPermissionResume(
  value: unknown,
): value is PopupPermissionResume {
  return (
    isRecord(value) &&
    isPopupPermissionIntent(value) &&
    isNonemptyString(value.attemptId) &&
    typeof value.granted === "boolean" &&
    typeof value.requestedAt === "number" &&
    Number.isFinite(value.requestedAt)
  );
}

export function isPopupPermissionResumeClaim(
  value: unknown,
): value is PopupPermissionResumeClaim {
  return (
    isRecord(value) &&
    value.type === "claim-popup-permission-resume" &&
    (value.attemptId === undefined || isNonemptyString(value.attemptId))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPopupPermissionIntent(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PopupPermissionIntent {
  return (
    (value.action === "preview" ||
      (value.action === "open-package" &&
        isPackageDeliverySnapshot(value.package) &&
        value.package.draftVideoId === value.videoId)) &&
    isTabId(value.tabId) &&
    isNonemptyString(value.targetTrackId) &&
    (value.translationTrackId === undefined ||
      (isNonemptyString(value.translationTrackId) &&
        value.translationTrackId !== value.targetTrackId)) &&
    typeof value.videoId === "string" &&
    /^[A-Za-z0-9_-]{11}$/u.test(value.videoId)
  );
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
