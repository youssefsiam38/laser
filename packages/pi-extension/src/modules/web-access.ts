/**
 * web-access — pi-web-access uses only the portable UI surface (notify, select,
 * string widgets), so it works through the ui-bridge without help. This module
 * exists to detect it for the capabilities report and, later, to render its
 * search-result widget natively (M8-T4).
 */
import type { PiorbitModule } from "./index.js";

export const webAccessModule: PiorbitModule = {
  name: "web-access",
  detect: () => false, // TODO(M8-T4): detect via registered tools (web_search, fetch_url)
  activate() {},
};
