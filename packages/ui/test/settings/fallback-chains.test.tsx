// @vitest-environment happy-dom
/**
 * M15-T3: Settings → Providers and models → Fallback chains.
 *
 * Through the real tab with a mocked client: the empty state, building a chain
 * (a chain of one is never saved), reordering and removing, deleting, and the
 * two rules a person can break — the same model twice in one chain, and two
 * chains starting on the same model. Every control is a real button with an
 * accessible name, which is what makes the keyboard path the same path.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import type { ModelCatalogEntry, ProviderAuthInfo, SettingChange, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
// One stable object, as the real provider hands out: a fresh `client` on every
// render would re-run the catalogue effect forever.
vi.mock("@/runtime", () => {
  const value = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: mocks.toast } };
  return { useLaserStable: () => value };
});

import { FallbackChainsTab } from "../../src/components/settings/fallback/FallbackChainsTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;
let applied: Array<{ scope: SettingsScope; changes: SettingChange[] }>;
let applyResult: boolean;
let chains: unknown;

const model = (provider: string, id: string, name: string): ModelCatalogEntry => ({
  provider,
  id,
  name,
  contextWindow: 200000,
  reasoning: false,
  vision: false,
  thinkingLevels: [],
  enabled: true,
});
const catalogue = [
  model("anthropic", "claude-sonnet-4-5", "Sonnet 4.5"),
  model("deepseek", "deepseek-chat", "DeepSeek V3"),
  model("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
  model("openrouter", "auto", "OpenRouter Auto"),
];
const providers: ProviderAuthInfo[] = ["anthropic", "deepseek", "google", "openrouter"].map((id) => ({
  id,
  name: id,
  configured: true,
  oauth: false,
  subscription: false,
  modelCount: 1,
}));

const chain = (...models: Array<[string, string]>) => ({ models: models.map(([provider, id]) => ({ provider, id })) });

const snapshot = (): SettingsSnapshot => ({
  cwd: "/p",
  agentDir: "/a",
  global: { path: "/a/settings.json", exists: true, values: chains === undefined ? {} : { fallbackChains: chains } },
  project: { path: `/p/${PROJECT_DIR_NAME}/settings.json`, exists: false, values: {} },
  effective: chains === undefined ? {} : { fallbackChains: chains },
  projectTrust: { trusted: true, writable: true, reason: "trusted" },
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applied = [];
  applyResult = true;
  chains = undefined;
  mocks.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "pi/providers/list") return { providers };
    if (method === "pi/models/catalog") return { models: catalogue, enabledPatterns: null, disabledModels: [], errors: [] };
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render() {
  const onApply = async (scope: SettingsScope, changes: SettingChange[]) => {
    applied.push({ scope, changes });
    if (applyResult) {
      for (const change of changes) chains = change.op === "set" ? change.value : undefined;
    }
    return applyResult;
  };
  await act(async () => root.render(<TooltipProvider><FallbackChainsTab cwd="/p" snapshot={snapshot()} onApply={onApply} /></TooltipProvider>));
  await settle();
  // The tab reads the file back after every write, the way the screen does.
  await act(async () => root.render(<TooltipProvider><FallbackChainsTab cwd="/p" snapshot={snapshot()} onApply={onApply} /></TooltipProvider>));
  await settle();
}

/** Re-render with the file as it now is, which is what a saved edit does. */
async function reread() {
  const onApply = async (scope: SettingsScope, changes: SettingChange[]) => {
    applied.push({ scope, changes });
    if (applyResult) for (const change of changes) chains = change.op === "set" ? change.value : undefined;
    return applyResult;
  };
  await act(async () => root.render(<TooltipProvider><FallbackChainsTab cwd="/p" snapshot={snapshot()} onApply={onApply} /></TooltipProvider>));
  await settle();
}

const cards = () => [...container.querySelectorAll<HTMLElement>('[data-slot="fallback-chain"]')];
const card = (index: number) => cards()[index]!;
const modelsIn = (index: number) =>
  [...card(index).querySelectorAll<HTMLElement>('[data-slot="chain-model"]')].map((row) => row.dataset["model"]);
const issuesIn = (index: number) => card(index).querySelector('[data-slot="chain-issues"]')?.textContent ?? "";
const button = (scope: HTMLElement, label: string) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
};
const press = async (target: HTMLButtonElement) => {
  // Every control is a real <button> with an accessible name, so the keyboard
  // reaches it exactly as the pointer does; activation is the same event.
  expect(target.tagName).toBe("BUTTON");
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
  await settle();
  await reread();
};

