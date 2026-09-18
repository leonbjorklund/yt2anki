export const EXPORT_RECOVERY_KEY = "pending-export-recovery";
export const EXPORT_RECOVERY_MAX_AGE_MS = 60_000;

export type ExportAction = "apkg";

export interface ExportRecovery {
  action: ExportAction;
  generationId: string;
  requestedAt: number;
  videoId: string;
}

export function isFreshExportRecovery(
  value: unknown,
  now = Date.now(),
): value is ExportRecovery {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ExportRecovery>;
  const age = now - (candidate.requestedAt ?? Number.NaN);
  return (
    candidate.action === "apkg" &&
    typeof candidate.generationId === "string" &&
    Boolean(candidate.generationId) &&
    typeof candidate.videoId === "string" &&
    /^[A-Za-z0-9_-]{11}$/u.test(candidate.videoId) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= EXPORT_RECOVERY_MAX_AGE_MS
  );
}
