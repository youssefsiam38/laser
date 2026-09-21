// @vitest-environment happy-dom
/**
 * "Choose Beam's profile" (M22-T9): opened from Beam's empty state, never by
 * itself — following the profile new conversations use is a working state, and
 * the app has already filled the profiles in. A pick is saved through
 * `agents/builtin/set-profile`; "Later" closes without a request.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));

import { BeamProfileDialog, beamProfileDialog } from "../../src/components/beam/BeamProfileDialog.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider } from "../../src/runtime/LaserProvider.js";
import { createWorld, FakeHostClient, settle, type World } from "./fake-host.js";

const FAST = "mp_fast00000000000000";

/** The empty state's "Choose a profile" does exactly this. */
function OpenFromEmptyState() {
  return <button data-slot="open-choice" onClick={() => beamProfileDialog.open()} />;
}

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <OpenFromEmptyState />
        <BeamProfileDialog />
      </TooltipProvider>
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    beamProfileDialog.close();
    root.unmount();
  });
  container.remove();
});

const dialog = () => document.querySelector<HTMLElement>('[data-slot="beam-profile-dialog"]');
const mount = async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => settle(10));
};
const open = async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="open-choice"]')!.click());
  await act(async () => settle(20));
};
const pick = async (name: string) => {
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="profile-picker-trigger"]')!.click());
  await act(async () => settle(10));
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes(name),
  )!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
  await act(async () => settle(10));
};

describe("the Beam profile choice", () => {
  it("stays closed until the person asks for it, then offers the profiles that exist", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await open();
    const box = dialog()!;
    expect(box.textContent).toContain("Choose Beam’s profile");
    expect(box.textContent).toContain("fast, inexpensive profile");
    expect(world.calls.some((call) => call.method === "models/profiles/list")).toBe(true);
    await act(async () => box.querySelector<HTMLButtonElement>('[data-slot="profile-picker-trigger"]')!.click());
    await act(async () => settle(10));
    const names = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].map((item) => item.textContent ?? "");
    expect(names.join(" ")).toContain("Fast");
    expect(names.join(" ")).toContain("Smart");
  });

  it("saves the pick through the agents actions and closes", async () => {
    await mount();
    await open();
    await pick("Fast");
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-profile-use"]')!.click());
    await act(async () => settle(20));
    const set = world.calls.filter((call) => call.method === "agents/builtin/set-profile");
    expect(set).toHaveLength(1);
    expect(set[0]!.params).toEqual({ name: "beam", profileId: FAST });
    expect(dialog()).toBeNull();
  });

  it("Later closes without a request, and the empty state can ask again", async () => {
    await mount();
    await open();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-profile-later"]')!.click());
    await act(async () => settle(10));
    expect(dialog()).toBeNull();
    expect(world.calls.some((call) => call.method === "agents/builtin/set-profile")).toBe(false);
    await open();
    expect(dialog()).not.toBeNull();
  });

  it("says so, in the dialog, when the save fails", async () => {
    world.overrides["agents/builtin/set-profile"] = () => {
      throw new Error("The host is not reachable.");
    };
    await mount();
    await open();
    await pick("Fast");
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-profile-use"]')!.click());
    await act(async () => settle(20));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  });
});