/** Open a chain's model picker and choose an option by its visible name. */
async function addModel(index: number, name: string) {
  const trigger = card(index).querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
  await act(async () => trigger.click());
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes(name),
  );
  expect(option, name).toBeDefined();
  await act(async () => option!.click());
  await settle();
  await reread();
}

const pickerOptions = async (index: number) => {
  const trigger = card(index).querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
  await act(async () => trigger.click());
  await settle();
  const names = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].map((item) => item.textContent ?? "");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  return names;
};

it("starts empty, says what a chain is and that only the first model starts it", async () => {
  await render();
  expect(cards()).toHaveLength(0);
  const empty = container.querySelector('[data-slot="fallback-empty"]')!;
  expect(empty.textContent).toContain("No fallback chains yet");
  expect(container.textContent).toContain("Only the first model in a list starts it.");
  // Nothing is written until a person makes one: no defaults, ever.
  expect(applied).toEqual([]);
});

it("saves a chain only once it has a model to fall back to", async () => {
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="add-chain"]')!.click());
  await settle();
  expect(card(0).dataset["draft"]).toBe("true");
  expect(issuesIn(0)).toContain("Choose the model this chain starts on.");

  await addModel(0, "Sonnet 4.5");
  // A chain of one is not a chain; nothing has been written yet.
  expect(applied).toEqual([]);
  expect(issuesIn(0)).toContain("Add a model to fall back to.");

  await addModel(0, "DeepSeek V3");
  expect(applied).toHaveLength(1);
  expect(applied[0]!.scope).toBe("global");
  expect(applied[0]!.changes).toEqual([
    { path: "fallbackChains", op: "set", value: [chain(["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"])] },
  ]);
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat"]);
  expect(card(0).textContent).toContain("Starts the chain");
  expect(card(0).textContent).toContain("the models above it are tried once each");
});

it("reorders, removes and deletes through named buttons, writing the whole list each time", async () => {
  chains = [chain(["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"], ["google", "gemini-2.5-pro"])];
  await render();
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat", "google/gemini-2.5-pro"]);

  await press(button(card(0), "Move Gemini 2.5 Pro up"));
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"]);

  await press(button(card(0), "Move Gemini 2.5 Pro down"));
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat", "google/gemini-2.5-pro"]);

  // The ends of the list offer no move that would do nothing.
  expect(button(card(0), "Move Sonnet 4.5 up").disabled).toBe(true);
  expect(button(card(0), "Move Gemini 2.5 Pro down").disabled).toBe(true);

  await press(button(card(0), "Remove DeepSeek V3 from this chain"));
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"]);

  await press(button(card(0), "Delete Sonnet 4.5’s chain"));
  expect(cards()).toHaveLength(0);
  expect(applied.at(-1)!.changes).toEqual([{ path: "fallbackChains", op: "set", value: [] }]);
});

it("offers no model twice in one chain, and no second chain on a model that already starts one", async () => {
  chains = [chain(["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"])];
  await render();
  // A model already in this chain is not on offer: the duplicate cannot be made.
  const inChain = await pickerOptions(0);
  expect(inChain.join(" ")).not.toContain("Sonnet 4.5");
  expect(inChain.join(" ")).not.toContain("DeepSeek V3");
  expect(inChain.join(" ")).toContain("Gemini 2.5 Pro");

  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="add-chain"]')!.click());
  await settle();
  // A new chain cannot start on a model that already starts one; DeepSeek can,
  // because being a fallback in another chain does not start anything.
  const starters = await pickerOptions(1);
  expect(starters.join(" ")).not.toContain("Sonnet 4.5");
  expect(starters.join(" ")).toContain("DeepSeek V3");
});

it("refuses an edit that would make two chains start on the same model, and writes nothing", async () => {
  chains = [
    chain(["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"]),
    chain(["google", "gemini-2.5-pro"], ["anthropic", "claude-sonnet-4-5"]),
  ];
  await render();
  // Promoting Sonnet inside the second chain would give two chains the same
  // starting model — the one thing the runtime could not resolve.
  await press(button(card(1), "Move Sonnet 4.5 up"));
  expect(container.querySelector('[data-slot="chain-refusal"]')?.textContent).toContain("already starts a chain");
  expect(applied).toEqual([]);
  expect(modelsIn(1)).toEqual(["google/gemini-2.5-pro", "anthropic/claude-sonnet-4-5"]);
});

it("puts the file back when the write is refused", async () => {
  chains = [chain(["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"], ["google", "gemini-2.5-pro"])];
  applyResult = false;
  await render();
  await press(button(card(0), "Remove DeepSeek V3 from this chain"));
  expect(applied).toHaveLength(1);
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat", "google/gemini-2.5-pro"]);
});
