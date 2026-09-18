import type { AppError } from "../messages.ts";

export function appError(code: AppError["code"], message: string): AppError {
  return { code, message };
}

export function normalizeError(error: unknown): AppError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    return error as AppError;
  }
  return appError(
    "CAPTURE_FAILED",
    error instanceof Error ? error.message : "YouTube caption capture failed.",
  );
}
