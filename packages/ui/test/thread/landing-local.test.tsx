// @vitest-environment happy-dom
/**
 * D-341: a new chat is local until the person speaks. The landing's words come
 * from the destination this window already holds — never from the session the
 * host is creating, never from the agents snapshot — so they are there on the
 * first frame and identical after the answer lands.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@lasercode/protocol";
import type { MainDestination } from "../../src/runtime/main-destination.js";

const mocks = vi.hoisted(() => ({
  destination: undefined as unknown as MainDestination,
  session: undefined as SessionState | undefined,
  currentProject: undefined as string | undefined,
}));
vi.mock("../../src/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ destination: mocks.destination, currentProject: mocks.currentProject, actions: {} }),
  useLaserState: (selector: (state: unknown) => unknown) => selector({
    current: mocks.session?.path,
    open: mocks.session ? { [mocks.session.path]: { path: mocks.session.path, state: mocks.session } } : {},
    agents: { snapshot: { workspaces: { chat: "/private/chat", beam: "/private/beam" } }, runs: {}, events: [] },
    sessions: [], workers: {}, connection: "open",
  }),
  useSessionMeta: () => ({ session: mocks.session, path: mocks.session?.path }),
}));
vi.mock("@assistant-ui/react", async (importActual) => ({
  ...(await importActual<typeof import("@assistant-ui/react")>()),
  useAuiState: () => false,
}));
// The suggestion row sends through the thread runtime; what this file is about
// is the words the landing draws, so the row is its title and nothing else.
vi.mock("@/components/assistant-ui/elements/empty-state", async (importActual) => ({
  ...(await importActual<typeof import("../../src/components/assistant-ui/elements/empty-state.js")>()),
  EmptyStateSuggestion: ({ title }: { title: string }) => <li>{title}</li>,
}));

import { EmptyState, LANDING_DESCRIPTION } from "../../src/components/thread/EmptyState.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { agentInfo, sessionState } from "../agents/fixtures.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.session = undefined;
  mocks.currentProject = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (destination: MainDestination) => {
  mocks.destination = destination;
  await act(async () => root.render(<TooltipProvider><EmptyState /></TooltipProvider>));
};
const words = () => ({
  eyebrow: container.querySelector('[data-slot="empty-state-eyebrow"]')?.textContent,
  greeting: container.querySelector('[data-slot="empty-state-greeting"]')?.textContent,
  description: container.querySelector('[data-slot="empty-state-description"]')?.textContent,
  suggestions: [...container.querySelectorAll('[data-slot="empty-state-suggestions"] li')].map(li => li.textContent),
});
const project = { kind: "project-landing" as const, project: "/work/app" };

describe("the landing paints from local knowledge", () => {
  it("is drawn while the destination is still resolving, from the target it names", async () => {
    await render({ phase: "resolving", intent: 1, target: { kind: "project", project: "/work/app" }, rememberedCode: { kind: "no-project-landing" } });
    const seen = words();
    expect(seen.eyebrow).toBe("/work/app");
    expect(seen.greeting).toBe("app");
    expect(seen.description).toBe(LANDING_DESCRIPTION.code);
    expect(seen.suggestions).toHaveLength(3);
  });

  it("says the same words before the session exists and after it does", async () => {
    await render({ phase: "ready-code", intent: 1, code: project });
    const landing = words();
    expect(landing.description).toBe(LANDING_DESCRIPTION.code);
    // The host answered: a session exists, is current, and its own state could
    // say anything. Not one word may follow it.
    mocks.session = sessionState({ path: "/work/app/new.jsonl", cwd: "/work/app" });
    await render({ phase: "ready-code", intent: 1, code: { kind: "project-session", project: "/work/app", path: "/work/app/new.jsonl" } });
    expect(words()).toEqual(landing);
  });

  it("names the Chat workspace without waiting for its directory", async () => {
    await render({ phase: "ready-chat", intent: 1, chat: { kind: "landing" }, rememberedCode: project });
    const landing = words();
    expect(landing.eyebrow).toBe("Private workspace");
    expect(landing.greeting).toBe("Chat");
    expect(landing.description).toBe(LANDING_DESCRIPTION.chat);
    mocks.session = sessionState({ path: "/private/chat/c.jsonl", cwd: "/private/chat", agent: agentInfo({ kind: "chat" }) });
    await render({ phase: "ready-chat", intent: 1, chat: { kind: "session", path: "/private/chat/c.jsonl" }, rememberedCode: project });
    expect(words()).toEqual(landing);
  });

  it("still refuses when there is no project to start in", async () => {
    await render({ phase: "ready-code", intent: 1, code: { kind: "no-project-landing" } });
    expect(container.textContent).toContain("Open a project to start.");
    expect(container.querySelector('[data-slot="empty-state-suggestions"]')).toBeNull();
  });
});
