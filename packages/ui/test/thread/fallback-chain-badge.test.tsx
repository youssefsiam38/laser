// @vitest-environment happy-dom
/**
 * M15-T3: the composer's model selector stays accurate while a fallback chain
 * is in play. It shows the model that is actually active, says where in the
 * chain that is, and says when a switch is happening right now — in the
 * trigger's own accessible name, with the pill itself decorative so nothing is
 * read out twice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, SessionFallbackSummary } from "@lasercode/protocol";

const state = vi.hoisted(() => ({ fallback: undefined as SessionFallbackSummary | undefined }));
const stable = vi.hoisted(() => ({
  client: { request: vi.fn(async () => ({})) },
  actions: { listModels: vi.fn(async (): Promise<ModelRef[]> => []), setModel: vi.fn(async () => undefined), toast: vi.fn() },
  currentProject: "/p",
}));
vi.mock("@/runtime", () => ({
  useLaserStable: () => stable,
  useLaserState: (selector: (s: unknown) => unknown) => selector({ workers: {}, connection: "connected", agents: { snapshot: null } }),
  useSessionMeta: () => ({
    model: { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" },
    session: {
      path: "/p/s.jsonl",
      cwd: "/p",
      ...(state.fallback ? { fallback: state.fallback } : {}),
    },
  }),
}));

import { SessionModelSelector } from "../../src/components/assistant-ui/elements/model-selector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;

const chain: ModelRef[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
  { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" },
  { provider: "openrouter", id: "auto", name: "OpenRouter Auto" },
];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.fallback = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const render = () => act(async () => root.render(<TooltipProvider><SessionModelSelector /></TooltipProvider>));
const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
const badge = () => container.querySelector<HTMLElement>('[data-slot="fallback-chain-badge"]');

it("says nothing at all when this session has no chain", async () => {
  await render();
  expect(badge()).toBeNull();
  expect(trigger().getAttribute("aria-label")).toBe("Model: DeepSeek V3");
});

it("shows the live model and its place in the chain, and reads it out only once", async () => {
  state.fallback = { chain, position: 1 };
  await render();
  // The name is the model actually in use, not the chain's first model.
  expect(trigger().textContent).toContain("DeepSeek V3");
  expect(badge()?.textContent).toBe("chain 2/3");
  expect(badge()?.getAttribute("aria-hidden")).toBe("true");
  expect(trigger().getAttribute("aria-label")).toBe("Model: DeepSeek V3, model 2 of 3 in this fallback chain");
});

it("says a switch is happening while one is", async () => {
  state.fallback = { chain, position: 1, switching: true };
  await render();
  expect(badge()?.textContent).toBe("switching");
  expect(badge()?.dataset["switching"]).toBe("true");
  expect(trigger().getAttribute("aria-label")).toBe("Model: DeepSeek V3, switching to another model in this chain");
});

it("draws no pill for a chain that is not one", async () => {
  state.fallback = { chain: [chain[0]!], position: 0 };
  await render();
  expect(badge()).toBeNull();
  expect(trigger().getAttribute("aria-label")).toBe("Model: DeepSeek V3");
});
