// Increment when any bundled runtime boundary changes, including the Draft
// schema, popup/background messages, or the background/page capture bridge.
export const APP_PROTOCOL_VERSION = 8;
export const POPUP_RECOVERY_KEY = "pending-popup-recovery";
export const POPUP_RECOVERY_MAX_AGE_MS = 60_000;

export interface PopupRecovery {
  protocolVersion: number;
  requestedAt: number;
}

export function isFreshPopupRecovery(
  value: unknown,
  now = Date.now(),
): value is PopupRecovery {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PopupRecovery>;
  const age = now - (candidate.requestedAt ?? Number.NaN);
  return (
    candidate.protocolVersion === APP_PROTOCOL_VERSION &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= POPUP_RECOVERY_MAX_AGE_MS
  );
}
