import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";

export function accountUsageRefreshError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown method pi\/account-usage\/refresh/i.test(message)) {
    return new Error(`Your background service is still running an older version of ${PRODUCT_DISPLAY_NAME}. ` +
      "Finish active work, quit the app completely (including its tray icon), then reopen it to load subscription quota. " +
      "If it persists, restart the computer. Reconnecting your OpenAI account is not needed for this version mismatch.");
  }
  return error instanceof Error ? error : new Error(message);
}
