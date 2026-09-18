import type { SourceVideo } from "../domain/types.ts";
import type { PreflightMessage } from "../messages.ts";
import { inspectSourceTab, resolveSourceTabId } from "./capture.ts";
import { appError } from "./errors.ts";

export async function preflightSourceVideo(
  message: PreflightMessage,
): Promise<SourceVideo> {
  const tabId = await resolveSourceTabId(message.tabId, message.videoId);
  const video = await inspectSourceTab(tabId, "recovery");
  if (video.videoId !== message.videoId) {
    throw appError(
      "CAPTURE_FAILED",
      "The Source Video changed before export. Generate a fresh Draft.",
    );
  }
  return video;
}
