// @vitest-environment happy-dom
/**
 * Opening a model picker puts the caret in its search box, wherever the picker
 * is in the app: the person opened it to find a model, and the first keystroke
 * has to land somewhere useful.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderModelPicker, ProviderPicker } from "../../src/components/assistant-ui/elements/model-selector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const MODELS = [
  { provider: "anthropic", id: "sonnet", name: "Sonnet" },
  { provider: "anthropic", id: "opus", name: "Opus" },
  { provider: "openai", id: "gpt", name: "GPT" },
];

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const openTrigger = async (): Promise<void> => {
  const trigger = document.querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]') ?? container.querySelector<HTMLButtonElement>("button");
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
};

const search = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('[data-slot="model-selector-search"]');

describe("opening a model picker", () => {
  it("puts the caret in the model search", async () => {
    await act(async () => root.render(<TooltipProvider><ProviderModelPicker models={MODELS} onValueChange={() => {}} /></TooltipProvider>));
    await openTrigger();
    expect(search()).not.toBeNull();
    expect(document.activeElement).toBe(search());
  });

  it("puts the caret in the provider search of the provider-only picker", async () => {
    await act(async () => root.render(<TooltipProvider><ProviderPicker models={MODELS} onValueChange={() => {}} /></TooltipProvider>));
    await openTrigger();
    expect(search()).not.toBeNull();
    expect(document.activeElement).toBe(search());
  });
});
