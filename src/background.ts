import { appError, normalizeError } from "./background/errors.ts";
import {
  reopenPendingExport,
  reopenPendingPopup,
} from "./background/recovery.ts";
import { handleMessage } from "./background/router.ts";
import { isAppMessage } from "./messages.ts";
import {
  isPopupPermissionRequest,
  isPopupPermissionResumeClaim,
  PopupPermissionCoordinator,
} from "./popup-permission.ts";

const popupPermission = new PopupPermissionCoordinator();

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (response: unknown) => void) => {
    if (isPopupSender(sender) && isPopupPermissionRequest(message)) {
      void popupPermission.request(message).then(sendResponse);
      return true;
    }
    if (isPopupSender(sender) && isPopupPermissionResumeClaim(message)) {
      sendResponse(popupPermission.claim(message));
      return false;
    }
    if (!isAppMessage(message)) {
      sendResponse({
        error: appError("INVALID_REQUEST", "Unknown extension request."),
        ok: false,
      });
      return false;
    }

    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({ error: normalizeError(error), ok: false });
      });
    return true;
  },
);

function isPopupSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup/popup.html")
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "update") {
    void reopenPendingExport().catch(() => undefined);
    void reopenPendingPopup().catch(() => undefined);
  }
});
