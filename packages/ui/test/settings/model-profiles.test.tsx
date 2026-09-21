// @vitest-environment happy-dom
/**
 * M22-T6: Settings → Providers and models → Model profiles.
 *
 * Through the real tab with a mocked host: the empty state, making a profile,
 * reordering and removing models, renaming, duplicating, the two delete paths
 * (nothing points at it / something does, and the replacement travels in the
 * same request), a model whose provider is gone, the assignment pickers and
 * the error state. Every control is a real button or input with an accessible
 * name, which is what makes the keyboard path the same path.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EMPTY_PROFILE_ASSIGNMENTS,
  MODEL_PROFILE_ID_PATTERN,
  type AgentsSnapshot,
  type ModelCatalogEntry,
  type ModelProfile,
  type ProfileAssignments,
  type ProviderAuthInfo,
  type SettingChange,
  type SettingsScope,
} from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn(), agents: { snapshot: null as AgentsSnapshot | null } }));
vi.mock("@/runtime", () => {
  const stable = { client: { request: mocks.request, subscribe: () => () => {} }, actions: { toast: mocks.toast } };
  return {
    useLaserStable: () => stable,
    useLaserState: (selector: (state: { agents: { snapshot: AgentsSnapshot | null } }) => unknown) =>
      selector({ agents: mocks.agents }),
  };
});

import { ModelProfilesTab } from "../../src/components/settings/models/ModelProfilesTab.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root, container: HTMLDivElement;
let applied: Array<{ scope: SettingsScope; changes: SettingChange[] }>;
let profiles: ModelProfile[];
let assignments: ProfileAssignments;
let listFails: string | undefined;
let saveFails: string | undefined;
/** Every `models/profiles/save` and `delete` the tab sent, in order. */
let writes: Array<{ method: string; params: unknown }>;

