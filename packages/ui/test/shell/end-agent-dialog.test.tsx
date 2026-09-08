// @vitest-environment happy-dom
/**
 * "End {subagentName}?": the shared confirmation, over a real store. The
 * quick chips fill the field, Enter lands on Keep running, a confirmed end
 * calls `stopRun` with the reason, a failure keeps the reason and offers a
 * retry, and a run that ends on its own says so.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndAgentDialog } from "../../src/components/agents/EndAgentDialog.js";
import { clearEndAgentRequest, requestEndAgent, useEndAgentRequest } from "../../src/components/agents/end-agent.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce } from "../../src/store.js";
import { run } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({ actions: { toast: vi.fn(), agents: { stopRun: vi.fn() } } }));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

const RUN = run({ runId: "r1", sessionPath: "/p/child.jsonl", subagentName: "explorer" });
let container: HTMLDivElement;
let root: Root;
let store: StateStore;
let request: ReturnType<typeof useEndAgentRequest>;
function Probe() { request = useEndAgentRequest(); return null; }
const mount = async (node: ReactNode = <LaserStoreProvider store={store}><EndAgentDialog /><Probe /></LaserStoreProvider>) => act(async () => root.render(node));
const dialog = () => document.querySelector<HTMLElement>('[data-slot="end-agent-dialog"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="end-agent-dialog"] button')].find((b) => b.textContent?.trim() === text);
const textarea = () => document.querySelector<HTMLTextAreaElement>('[data-slot="end-agent-dialog"] textarea')!;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stable.actions.toast.mockReset();
  stable.actions.agents.stopRun.mockReset();
  clearEndAgentRequest();
  store = createStateStore(reduce(initialState, { type: "agents/run", run: RUN }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearEndAgentRequest();
});

describe("EndAgentDialog", () => {
  it("names the run, fills the reason from a quick chip, and keeps Enter on the safe verb", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await act(async () => requestEndAgent("r1"));
    await settle();
    expect(dialog()?.textContent).toContain("End explorer?");
    expect(dialog()?.textContent).toContain("its parent is told you ended it");
    expect(document.activeElement).toBe(button("Keep running"));
    const chip = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="end-agent-reason"]')].find((c) => c.textContent === "Wrong direction")!;
    await act(async () => chip.click());
    expect(textarea().value).toBe("Wrong direction");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Enter in the field is a newline, never a confirmation.
    textarea().focus();
    await act(async () => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(stable.actions.agents.stopRun).not.toHaveBeenCalled();
    await act(async () => button("Keep running")!.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(stable.actions.agents.stopRun).not.toHaveBeenCalled();
  });

  it("ends the run with the edited reason, toasts, and closes", async () => {
    stable.actions.agents.stopRun.mockResolvedValue({ ...RUN, status: "cancelled" });
    await mount();
    await act(async () => requestEndAgent("r1"));
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="end-agent-reason"]')].find((c) => c.textContent === "I'll take over")!.click());
    await act(async () => {
      const field = textarea();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "I'll take over from here");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("End agent")!.click());
    await settle();
    expect(stable.actions.agents.stopRun).toHaveBeenCalledWith("r1", "I'll take over from here");
    expect(stable.actions.toast).toHaveBeenCalledWith("info", "Ended explorer");
    expect(request).toBeUndefined();
    expect(dialog()).toBeNull();
  });

  it("shows a failure inside the dialog, keeps the reason and offers to try again", async () => {
    stable.actions.agents.stopRun.mockRejectedValueOnce(new Error("The host did not answer."));
    stable.actions.agents.stopRun.mockResolvedValueOnce({ ...RUN, status: "cancelled" });
    await mount();
    await act(async () => requestEndAgent("r1"));
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="end-agent-reason"]')].find((c) => c.textContent === "No longer needed")!.click());
    await act(async () => button("End agent")!.click());
    await settle();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("The host did not answer.");
    expect(textarea().value).toBe("No longer needed");
    expect(button("Try again")).toBeDefined();
    expect(stable.actions.toast).not.toHaveBeenCalled();
    await act(async () => button("Try again")!.click());
    await settle();
    expect(stable.actions.agents.stopRun).toHaveBeenLastCalledWith("r1", "No longer needed");
    expect(dialog()).toBeNull();
  });

  it("says so when the run ends while the question is open, and only offers Close", async () => {
    await mount();
    await act(async () => requestEndAgent("r1"));
    await settle();
    await act(async () => store.dispatch({ type: "agents/run", run: { ...RUN, status: "completed", updatedAt: "2026-09-08T10:05:00.000Z" } }));
    expect(dialog()?.getAttribute("data-finished")).toBe("true");
    expect(dialog()?.textContent).toContain("It finished before you decided.");
    expect(button("End agent")).toBeUndefined();
    expect(document.querySelector('[data-slot="end-agent-dialog"] textarea')).toBeNull();
    await act(async () => button("Close")!.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(stable.actions.agents.stopRun).not.toHaveBeenCalled();
  });
});
