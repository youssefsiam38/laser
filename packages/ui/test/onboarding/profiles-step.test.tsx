// @vitest-environment happy-dom
/**
 * M22-T7: first run, the profile review step.
 *
 * A person connects a provider and Laser fills in Smart, Balanced and Fast
 * from what it offers. This step shows them: what each one reaches for first,
 * which one new conversations use, and two small edits — a different first
 * model, a different default. Doing nothing leaves the seeds exactly as they
 * are, which is what "skip" means here, so the test that matters most is the
 * one that asserts no write happened.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EMPTY_PROFILE_ASSIGNMENTS,
  type ModelCatalogEntry,
  type ModelProfile,
  type ProfileAssignments,
  type ProviderAuthInfo,
} from "@lasercode/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn(), notify: [] as Array<(method: string, params: unknown) => void> }));
vi.mock("@/runtime", () => {
  const stable = {
    client: {
      request: mocks.request,
      subscribe: (handler: (method: string, params: unknown) => void) => {
        mocks.notify.push(handler);
        return () => {
          mocks.notify = mocks.notify.filter((entry) => entry !== handler);
        };
      },
    },
    actions: { toast: mocks.toast },
  };
  return { useLaserStable: () => stable };
});

import { ProfilesStep } from "../../src/components/onboarding/ProfilesStep.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root, container: HTMLDivElement;
let profiles: ModelProfile[];
let assignments: ProfileAssignments;
let writes: Array<{ method: string; params: unknown }>;
let ready: boolean[];

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
  model("anthropic", "claude-opus-4-5", "Opus 4.5"),
  model("anthropic", "claude-sonnet-4-5", "Sonnet 4.5"),
  model("anthropic", "claude-haiku-4-5", "Haiku 4.5"),
];
const providers: ProviderAuthInfo[] = [
  { id: "anthropic", name: "Anthropic", configured: true, oauth: true, subscription: false, modelCount: 3 },
];

const seeded = (): ModelProfile[] => [
  { id: "mp_smart0000000000000", name: "Smart", models: [{ provider: "anthropic", id: "claude-opus-4-5" }, { provider: "anthropic", id: "claude-sonnet-4-5" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "mp_balanced0000000000", name: "Balanced", models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }, { provider: "anthropic", id: "claude-haiku-4-5" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "mp_fast00000000000000", name: "Fast", models: [{ provider: "anthropic", id: "claude-haiku-4-5" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!deviceStore.status().active) deviceStore.activate(testDescriptor());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  ready = [];
  mocks.notify = [];
  profiles = seeded();
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS, defaultProfileId: "mp_balanced0000000000", namingProfileId: "mp_fast00000000000000", oracleProfileId: "mp_smart0000000000000" };
  mocks.request.mockReset().mockImplementation(async (method: string, params: unknown) => {
    if (method === "pi/providers/list") return { providers };
    if (method === "pi/models/catalog") return { models: catalogue, enabledPatterns: null, disabledModels: [], errors: [] };
    if (method === "models/profiles/list") return { profiles, assignments };
    if (method === "models/profiles/save") {
      writes.push({ method, params });
      const { profile } = params as { profile: ModelProfile };
      profiles = profiles.map((entry) => (entry.id === profile.id ? { ...profile, updatedAt: "now" } : entry));
      return { profiles, assignments };
    }
    if (method === "pi/settings/set") {
      writes.push({ method, params });
      const { changes } = params as { changes: Array<{ path: string; op: string; value?: unknown }> };
      for (const change of changes) assignments = { ...assignments, [change.path]: change.op === "set" ? (change.value as string) : null };
      return { snapshot: {} };
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

async function render() {
  await act(async () => root.render(
    <TooltipProvider>
      <ProfilesStep cwd="/setup" onReady={(value) => ready.push(value)} />
    </TooltipProvider>,
  ));
  await settle();
}

const cards = () => [...container.querySelectorAll<HTMLElement>('[data-slot="setup-profile"]')];
const cardNamed = (name: string) => cards().find((entry) => entry.textContent?.includes(name))!;
const button = (scope: HTMLElement | Document, label: string) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
};

it("shows every seeded profile, what it reaches for first, and which one new conversations use", async () => {
  await render();
  expect(cards().map((entry) => entry.dataset["profile"])).toEqual([
    "mp_smart0000000000000",
    "mp_balanced0000000000",
    "mp_fast00000000000000",
  ]);
  const balanced = cardNamed("Balanced");
  expect(balanced.dataset["default"]).toBe("true");
  expect(balanced.querySelector('[data-slot="default-badge"]')!.textContent).toContain("New conversations");
  expect(balanced.textContent).toContain("Sonnet 4.5");
  expect(balanced.textContent).toContain("Haiku 4.5");
  expect(container.textContent).toContain("Titles are written by Fast, and second opinions come from Smart.");
  // Skipping the step means leaving the seeds: nothing is written by arriving.
  expect(writes).toEqual([]);
  expect(ready.at(-1)).toBe(true);
  // No engine vocabulary and none of the words profiles replaced.
  expect(container.textContent?.toLowerCase()).not.toContain("chain");
  expect(container.textContent?.toLowerCase()).not.toContain("tier");
});

it("points new conversations at another profile with one press", async () => {
  await render();
  await act(async () => button(cardNamed("Smart"), "Start new conversations on Smart").click());
  await settle();
  expect(writes).toEqual([
    { method: "pi/settings/set", params: { cwd: "/setup", scope: "global", changes: [{ path: "defaultProfileId", op: "set", value: "mp_smart0000000000000" }] } },
  ]);
  expect(cardNamed("Smart").dataset["default"]).toBe("true");
});

it("changes which model a profile reaches for first, keeping the rest behind it", async () => {
  await render();
  const trigger = cardNamed("Balanced").querySelector<HTMLButtonElement>('[data-slot="model-selector-trigger"]')!;
  await act(async () => trigger.click());
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes("Haiku 4.5"),
  )!;
  await act(async () => option.click());
  await settle();
  const saved = (writes.at(-1)!.params as { profile: ModelProfile }).profile;
  expect(saved.id).toBe("mp_balanced0000000000");
  expect(saved.models.map((entry) => entry.id)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
});

it("says so, and offers the way on, when nothing has been filled in yet", async () => {
  profiles = [];
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS };
  await render();
  expect(container.querySelector('[data-slot="profiles-pending"]')!.textContent).toContain("not filled in yet");
  expect(ready.at(-1)).toBe(false);

  profiles = seeded();
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS, defaultProfileId: "mp_balanced0000000000" };
  const again = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Check again"))!;
  await act(async () => again.click());
  await settle();
  expect(cards()).toHaveLength(3);
  expect(ready.at(-1)).toBe(true);
});

it("picks up the profiles the host seeds while the step is open", async () => {
  profiles = [];
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS };
  await render();
  expect(cards()).toHaveLength(0);

  profiles = seeded();
  assignments = { ...EMPTY_PROFILE_ASSIGNMENTS, defaultProfileId: "mp_balanced0000000000" };
  await act(async () => {
    for (const handler of mocks.notify) handler("models/profiles/seeded", { profiles });
  });
  await settle();
  expect(cards()).toHaveLength(3);
});

it("says what went wrong when the profiles cannot be read", async () => {
  mocks.request.mockImplementation(async (method: string) => {
    if (method === "pi/providers/list") return { providers };
    if (method === "pi/models/catalog") return { models: catalogue, enabledPatterns: null, disabledModels: [], errors: [] };
    throw new Error("the setup worker is not running");
  });
  await render();
  expect(container.textContent).toContain("Could not read your profiles");
  expect(container.textContent).toContain("the setup worker is not running");
  expect(ready.at(-1)).toBe(false);
});