const model = (provider: string, id: string, name: string): ModelCatalogEntry => ({
  provider,
  id,
  name,
  contextWindow: 200000,
  reasoning: false,
  vision: false,
  thinkingLevels: ["off", "medium", "high"],
  enabled: true,
});
const catalogue = [
  model("anthropic", "claude-sonnet-4-5", "Sonnet 4.5"),
  model("deepseek", "deepseek-chat", "DeepSeek V3"),
  model("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
];
const providers: ProviderAuthInfo[] = ["anthropic", "deepseek", "google"].map((id) => ({
  id,
  name: id,
  configured: true,
  oauth: false,
  subscription: false,
  modelCount: 1,
}));

const profile = (id: string, name: string, models: Array<[string, string]>): ModelProfile => ({
  id,
  name,
  models: models.map(([provider, modelId]) => ({ provider, id: modelId })),
  origin: "person",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!deviceStore.status().active) deviceStore.activate(testDescriptor());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  applied = [];
  writes = [];
  profiles = [];
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS };
  listFails = undefined;
  saveFails = undefined;
  mocks.agents.snapshot = null;
  mocks.request.mockReset().mockImplementation(async (method: string, params: unknown) => {
    if (method === "pi/providers/list") return { providers };
    if (method === "pi/models/catalog") return { models: catalogue, enabledPatterns: null, disabledModels: [], errors: [] };
    if (method === "models/profiles/list") {
      if (listFails) throw new Error(listFails);
      return { profiles, assignments };
    }
    if (method === "models/profiles/save") {
      writes.push({ method, params });
      if (saveFails) throw new Error(saveFails);
      const { profile: saved } = params as { profile: ModelProfile };
      const stamped = { ...saved, updatedAt: "2026-02-02T00:00:00.000Z" };
      profiles = profiles.some((entry) => entry.id === saved.id)
        ? profiles.map((entry) => (entry.id === saved.id ? stamped : entry))
        : [...profiles, stamped];
      return { profiles, assignments };
    }
    if (method === "models/profiles/delete") {
      writes.push({ method, params });
      const { id, replacementId } = params as { id: string; replacementId?: string };
      profiles = profiles.filter((entry) => entry.id !== id);
      if (replacementId) {
        assignments = Object.fromEntries(
          Object.entries(assignments).map(([key, value]) => [key, value === id ? replacementId : value]),
        ) as ProfileAssignments;
      }
      return { profiles, assignments };
    }
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const onApply = async (scope: SettingsScope, changes: SettingChange[]) => {
  applied.push({ scope, changes });
  for (const change of changes) {
    if (change.op === "set") assignments = { ...assignments, [change.path]: change.value as string };
    else assignments = { ...assignments, [change.path]: null };
  }
  return true;
};

async function render(scopeView: "global" | "project" = "global") {
  await act(async () => root.render(
    <TooltipProvider>
      <ModelProfilesTab cwd="/p" scopeView={scopeView} onApply={onApply} />
    </TooltipProvider>,
  ));
  await settle();
}

const cards = () => [...container.querySelectorAll<HTMLElement>('[data-slot="model-profile"]')];
const card = (index: number) => cards()[index]!;
const modelsIn = (index: number) =>
  [...card(index).querySelectorAll<HTMLElement>('[data-slot="profile-model"]')].map((row) => row.dataset["model"]);
const named = <T extends HTMLElement>(scope: HTMLElement | Document, label: string): T => {
  const found = [...scope.querySelectorAll<HTMLElement>("button, input, select")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
  expect(found, label).toBeDefined();
  return found as T;
};
/** Type into a React-controlled field the way a person does. */
const type = async (field: HTMLInputElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

const press = async (target: HTMLButtonElement) => {
  expect(target.tagName).toBe("BUTTON");
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
  await settle();
};

/** Open a picker inside `scope` and choose the option whose text contains `name`. */
async function choose(scope: HTMLElement, triggerSlot: string, name: string) {
  const trigger = scope.querySelector<HTMLButtonElement>(`[data-slot="${triggerSlot}"]`)!;
  await act(async () => trigger.click());
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes(name),
  );
  expect(option, name).toBeDefined();
  await act(async () => option!.click());
  await settle();
}

it("starts with a designed empty state, and writes nothing until a person makes a profile", async () => {
  await render();
  expect(cards()).toHaveLength(0);
  const empty = container.querySelector('[data-slot="profiles-empty"]')!;
  expect(empty.textContent).toContain("No model profiles yet");
  expect(writes).toEqual([]);
  expect(applied).toEqual([]);
  // No engine vocabulary, and none of the words this feature replaced.
  expect(container.textContent?.toLowerCase()).not.toContain("chain");
  expect(container.textContent?.toLowerCase()).not.toContain("tier");
});

it("makes a profile from a name and an ordered list of models, with an id the protocol accepts", async () => {
  await render();
  await press(container.querySelector<HTMLButtonElement>('[data-slot="add-profile"]')!);
  const draft = container.querySelector<HTMLElement>('[data-slot="model-profile"][data-draft="true"]')!;
  expect(draft.textContent).toContain("Choose the model this profile should use first.");

  await type(named<HTMLInputElement>(draft, "Name for the new profile"), "Deep work");
  await choose(draft, "model-selector-trigger", "Sonnet 4.5");
  await choose(container.querySelector<HTMLElement>('[data-draft="true"]')!, "model-selector-trigger", "DeepSeek V3");

  // Nothing is written while the profile is being made: it is a draft.
  expect(writes).toEqual([]);
  await press(container.querySelector<HTMLButtonElement>('[data-slot="create-profile"]')!);

  expect(writes).toHaveLength(1);
  const saved = (writes[0]!.params as { profile: ModelProfile }).profile;
  expect(saved.name).toBe("Deep work");
  expect(saved.models).toEqual([
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "deepseek", id: "deepseek-chat" },
  ]);
  expect(saved.id).toMatch(MODEL_PROFILE_ID_PATTERN);
  expect(saved.origin).toBe("person");
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat"]);
});

it("reorders, removes and renames through named controls, saving the whole profile each time", async () => {
  profiles = [profile("mp_balanced00000000", "Balanced", [["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"], ["google", "gemini-2.5-pro"]])];
  await render();
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat", "google/gemini-2.5-pro"]);

  await press(named<HTMLButtonElement>(card(0), "Move Gemini 2.5 Pro up"));
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"]);

  // Neither end offers a move that would do nothing.
  expect(named<HTMLButtonElement>(card(0), "Move Sonnet 4.5 up").disabled).toBe(true);
  expect(named<HTMLButtonElement>(card(0), "Move DeepSeek V3 down").disabled).toBe(true);

  await press(named<HTMLButtonElement>(card(0), "Remove DeepSeek V3 from Balanced"));
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"]);

  const nameField = named<HTMLInputElement>(card(0), "Name of the Balanced profile");
  await type(nameField, "Everyday");
  await act(async () => nameField.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
  expect((writes.at(-1)!.params as { profile: ModelProfile }).profile.name).toBe("Everyday");
  // Renaming never mints a new id, so nothing that points here breaks.
  expect((writes.at(-1)!.params as { profile: ModelProfile }).profile.id).toBe("mp_balanced00000000");
});

it("duplicates a profile under a free name and keeps its models in order", async () => {
  profiles = [profile("mp_balanced00000000", "Balanced", [["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"]])];
  await render();
  await press(named<HTMLButtonElement>(card(0), "Duplicate Balanced"));
  const copy = (writes.at(-1)!.params as { profile: ModelProfile }).profile;
  expect(copy.name).toBe("Balanced copy");
  expect(copy.id).not.toBe("mp_balanced00000000");
  expect(copy.models.map((m) => m.id)).toEqual(["claude-sonnet-4-5", "deepseek-chat"]);
  expect(cards()).toHaveLength(2);
});

it("keeps a model whose provider is gone, and says it is not connected instead of dropping it", async () => {
  profiles = [profile("mp_balanced00000000", "Balanced", [["anthropic", "claude-sonnet-4-5"], ["mistral", "mistral-large"]])];
  await render();
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "mistral/mistral-large"]);
  const gone = card(0).querySelector<HTMLElement>('[data-slot="profile-model"][data-unavailable="true"]')!;
  expect(gone.dataset["model"]).toBe("mistral/mistral-large");
  expect(gone.textContent).toContain("Not connected");
  expect(gone.textContent).toContain("skipped until it comes back");
  // Nothing was written: an unavailable model is not an edit.
  expect(writes).toEqual([]);
});

it("offers no model twice in one profile", async () => {
  profiles = [profile("mp_balanced00000000", "Balanced", [["anthropic", "claude-sonnet-4-5"]])];
  await render();
  const trigger = card(0).querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
  await act(async () => trigger.click());
  await settle();
  const offered = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].map((item) => item.textContent ?? "");
  expect(offered.join(" ")).not.toContain("Sonnet 4.5");
  expect(offered.join(" ")).toContain("DeepSeek V3");
});

it("deletes a profile nothing points at without asking for a replacement", async () => {
  profiles = [profile("mp_a0000000000000000", "Smart", [["anthropic", "claude-sonnet-4-5"]]), profile("mp_b0000000000000000", "Fast", [["deepseek", "deepseek-chat"]])];
  await render();
  expect(card(0).querySelector('[data-slot="profile-usage"]')!.textContent).toContain("Nothing uses this profile yet.");
  await press(named<HTMLButtonElement>(card(0), "Delete Smart"));
  const dialog = document.querySelector<HTMLElement>('[data-slot="delete-profile-dialog"]')!;
  expect(dialog.textContent).toContain("Delete Smart?");
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Delete"))!;
  expect(confirm.disabled).toBe(false);
  await press(confirm);
  expect(writes.at(-1)).toEqual({ method: "models/profiles/delete", params: { cwd: "/p", id: "mp_a0000000000000000" } });
  expect(cards()).toHaveLength(1);
});

it("will not delete a referenced profile without a replacement, and moves the references in the same request", async () => {
  profiles = [profile("mp_a0000000000000000", "Smart", [["anthropic", "claude-sonnet-4-5"]]), profile("mp_b0000000000000000", "Fast", [["deepseek", "deepseek-chat"]])];
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS, defaultProfileId: "mp_a0000000000000000" };
  mocks.agents.snapshot = {
    revision: 1,
    agents: [],
    defaultAgent: "default",
    warnings: [],
    policy: { maxDepth: 3, foregroundCommandSeconds: 30 },
    builtinProfiles: { beam: "mp_a0000000000000000", chat: null, namer: null },
    builtinInstructions: {},
    renamedAgents: {},
    workspaces: { beam: "/beam", chat: "/chat" },
  } as unknown as AgentsSnapshot;
  await render();
  expect(card(0).querySelector('[data-slot="profile-usage"]')!.textContent).toBe("Used by New conversations and 1 agent.");

  await press(named<HTMLButtonElement>(card(0), "Delete Smart"));
  const dialog = document.querySelector<HTMLElement>('[data-slot="delete-profile-dialog"]')!;
  expect(dialog.textContent).toContain("New conversations, 1 agent");
  const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Delete"))!;
  expect(confirm.disabled).toBe(true);

  await choose(dialog, "profile-picker-trigger", "Fast");
  const stillOpen = document.querySelector<HTMLElement>('[data-slot="delete-profile-dialog"]')!;
  const ready = [...stillOpen.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Delete"))!;
  expect(ready.disabled).toBe(false);
  await press(ready);
  expect(writes.at(-1)).toEqual({
    method: "models/profiles/delete",
    params: { cwd: "/p", id: "mp_a0000000000000000", replacementId: "mp_b0000000000000000" },
  });
});

it("assigns a profile to each surface, writing one global setting per choice", async () => {
  profiles = [profile("mp_a0000000000000000", "Smart", [["anthropic", "claude-sonnet-4-5"]]), profile("mp_b0000000000000000", "Fast", [["deepseek", "deepseek-chat"]])];
  await render();
  const assignmentsSection = container.querySelector<HTMLElement>('[data-slot="profile-assignments"]')!;
  const row = assignmentsSection.querySelector<HTMLElement>('[data-setting="namingProfileId"]')!;
  expect(row.textContent).toContain("Naming conversations");
  await choose(row, "profile-picker-trigger", "Fast");
  expect(applied).toEqual([
    { scope: "global", changes: [{ path: "namingProfileId", op: "set", value: "mp_b0000000000000000" }] },
  ]);
});

it("says what went wrong when the profiles cannot be read, and offers the way back", async () => {
  listFails = "the project’s agent is not running";
  await render();
  expect(container.textContent).toContain("Couldn’t read your model profiles");
  expect(container.textContent).toContain("the project’s agent is not running");
  listFails = undefined;
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Retry"))!;
  await press(retry);
  expect(container.textContent).not.toContain("Couldn’t read your model profiles");
});

it("shows the host's refusal where the person is looking, and keeps the profile on screen", async () => {
  profiles = [profile("mp_a0000000000000000", "Smart", [["anthropic", "claude-sonnet-4-5"], ["deepseek", "deepseek-chat"]])];
  saveFails = "Another profile is already called “Smart”.";
  await render();
  await press(named<HTMLButtonElement>(card(0), "Remove DeepSeek V3 from Smart"));
  expect(container.querySelector('[data-slot="profile-refusal"]')!.textContent).toContain("already called");
  expect(modelsIn(0)).toEqual(["anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat"]);
});

it("is read-only outside Global, and says where the profiles live", async () => {
  profiles = [profile("mp_a0000000000000000", "Smart", [["anthropic", "claude-sonnet-4-5"]])];
  await render("project");
  expect(container.textContent).toContain("Model profiles are yours, not a project’s. Choose Global above to edit them.");
  expect(container.querySelector<HTMLButtonElement>('[data-slot="add-profile"]')!.disabled).toBe(true);
  expect([...card(0).querySelectorAll("button")].some((b) => b.getAttribute("aria-label")?.startsWith("Delete"))).toBe(false);
});
