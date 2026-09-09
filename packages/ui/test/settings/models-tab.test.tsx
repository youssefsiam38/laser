// @vitest-environment happy-dom
/**
 * M13-T49: a model the `enabledModels` allow-list hides is in no picker, and
 * the Settings row used to look identical to an offered one. Every row now
 * carries a switch; the off side writes the product's own `disabledModels`
 * list (the engine's allow-list has no negation, proven in the worker), the
 * on side takes a reference off that list or lets a pattern-hidden model back
 * into the allow-list. Four row states, a provider's enable/disable all, the
 * three views and the count beside the editor, through the real tab with a
 * mocked client.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ProviderAuthInfo, SettingChange, SettingsScope, SettingsSnapshot } from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock("../../src/runtime/index.js", () => {
  const stable = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: mocks.toast } };
  return { useLaserStable: () => stable };
});
vi.mock("../../src/components/onboarding/index.js", () => ({ ProviderStep: () => null }));
vi.mock("../../src/components/settings/WebSearchTab.js", () => ({ WebSearchTab: () => null }));

import { ModelsTab } from "../../src/components/settings/ModelsTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;
let providers: ProviderAuthInfo[];
let models: ModelCatalogEntry[];
let patterns: string[] | null;
let disabledList: string[];
let applied: Array<{ scope: SettingsScope; changes: SettingChange[] }>;
let applyResult: boolean;
/** What the catalogue gains between one load and the next, the way a provider ships a new model. */
let arrivesLater: ModelCatalogEntry[] = [];

const model = (provider: string, id: string, hiddenByList: boolean): ModelCatalogEntry => ({
  provider,
  id,
  name: id,
  contextWindow: 200000,
  reasoning: false,
  vision: false,
  thinkingLevels: [],
  enabled: !hiddenByList,
  hiddenByList,
  switchedOff: false,
});
const provider = (id: string, configured: boolean): ProviderAuthInfo => ({ id, name: id, configured, oauth: false, subscription: false, modelCount: 1 });
const ref = (entry: Pick<ModelCatalogEntry, "provider" | "id">) => `${entry.provider}/${entry.id}`;

const snapshot = (global: Record<string, unknown>, project: Record<string, unknown> = {}): SettingsSnapshot => ({
  cwd: "/p",
  agentDir: "/a",
  global: { path: "/a/settings.json", exists: true, values: global },
  project: { path: "/p/project-settings.json", exists: true, values: project },
  effective: { ...global, ...project },
  projectTrust: { trusted: true, writable: true, reason: "trusted" },
});

