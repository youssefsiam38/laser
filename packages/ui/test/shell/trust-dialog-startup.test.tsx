// @vitest-environment happy-dom
/**
 * The project-trust question is answerable while the opening screen is still
 * up. The host holds the restored session's worker start behind it, and the
 * screen waits on that very load: a dialog mounted inside the shell could
 * never appear, and the app sat frozen until the host's two-minute timeout.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupRestorationGate } from "../../src/components/assistant-ui/elements/loading-state.js";
import { TrustDialog } from "../../src/components/shell/TrustDialog.js";

const prompts = vi.hoisted(() => ({
  requests: [] as { id: string; cwd: string; reasons: string[]; timeoutMs: number }[],
  answer: vi.fn(),
}));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useTrustPrompts: () => prompts,
}));

let container: HTMLDivElement;
let root: Root;
const mount = () => act(async () => root.render(
  <StartupRestorationGate active label="Returning to your last session" prompts={<TrustDialog />}>
    <main>Operational shell</main>
  </StartupRestorationGate>,
));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  prompts.requests = [];
  prompts.answer.mockReset();
  prompts.answer.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("TrustDialog over the startup screen", () => {
  it("asks over the screen while the shell is still unmounted, and the answer reaches the host", async () => {
    prompts.requests = [{ id: "trust-1", cwd: "/home/me/projects/atlas", reasons: ["settings.json"], timeoutMs: 120_000 }];
    await mount();
    expect(document.querySelector('[data-slot="startup-restoration"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Operational shell");
    expect(dialog()?.textContent).toContain("Trust atlas?");
    expect(dialog()?.textContent).toContain("settings.json");
    expect(document.activeElement).toBe(button("Not now"));
    await act(async () => button("Trust this project")!.click());
    expect(prompts.answer).toHaveBeenCalledWith("/home/me/projects/atlas", true, true);
  });

  it("shows nothing when the host has no question", async () => {
    await mount();
    expect(document.querySelector('[data-slot="startup-restoration"]')).not.toBeNull();
    expect(dialog()).toBeNull();
  });
});
