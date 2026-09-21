// @vitest-environment happy-dom
/**
 * M22-T8: the composer's model control on profiles.
 *
 * It shows the conversation's **profile** and, beneath it, the **model
 * answering right now**; choosing another profile re-anchors the conversation
 * (`session/profile/set`), and choosing one model pins it with nothing to move
 * to, which the control says in those words. The position pill stays
 * decorative — the trigger's accessible name already carries it, and a person
 * using a screen reader must not hear it twice (M15-T3).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, ModelRef, SessionFallbackSummary, SessionState } from "@lasercode/protocol";

const state = vi.hoisted(() => ({
  fallback: undefined as SessionFallbackSummary | undefined,
  profile: { id: "mp_balanced0000000000", name: "Balanced" } as SessionState["profile"],
  pinned: undefined as boolean | undefined,
  path: "/p/s.jsonl" as string | undefined,
}));
const stable = vi.hoisted(() => ({
  client: {
    request: vi.fn(async (method: string) => {
      if (method === "models/profiles/list") {
        return {
          profiles: [
            { id: "mp_balanced0000000000", name: "Balanced", models: [{ provider: "deepseek", id: "deepseek-chat" }], origin: "seeded", updatedAt: "" },
            { id: "mp_smart0000000000000", name: "Smart", models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }], origin: "seeded", updatedAt: "" },
          ] satisfies ModelProfile[],
          assignments: { defaultProfileId: "mp_balanced0000000000", namingProfileId: null, oracleProfileId: null, designIndexProfileId: null },
        };
      }
      return {};
    }),
    subscribe: () => () => {},
  },
  actions: {
    listModels: vi.fn(async (): Promise<ModelRef[]> => [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
      { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" },
    ]),
    setModel: vi.fn(async () => undefined),
    setProfile: vi.fn(async () => undefined),
    toast: vi.fn(),
  },
  currentProject: "/p",
}));
vi.mock("@/runtime", () => ({
  useLaserStable: () => stable,
  useLaserState: (selector: (s: unknown) => unknown) => selector({ workers: {}, connection: "connected", agents: { snapshot: null } }),
  useSessionMeta: () => ({
    model: { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" },
    session: {
      ...(state.path ? { path: state.path } : {}),
      cwd: "/p",
      profile: state.profile,
      ...(state.pinned !== undefined ? { pinned: state.pinned } : {}),
      ...(state.fallback ? { fallback: state.fallback } : {}),
    },
  }),
}));

import { SessionModelSelector } from "../../src/components/assistant-ui/elements/model-selector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root, container: HTMLDivElement;

const models: ModelRef[] = [
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
  state.profile = { id: "mp_balanced0000000000", name: "Balanced" };
  state.pinned = undefined;
  state.path = "/p/s.jsonl";
  stable.actions.setModel.mockClear();
  stable.actions.setProfile.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async () => {
  await act(async () => root.render(<TooltipProvider><SessionModelSelector /></TooltipProvider>));
  await settle();
};
const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="session-model-trigger"]')!;
const secondary = () => container.querySelector<HTMLElement>('[data-slot="session-model-secondary"]')?.textContent;
const badge = () => container.querySelector<HTMLElement>('[data-slot="profile-position-badge"]');

/** Open the control and choose the row whose text contains `name`. */
async function choose(name: string) {
  await act(async () => trigger().click());
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes(name),
  );
  expect(option, name).toBeDefined();
  await act(async () => option!.click());
  await settle();
}

it("shows the profile as the intent and the model answering beneath it", async () => {
  await render();
  expect(trigger().textContent).toContain("Balanced");
  expect(secondary()).toBe("DeepSeek V3");
  expect(badge()).toBeNull();
  expect(trigger().getAttribute("aria-label")).toBe("Profile: Balanced, running on DeepSeek V3");
});

it("says where in the profile the conversation is, and reads it out only once", async () => {
  state.fallback = { profileId: "mp_balanced0000000000", models, position: 1 };
  await render();
  // The name is the model actually in use, not the profile's first model.
  expect(secondary()).toBe("DeepSeek V3");
  expect(badge()?.textContent).toBe("2/3");
  expect(badge()?.getAttribute("aria-hidden")).toBe("true");
  expect(trigger().getAttribute("aria-label")).toBe("Profile: Balanced, running on DeepSeek V3, model 2 of 3 in this profile");
});

it("says a move is happening while one is, in the profile's own word", async () => {
  state.fallback = { profileId: "mp_balanced0000000000", models, position: 1, switching: true };
  await render();
  expect(badge()?.textContent).toBe("moving");
  expect(badge()?.dataset["switching"]).toBe("true");
  expect(trigger().getAttribute("aria-label")).toBe("Profile: Balanced, running on DeepSeek V3, moving to another model in this profile");
});

it("draws no position pill for a profile of one model", async () => {
  state.fallback = { profileId: "mp_balanced0000000000", models: [models[1]!], position: 0 };
  await render();
  expect(badge()).toBeNull();
});

it("says a pinned conversation has nothing to move to", async () => {
  state.profile = null;
  state.pinned = true;
  await render();
  expect(trigger().textContent).toContain("DeepSeek V3");
  expect(secondary()).toBe("Pinned · no fallback");
  expect(trigger().getAttribute("aria-label")).toBe("Pinned to DeepSeek V3, no other model steps in");
});

it("re-anchors the conversation when another profile is chosen", async () => {
  await render();
  await choose("Smart");
  expect(stable.actions.setProfile).toHaveBeenCalledWith("mp_smart0000000000000");
  expect(stable.actions.setModel).not.toHaveBeenCalled();
});

it("pins the conversation when one model is chosen, and says what pinning costs", async () => {
  await render();
  await act(async () => trigger().click());
  await settle();
  const menu = document.querySelector<HTMLElement>('[data-slot="model-selector-content"]')!;
  expect(menu.textContent).toContain("nothing to move to if it stops answering");
  const option = [...menu.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')].find((item) =>
    item.textContent?.includes("Sonnet 4.5"),
  )!;
  await act(async () => option.click());
  await settle();
  expect(stable.actions.setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" });
  expect(stable.actions.setProfile).not.toHaveBeenCalled();
});

it("says what a new conversation in this project will start on when none is open", async () => {
  state.path = undefined;
  state.profile = null;
  await render();
  expect(trigger().getAttribute("aria-label")).toContain("New conversations start on Balanced");
});