/** The worker's view: the allow-list and the disable list, applied to whatever the catalogue holds now. */
function catalogue(): ModelCatalogEntry[] {
  const off = new Set(disabledList.map((entry) => entry.trim().toLowerCase()));
  return models.map((entry) => {
    const hiddenByList = !!patterns && !patterns.some((pattern) => pattern === ref(entry) || (pattern.endsWith("*") && entry.id.startsWith(pattern.slice(0, -1))));
    const switchedOff = off.has(ref(entry).toLowerCase());
    return { ...entry, hiddenByList, switchedOff, enabled: !hiddenByList && !switchedOff };
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  providers = [provider("openai", true), provider("anthropic", false)];
  patterns = ["gpt-5*"];
  disabledList = [];
  arrivesLater = [];
  models = [
    model("openai", "gpt-5", false),
    model("openai", "gpt-5-mini", false),
    model("openai", "gpt-6-astra", true),
    model("anthropic", "claude-sonnet-4", true),
  ];
  applied = [];
  applyResult = true;
  mocks.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "pi/providers/list") return { providers };
    if (method === "pi/models/catalog") {
      if (arrivesLater.length > 0) {
        models = [...models, ...arrivesLater];
        arrivesLater = [];
      }
      return { models: catalogue(), enabledPatterns: patterns, disabledModels: disabledList, errors: [] };
    }
    if (method === "pi/transcribe/status") return { available: true };
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function render(snap: SettingsSnapshot | undefined = snapshot({ enabledModels: patterns })) {
  const onApply = async (scope: SettingsScope, changes: SettingChange[]) => {
    applied.push({ scope, changes });
    if (applyResult) {
      for (const change of changes) {
        if (change.path === "enabledModels") patterns = change.op === "set" ? (change.value as string[]) : null;
        if (change.path === "disabledModels") disabledList = change.op === "set" ? (change.value as string[]) : [];
      }
    }
    return applyResult;
  };
  await act(async () => root.render(<TooltipProvider><ModelsTab cwd="/p" snapshot={snap} onApply={onApply} /></TooltipProvider>));
}

const rows = () => [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];
const rowIds = () => rows().map((r) => r.querySelector('[data-slot="model-switch"]')?.getAttribute("aria-label")?.replace(/^Switch (on|off) /, ""));
function row(id: string): HTMLTableRowElement {
  const tr = rows().find((r) => r.querySelector('[data-slot="model-switch"]')?.getAttribute("aria-label")?.endsWith(`/${id}`));
  expect(tr, id).toBeDefined();
  return tr!;
}
const stateOf = (id: string) => row(id).querySelector<HTMLElement>('[data-slot="offer-state"]')?.dataset["state"];
const switchOf = (id: string) => row(id).querySelector<HTMLButtonElement>('[data-slot="model-switch"]')!;
const isOn = (id: string) => switchOf(id).getAttribute("aria-checked") === "true";
const note = () => container.querySelector('[data-slot="offer-note"]')?.textContent;
const providerButton = (provider: string, label: "Enable" | "Disable") =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label} every ${provider} model"]`)!;
const enabledModelsWrites = () => applied.filter((entry) => entry.changes.some((change) => change.path === "enabledModels"));

async function chooseView(label: "All" | "Enabled" | "Hidden") {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="model-view"]')!;
  await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((entry) => entry.textContent?.startsWith(label));
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

// ---- row states ------------------------------------------------------------

it("gives every row a switch and says why a model is in no picker, with nothing on an offered one", async () => {
  await render();
  expect(stateOf("gpt-5")).toBeUndefined();
  expect(isOn("gpt-5")).toBe(true);
  expect(stateOf("gpt-6-astra")).toBe("hidden-by-list");
  expect(row("gpt-6-astra").textContent).toContain("Hidden by Enabled models");
  expect(isOn("gpt-6-astra")).toBe(false);
  // A missing key is a different reason with a different fix; the list is not
  // blamed, and the switch still shows the person's choice — on.
  expect(stateOf("claude-sonnet-4")).toBe("provider-not-connected");
  expect(row("claude-sonnet-4").textContent).toContain("Provider not signed in");
  expect(row("claude-sonnet-4").textContent).not.toContain("Enabled models");
  expect(isOn("claude-sonnet-4")).toBe(true);
});

it("shows a switched-off model as the person's own choice, quietly, before any other reason", async () => {
  disabledList = ["openai/gpt-5", "anthropic/claude-sonnet-4"];
  await render();
  expect(stateOf("gpt-5")).toBe("switched-off");
  expect(row("gpt-5").textContent).toContain("Switched off");
  expect(row("gpt-5").querySelector('[data-slot="offer-state"]')?.getAttribute("data-variant")).toBe("outline");
  expect(isOn("gpt-5")).toBe(false);
  // Off wins over the missing key: the row explains itself by the choice made here.
  expect(stateOf("claude-sonnet-4")).toBe("switched-off");
});

// ---- the allow-list count ---------------------------------------------------

it("counts what the allow-list hides beside its editor, for connected providers only and not for switched-off rows", async () => {
  await render();
  const count = container.querySelector('[data-slot="hidden-by-list"]');
  expect(count?.textContent).toContain("1 model from connected providers is hidden from the pickers by your allow-list patterns");
  expect(count?.className).toContain("text-attention");
});

it("shows no count when the list is unset, and a quiet one when it hides nothing", async () => {
  patterns = null;
  await render(snapshot({}));
  expect(container.querySelector('[data-slot="hidden-by-list"]')).toBeNull();
  expect(stateOf("gpt-6-astra")).toBeUndefined();
  patterns = ["gpt-*"];
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(snapshot({ enabledModels: patterns }));
  const count = container.querySelector('[data-slot="hidden-by-list"]');
  expect(count?.textContent).toContain("hide no model");
  expect(count?.className).not.toContain("text-attention");
});

// ---- the switch, on ---------------------------------------------------------

it("lets a pattern-hidden model back in with one switch without discarding the list", async () => {
  await render();
  await act(async () => switchOf("gpt-6-astra").click());
  expect(applied).toEqual([{ scope: "global", changes: [{ path: "enabledModels", op: "set", value: ["gpt-5*", "openai/gpt-6-astra"] }] }]);
  expect(stateOf("gpt-6-astra")).toBe("just-offered");
  expect(row("gpt-6-astra").textContent).toContain("Now in the pickers");
  expect(isOn("gpt-6-astra")).toBe(true);
  expect(note()).toContain("Added openai/gpt-6-astra to Enabled models in your global settings");
  expect(container.querySelector('[data-slot="hidden-by-list"]')?.textContent).toContain("hide no model");
});

it("writes to the project list when that is where the list lives", async () => {
  await render(snapshot({ enabledModels: ["claude-*"] }, { enabledModels: patterns }));
  await act(async () => switchOf("gpt-6-astra").click());
  expect(applied[0]?.scope).toBe("project");
  expect(note()).toContain("project settings");
});

it("switches a model back on by taking its reference off the disable list, and unsets an emptied list", async () => {
  disabledList = ["openai/gpt-5", "openai/gpt-5-mini"];
  await render();
  await act(async () => switchOf("gpt-5").click());
  expect(applied).toEqual([{ scope: "global", changes: [{ path: "disabledModels", op: "set", value: ["openai/gpt-5-mini"] }] }]);
  expect(isOn("gpt-5")).toBe(true);
  expect(stateOf("gpt-5")).toBe("just-offered");
  expect(note()).toBe("Switched on openai/gpt-5.");
  await act(async () => switchOf("gpt-5-mini").click());
  expect(applied[1]).toEqual({ scope: "global", changes: [{ path: "disabledModels", op: "unset" }] });
  expect(enabledModelsWrites()).toEqual([]);
});

it("switching on a model that is both off and pattern-hidden does both, in that order", async () => {
  disabledList = ["openai/gpt-6-astra"];
  await render();
  expect(stateOf("gpt-6-astra")).toBe("switched-off");
  await act(async () => switchOf("gpt-6-astra").click());
  expect(applied.map((entry) => entry.changes[0]!.path)).toEqual(["disabledModels", "enabledModels"]);
  expect(applied[1]!.changes[0]).toEqual({ path: "enabledModels", op: "set", value: ["gpt-5*", "openai/gpt-6-astra"] });
  expect(stateOf("gpt-6-astra")).toBe("just-offered");
});

// ---- the switch, off --------------------------------------------------------

it("switches a model off by naming exactly it in the disable list, never by touching the allow-list", async () => {
  await render();
  await act(async () => switchOf("gpt-5").click());
  expect(applied).toEqual([{ scope: "global", changes: [{ path: "disabledModels", op: "set", value: ["openai/gpt-5"] }] }]);
  expect(enabledModelsWrites()).toEqual([]);
  expect(stateOf("gpt-5")).toBe("switched-off");
  expect(isOn("gpt-5")).toBe(false);
  expect(note()).toBe("Switched off openai/gpt-5.");
  // The other offered model is untouched.
  expect(isOn("gpt-5-mini")).toBe(true);
});

it("keeps a model added to the catalogue later switched on after another was switched off", async () => {
  // The bug the whole task exists to avoid: an enumerated list written today
  // hides tomorrow's model. The disable list names what is off, nothing else.
  await render();
  arrivesLater = [model("openai", "gpt-5-nova", false)];
  await act(async () => switchOf("gpt-5").click());
  expect(disabledList).toEqual(["openai/gpt-5"]);
  expect(isOn("gpt-5-nova")).toBe(true);
  expect(stateOf("gpt-5-nova")).toBeUndefined();
  expect(isOn("gpt-5")).toBe(false);
});

it("writes the disable list to the project when the project sets one", async () => {
  await render(snapshot({ enabledModels: patterns }, { disabledModels: [] }));
  await act(async () => switchOf("gpt-5").click());
  expect(applied[0]?.scope).toBe("project");
});

it("keeps the row as it was and says nothing when the write is refused", async () => {
  applyResult = false;
  await render();
  await act(async () => switchOf("gpt-6-astra").click());
  expect(stateOf("gpt-6-astra")).toBe("hidden-by-list");
  expect(isOn("gpt-6-astra")).toBe(false);
  expect(switchOf("gpt-6-astra").disabled).toBe(false);
  await act(async () => switchOf("gpt-5").click());
  expect(isOn("gpt-5")).toBe(true);
  expect(note()).toBeUndefined();
});

it("holds the switch busy while the write is in flight", async () => {
  await render();
  let resolve!: (ok: boolean) => void;
  const pending = new Promise<boolean>((done) => { resolve = done; });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<TooltipProvider><ModelsTab cwd="/p" snapshot={snapshot({ enabledModels: patterns })} onApply={() => pending} /></TooltipProvider>));
  await act(async () => switchOf("gpt-5").click());
  expect(switchOf("gpt-5").disabled).toBe(true);
  expect(switchOf("gpt-5").getAttribute("aria-busy")).toBe("true");
  expect(providerButton("openai", "Disable").disabled).toBe(true);
  await act(async () => resolve(false));
  expect(switchOf("gpt-5").disabled).toBe(false);
});

