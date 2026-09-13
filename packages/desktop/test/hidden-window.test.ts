/**
 * The hidden window costs nothing (M16-T30).
 *
 * Closing this app's window hides it, so "hidden" is where it spends most of
 * its life. The window used to be created with `backgroundThrottling: false`,
 * which kept the renderer's timers and animation frames running at full rate
 * in the tray for a reason — loopback networking — that background throttling
 * does not touch: it throttles timers and pauses frames, not sockets.
 *
 * These pin the window's web preferences: the isolation flags stay, and the
 * throttling opt-out does not come back. Every catch-up the renderer needs on
 * the way back is tested in `@lasercode/ui`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeTheme: { on: () => {} },
  screen: {},
  shell: {},
}));

import { windowWebPreferences } from "../src/windows.js";

const bootstrap = {
  version: "0.0.0-test",
  platform: "linux",
  chrome: { controls: "system" as const, height: 0, insetLeft: 0, insetRight: 0 },
};

describe("the window's web preferences", () => {
  it("leaves Chromium's background throttling alone", () => {
    const preferences = windowWebPreferences(bootstrap);
    expect(preferences).not.toHaveProperty("backgroundThrottling");
    expect(Object.keys(preferences)).not.toContain("backgroundThrottling");
  });

  it("keeps the isolation that has nothing to do with performance", () => {
    const preferences = windowWebPreferences(bootstrap);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.webviewTag).toBe(false);
    expect(preferences.spellcheck).toBe(true);
    expect(preferences.preload).toMatch(/preload\.cjs$/);
    expect(preferences.additionalArguments?.[0]).toContain(encodeURIComponent(bootstrap.version));
  });
});
