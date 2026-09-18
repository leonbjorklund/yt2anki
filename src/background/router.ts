import { DRAFT_SCHEMA_VERSION, type SourceVideo } from "../domain/types.ts";
import type {
  AppMessage,
  AppResponse,
  GenerateData,
  InspectData,
} from "../messages.ts";
import { APP_PROTOCOL_VERSION } from "../popup-recovery.ts";
import { getSettings } from "../storage.ts";
import { inspectSourceTab } from "./capture.ts";
import { generateDraft } from "./generation.ts";
import { preflightSourceVideo } from "./preflight.ts";

export async function handleMessage(
  message: AppMessage,
): Promise<AppResponse<GenerateData | InspectData | SourceVideo>> {
  switch (message.type) {
    case "inspect":
    case "inspect-recovery": {
      const [video, settings] = await Promise.all([
        inspectSourceTab(
          message.tabId,
          message.type === "inspect" ? "toolbar-action" : "recovery",
        ),
        getSettings(),
      ]);
      return {
        data: {
          draftSchemaVersion: DRAFT_SCHEMA_VERSION,
          protocolVersion: APP_PROTOCOL_VERSION,
          settings,
          video,
        },
        ok: true,
      };
    }
    case "preflight":
      return { data: await preflightSourceVideo(message), ok: true };
    case "generate":
    case "generate-package":
    case "generate-preview":
      return { data: await generateDraft(message), ok: true };
  }
}