// ---- a provider at once -----------------------------------------------------

it("disables every model of a provider in one write, skipping what is already off", async () => {
  disabledList = ["openai/gpt-5-mini"];
  await render();
  await act(async () => providerButton("openai", "Disable").click());
  expect(applied).toEqual([{ scope: "global", changes: [{ path: "disabledModels", op: "set", value: ["openai/gpt-5-mini", "openai/gpt-5", "openai/gpt-6-astra"] }] }]);
  expect(["gpt-5", "gpt-5-mini", "gpt-6-astra"].every((id) => stateOf(id) === "switched-off")).toBe(true);
  expect(note()).toBe("Switched off every openai model.");
  expect(providerButton("openai", "Disable").disabled).toBe(true);
  // Another provider's models are not the openai button's business.
  expect(stateOf("claude-sonnet-4")).toBe("provider-not-connected");
});

it("enables every model of a provider: off the disable list, and pattern-hidden ones into the allow-list", async () => {
  disabledList = ["openai/gpt-5", "anthropic/claude-sonnet-4"];
  await render();
  expect(providerButton("openai", "Enable").disabled).toBe(false);
  await act(async () => providerButton("openai", "Enable").click());
  expect(applied).toEqual([
    { scope: "global", changes: [{ path: "disabledModels", op: "set", value: ["anthropic/claude-sonnet-4"] }] },
    { scope: "global", changes: [{ path: "enabledModels", op: "set", value: ["gpt-5*", "openai/gpt-6-astra"] }] },
  ]);
  expect(["gpt-5", "gpt-5-mini", "gpt-6-astra"].every((id) => isOn(id))).toBe(true);
  expect(note()).toBe("Switched on every openai model.");
  expect(providerButton("openai", "Enable").disabled).toBe(true);
});

