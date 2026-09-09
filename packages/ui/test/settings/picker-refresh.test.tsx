// @vitest-environment happy-dom
/**
 * M13-T49 addendum: a switch flipped in Settings → Providers and models shows
 * in the session's model picker on its next open, with no reload. The picker
 * forgets its list on close and asks the worker again on open.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRef } from "@lasercode/protocol";

const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: { listModels: vi.fn(async (): Promise<ModelRef[]> => []), setModel: vi.fn(async () => undefined), toast: vi.fn() },
  currentProject: "/p",
}));
vi.mock("@/runtime", () => ({
  useLaserStable: () => stable,
  useLaserState: (selector: (s: unknown) => unknown) => selector({ workers: {}, connection: "connected" }),
  useSessionMeta: () => ({ model: { provider: "stub", id: "stub-1", name: "Stub One" }, session: { path: "/p/s.jsonl", cwd: "/p" } }),
}));

import { SessionModelSelector } from "../../src/components/assistant-ui/elements/model-selector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;
const one: ModelRef = { provider: "stub", id: "stub-1", name: "Stub One" };
const two: ModelRef = { provider: "stub", id: "stub-2", name: "Stub Two" };

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  stable.actions.listModels.mockReset().mockResolvedValue([one, two]);
  await act(async () => root.render(<TooltipProvider><SessionModelSelector /></TooltipProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].map((item) => item.textContent ?? "");
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("asks the worker again on every open, so a switch in Settings shows without a reload", async () => {
  await act(async () => trigger().click());
  await settle();
  expect(stable.actions.listModels).toHaveBeenCalledTimes(1);
  expect(items().join(" ")).toContain("Stub Two");

  // Close, then the person switches stub-2 off in Settings.
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  stable.actions.listModels.mockResolvedValue([one]);

  await act(async () => trigger().click());
  await settle();
  expect(stable.actions.listModels).toHaveBeenCalledTimes(2);
  expect(items().join(" ")).toContain("Stub One");
  expect(items().join(" ")).not.toContain("Stub Two");
});
