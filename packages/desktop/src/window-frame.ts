import type { BrowserWindowConstructorOptions } from "electron";

import type { DesktopChrome } from "./api.js";

/**
 * Electron 43 replaced its Linux frameless implementation with
 * ElectronFrameViewLinux. On the maintainer's GNOME 46 desktop that path
 * delivers pointer input against the wrong geometry under both Wayland and
 * X11. A native frame bypasses that Electron-only frame view entirely.
 */
export const LINUX_WINDOW_FRAME = { frame: true } satisfies BrowserWindowConstructorOptions;

/** A native Linux frame owns its titlebar and controls outside web content. */
export const LINUX_CHROME = {
  controls: "system",
  height: 0,
  insetLeft: 0,
  insetRight: 0,
} satisfies DesktopChrome;
