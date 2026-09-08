// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({ completed: false }),
  toast: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../../src/runtime/index.js", async () => {
  // The real `forgetRememberedSessions`: what it does to storage is the point
  // of the second suite below.
  const { forgetRememberedSessions, SESSION_STORAGE_KEY } = await import("../../src/runtime/LaserProvider.js");
  return {
    forgetRememberedSessions,
    SESSION_STORAGE_KEY,
    useLaserStable: () => ({ client: { request: mocks.request }, actions: { toast: mocks.toast } }),
    useLaserState: () => undefined,
    useLaserView: () => undefined,
  };
});
vi.mock("../../src/components/workbench/index.js", () => ({ useWorkbench: () => ({ page: "settings", tab: undefined, agents: undefined, open: vi.fn(), close: mocks.close }) }));

import { DeviceTab } from "../../src/components/settings/SettingsScreen.js";
import { SETUP_STEP_KEY } from "../../src/components/onboarding/setup-model.js";
import { clearSetupRequest, honourSetupRequest, requestSetupAgain, useSetupRequested } from "../../src/components/onboarding/setup-request.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { SESSION_STORAGE_KEY } from "../../src/runtime/LaserProvider.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request.mockClear();
  mocks.toast.mockClear();
  mocks.close.mockClear();
  clearSetupRequest();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearSetupRequest();
});

const press = async (): Promise<void> => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Run setup again");
  expect(button).toBeDefined();
  await act(async () => button!.click());
};

describe("Run setup again", () => {
  it("clears the host flag, forgets the remembered step, asks for the flow and leaves Settings", async () => {
    localStorage.setItem(SETUP_STEP_KEY, "ready");
    let requested = false;
    function Probe(): null {
      requested = useSetupRequested();
      return null;
    }
    await act(async () => root.render(<TooltipProvider><Probe /><DeviceTab /></TooltipProvider>));
    expect(requested).toBe(false);

    await press();

    expect(mocks.request).toHaveBeenCalledWith("pi/setup/complete", { completed: false });
    // A fresh run, not a resume: the flow must not open on the finish line.
    expect(localStorage.getItem(SETUP_STEP_KEY)).toBeNull();
    expect(requested).toBe(true);
    // The workbench steps aside so the flow can own the window.
    expect(mocks.close).toHaveBeenCalledOnce();
    // Nothing promises a later run any more, so nothing is announced.
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("keeps the person in Settings and says why when the host refuses", async () => {
    mocks.request.mockRejectedValueOnce(new Error("The host is not answering."));
    await act(async () => root.render(<TooltipProvider><DeviceTab /></TooltipProvider>));
    await press();
    expect(mocks.toast).toHaveBeenCalledWith("error", "The host is not answering.");
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

describe("the setup request store", () => {
  it("notifies once per request and again after it is spent", () => {
    const seen: boolean[] = [];
    function Probe(): null {
      seen.push(useSetupRequested());
      return null;
    }
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    act(() => requestSetupAgain());
    act(() => requestSetupAgain());
    expect(seen.at(-1)).toBe(true);
    act(() => clearSetupRequest());
    expect(seen.at(-1)).toBe(false);
    act(() => requestSetupAgain());
    expect(seen.at(-1)).toBe(true);
  });

  it("leaves the open session and the remembered destination behind, and reads the host again", () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ "/p": "/p/s.jsonl" }));
    const refresh = vi.fn();
    const leaveSession = vi.fn();
    honourSetupRequest({ refresh, leaveSession });
    expect(refresh).toHaveBeenCalledOnce();
    // Setup renders only while nothing is open, and a reload must not undo that.
    expect(leaveSession).toHaveBeenCalledOnce();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
