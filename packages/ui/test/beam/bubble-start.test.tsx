// @vitest-environment happy-dom
/**
 * Opening the bubble starts exactly one chat (M16-T47 · review #22).
 *
 * The start effect reads the agents snapshot, and the host republishes that
 * snapshot whenever anything about an agent changes — a new object every time,
 * equal revision included. If the effect restarts on that identity it abandons
 * the session it just asked for and asks for another: two Beam sessions, one of
 * them orphaned, for an event that says nothing about starting a chat.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));
vi.mock("@/components/thread/Thread", async () => ({ Thread: (await import("./thread-stub.js")).ThreadStub }));

import { BeamBubble } from "../../src/components/beam/BeamBubble.js";
import { BeamSpark } from "../../src/components/beam/BeamSpark.js";
import { beamStore } from "../../src/components/beam/beam-store.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider } from "../../src/runtime/LaserProvider.js";
import { BEAM_CWD, createWorld, FakeHostClient, settle, type World } from "./fake-host.js";

const shell: ShellContextValue = {
  layout: "desktop",
  sessionsOpen: false,
  telemetryOpen: false,
  setSessionsOpen: () => {},
  setTelemetryOpen: () => {},
  toggleSessions: () => {},
  toggleTelemetry: () => {},
  historyOpen: false,
  setHistoryOpen: () => {},
  openHistory: () => {},
  addProjectOpen: false,
  setAddProjectOpen: () => {},
  newSession: async () => {},
  canCreate: true,
  showChat: () => {},
  returnToChat: () => {},
};

let container: HTMLDivElement;
let root: Root;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  FakeHostClient.reset(world);
  beamStore.reset();
  sessionsList.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// Verified as sound today: the start effect does re-run on the snapshot's
// identity, but every creation goes through the shared session launcher, which
// coalesces concurrent requests for one workspace and agent and then reuses an
// unstarted session. Two starts are one session, adopted by the bubble.
it("starts one chat even when the agents snapshot is republished mid-start", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const create = FakeHostClient.world.overrides;
  let created = 0;
  create["session/new"] = ((params: { path?: string; cwd?: string; agentName?: string }) => held.then(() => {
    const cwd = params.path ?? params.cwd!;
    const path = `${cwd}/held-${++created}.jsonl`;
    const state = { ...world.states[Object.keys(world.states)[0] ?? ""], path, id: path, cwd, model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0, agent: { agentName: "beam", kind: "beam" as const } };
    world.states[path] = state as never;
    return { state };
  })) as never;

  await act(async () => root.render(
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <ShellContext.Provider value={shell}>
          <BeamSpark side="right" size="icon" />
          <BeamBubble />
        </ShellContext.Provider>
      </TooltipProvider>
    </LaserProvider>,
  ));
  await act(async () => settle(10));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="beam-spark"]')!.click());
  await act(async () => settle(5));
  expect(world.calls.filter((call) => call.method === "session/new")).toHaveLength(1);

  // The host republishes the same agents snapshot: a new object, nothing new
  // to say about starting a chat.
  await act(async () => {
    FakeHostClient.current.notify("agents/updated", { ...world.snapshot });
    await settle(5);
  });
  await act(async () => { release(); await settle(30); });

  expect(world.calls.filter((call) => call.method === "session/new")).toHaveLength(1);
  expect(beamStore.getSnapshot().path).toBe(`${BEAM_CWD}/held-1.jsonl`);
});