it("greys the provider action that would change nothing", async () => {
  await render();
  // gpt-6-astra is pattern-hidden, so Enable all still has work; nothing is off yet.
  expect(providerButton("openai", "Enable").disabled).toBe(false);
  expect(providerButton("openai", "Disable").disabled).toBe(false);
  patterns = null;
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(snapshot({}));
  expect(providerButton("openai", "Enable").disabled).toBe(true);
  expect(providerButton("openai", "Disable").disabled).toBe(false);
});

// ---- the three views --------------------------------------------------------

it("lists everything, only what is offered, or only what is hidden — each hidden row keeping its own reason", async () => {
  disabledList = ["openai/gpt-5-mini"];
  await render();
  expect(rowIds()).toEqual(["openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-6-astra", "anthropic/claude-sonnet-4"]);
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="model-view"]')!;
  expect(trigger().textContent).toContain("All");

  await chooseView("Enabled");
  expect(trigger().textContent).toContain("Enabled");
  expect(rowIds()).toEqual(["openai/gpt-5"]);

  await chooseView("Hidden");
  expect(rowIds()).toEqual(["openai/gpt-5-mini", "openai/gpt-6-astra", "anthropic/claude-sonnet-4"]);
  expect(stateOf("gpt-5-mini")).toBe("switched-off");
  expect(stateOf("gpt-6-astra")).toBe("hidden-by-list");
  expect(stateOf("claude-sonnet-4")).toBe("provider-not-connected");

  await chooseView("All");
  expect(rowIds()).toHaveLength(4);
});

it("says so, in words, when a view is empty", async () => {
  patterns = null;
  providers = [provider("openai", true), provider("anthropic", true)];
  await render(snapshot({}));
  await chooseView("Hidden");
  expect(rows()).toHaveLength(0);
  expect(container.textContent).toContain("Every model is offered. Nothing is hidden.");
});

// ---- the allow-list editor, under Advanced ----------------------------------

it("keeps the pattern editor folded under Advanced and writes it where the list lives", async () => {
  await render(snapshot({ enabledModels: ["claude-*"] }, { enabledModels: patterns }));
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="patterns-trigger"]')!;
  expect(trigger.textContent).toContain("Advanced");
  expect(trigger.textContent).toContain("1 pattern");
  expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Offer every model")).toBeUndefined();
  await act(async () => trigger.click());
  const offerEvery = [...container.querySelectorAll("button")].find((b) => b.textContent === "Offer every model")!;
  expect(offerEvery).toBeDefined();
  await act(async () => offerEvery.click());
  expect(applied).toEqual([{ scope: "project", changes: [{ path: "enabledModels", op: "unset" }] }]);
});

it("cannot blame a provider list it could not read", async () => {
  providers = [];
  await render();
  expect(stateOf("claude-sonnet-4")).toBe("hidden-by-list");
  expect(container.querySelector('[data-slot="hidden-by-list"]')?.textContent).toContain("2 models from connected providers are hidden");
});
