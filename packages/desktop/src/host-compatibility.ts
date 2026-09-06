import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";

/** Compare the process record, not files an updater may already have replaced. */
export function hostVersionProblem(running: string, bundled: string): string | undefined {
  if (running === bundled && running !== "unknown") return undefined;
  return `${PRODUCT_DISPLAY_NAME} ${bundled} found a background service still running version ${running}. ` +
    "The installed files changed, but that process has not restarted. " +
    `Finish any active work, then quit all ${PRODUCT_DISPLAY_NAME} windows and its system-tray icon and reopen the app. ` +
    "If the background service remains, restart your computer. Your saved chats and provider connections are kept.";
}
