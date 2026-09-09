// @vitest-environment happy-dom
/**
 * "Choose Beam's model": opened by the store flag the host's
 * `agents/beam/choose-model` sets, preselected to the suggestion, saved
 * through `agents/builtin/set-model`, dismissed with "Later" without a request.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));

import { BeamModelDialog } from "../../src/components/beam/BeamModelDialog.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { createWorld, FakeHostClient, settle, type World } from "./fake-host.js";

const SUGGESTED = { provider: "openai", id: "gpt-fast" };

/** The empty state's "Choose a model" does this: reopens the choice from the snapshot. */
function ReopenFromEmptyState() {
  const { dispatch } = useLaserStable();
  return <button data-slot="reopen" onClick={() => dispatch({ type: "agents/choose-beam-model", suggested: SUGGESTED })} />;
}

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <ReopenFromEmptyState />
        <BeamModelDialog />
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
  world.snapshot = { ...world.snapshot, beam: { model: null, suggested: SUGGESTED, needsChoice: true } };
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const dialog = () => document.querySelector<HTMLElement>('[data-slot="beam-model-dialog"]');
const mount = async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => settle(10));
};
const choose = async () => {
  await act(async () => FakeHostClient.current.notify("agents/beam/choose-model", { suggested: SUGGESTED }));
  await act(async () => settle(20));
};

describe("the Beam model choice", () => {
  it("stays closed until the host asks, then opens preselected to the recommendation", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await choose();
    const box = dialog()!;
    expect(box.textContent).toContain("Choose Beam’s model");
    expect(box.textContent).toContain("fast, capable, inexpensive");
    expect(box.querySelector('[data-slot="model-selector-value"]')?.textContent).toContain("GPT Fast");
    expect(box.querySelector('[data-slot="beam-model-recommended"]')?.textContent).toBe("Recommended");
    expect(world.calls.some((call) => call.method === "pi/models/catalog")).toBe(true);
  });

  it("saves the pick through the agents actions and closes", async () => {
    await mount();
    await choose();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-model-use"]')!.click());
    await act(async () => settle(20));
    const set = world.calls.filter((call) => call.method === "agents/builtin/set-model");
    expect(set).toHaveLength(1);
    expect(set[0]!.params).toEqual({ name: "beam", model: SUGGESTED });
    expect(dialog()).toBeNull();
  });

  it("Later closes without a request, and the empty state can ask again", async () => {
    await mount();
    await choose();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-model-later"]')!.click());
    await act(async () => settle(10));
    expect(dialog()).toBeNull();
    expect(world.calls.some((call) => call.method === "agents/builtin/set-model")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="reopen"]')!.click());
    await act(async () => settle(20));
    expect(dialog()).not.toBeNull();
  });

  it("says so, in the dialog, when the save fails", async () => {
    world.overrides["agents/builtin/set-model"] = () => {
      throw new Error("The host is not reachable.");
    };
    await mount();
    await choose();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="beam-model-use"]')!.click());
    await act(async () => settle(20));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  });
});
