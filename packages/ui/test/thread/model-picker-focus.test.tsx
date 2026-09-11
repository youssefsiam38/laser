// @vitest-environment happy-dom
/**
 * Opening a model picker puts the caret in its search box, wherever the picker
 * is in the app: the person opened it to find a model, and the first keystroke
 * has to land somewhere useful.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelPickerDialogPortal, ProviderModelPicker, ProviderPicker } from "../../src/components/assistant-ui/elements/model-selector.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../src/components/ui/dialog.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const MODELS = [
  { provider: "anthropic", id: "sonnet", name: "Sonnet" },
  { provider: "anthropic", id: "opus", name: "Opus" },
  { provider: "openai", id: "gpt", name: "GPT" },
];
const LONG_MODELS = Array.from({ length: 80 }, (_, index) => ({
  provider: index < 40 ? "anthropic" : `provider-${index}`,
  id: `model-${index}`,
  name: `Model ${index}`,
}));

function ModalPicker() {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Choose a model</DialogTitle>
        <DialogDescription>The constrained modal picker.</DialogDescription>
        <ProviderModelPicker models={LONG_MODELS} onValueChange={() => {}} container={portal} />
        <ModelPickerDialogPortal ref={setPortal} />
      </DialogContent>
    </Dialog>
  );
}

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

  it("keeps modal filters fixed outside the scroll remainder and preserves nested focus", async () => {
    await act(async () => root.render(<TooltipProvider><ModalPicker /></TooltipProvider>));
    await openTrigger();
    const portal = document.querySelector<HTMLElement>('[data-slot="model-picker-portal"]')!;
    const menu = document.querySelector<HTMLElement>('[data-slot="model-selector-content"]')!;
    const list = menu.querySelector<HTMLElement>('[data-slot="model-selector-list"]')!;
    const provider = menu.querySelector<HTMLButtonElement>('[aria-label="Filter by provider"]')!;
    const modelSearch = menu.querySelector<HTMLInputElement>('[aria-label="Filter by model"]')!;
    expect(portal.contains(menu)).toBe(true);
    expect(list.contains(provider)).toBe(false);
    expect(list.contains(modelSearch)).toBe(false);
    expect(document.activeElement).toBe(modelSearch);

    await act(async () => provider.click());
    const providerMenu = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const providerSearch = providerMenu.querySelector<HTMLInputElement>('[aria-label="Search providers"]')!;
    expect(portal.contains(providerMenu)).toBe(true);
    expect(document.activeElement).toBe(providerSearch);
    await act(async () => providerSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(document.querySelector('[data-slot="model-selector-content"]')).toBe(menu);
    expect(document.activeElement).toBe(provider);
  });
});
