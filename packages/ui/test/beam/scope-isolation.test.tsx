// @vitest-environment happy-dom
/**
 * The bubble's thread and the main thread are two runtimes over one store
 * (`LaserThreadScope`). A delta for the Beam session must re-render only the
 * bubble's thread, and a delta for the main session only the main one — the
 * runtime-level half of test/runtime/isolation.test.ts, which pins the
 * reducer's part of the same promise.
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAuiState } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));

import { beamWorkspace, isBeamSession } from "../../src/components/beam/beam-model.js";
import { LaserProvider, LaserThreadScope, useLaserStable, useLaserView, useSessionMeta } from "../../src/runtime/LaserProvider.js";
import type { AppState } from "../../src/store.js";
import { addSession, BEAM_CWD, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "./fake-host.js";

const MAIN = `${PROJECT_CWD}/main.jsonl`;
const BEAM = `${BEAM_CWD}/beam.jsonl`;

const renders: Record<string, number> = {};
const texts: Record<string, string> = {};

/** Reads what a transcript reads: the runtime's messages and the scoped view. */
function Probe({ id }: { id: string }) {
  renders[id] = (renders[id] ?? 0) + 1;
  const messages = useAuiState((s) => s.thread.messages);
  const view = useLaserView();
  const meta = useSessionMeta();
  texts[id] = messages.map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("")).join("|");
  return (
    <span data-slot={`probe-${id}`} data-path={view?.path ?? ""} data-model={meta.model?.id ?? ""}>
      {texts[id]}
    </span>
  );
}

function OpenMain() {
  const { actions } = useLaserStable();
  const done = useRef(false);
  if (!done.current) {
    done.current = true;
    void actions.openSession(MAIN);
  }
  return null;
}

const filter = (session: { cwd: string; agent?: AppState["sessions"][number]["agent"] }, state: AppState) => isBeamSession(session, state.agents.snapshot);
const createIn = (state: AppState) => beamWorkspace(state.agents.snapshot);

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <OpenMain />
      <Probe id="main" />
      <LaserThreadScope path={BEAM} onPathChange={() => {}} filter={filter} createIn={createIn} unavailable="Beam is still connecting.">
        <Probe id="beam" />
        <ScopedSetModel />
      </LaserThreadScope>
    </LaserProvider>
  );
}

/** The composer's model control inside the bubble calls the scoped actions. */
function ScopedSetModel() {
  const { actions, currentProject } = useLaserStable();
  return <button data-slot="scoped-set-model" data-project={currentProject ?? ""} onClick={() => void actions.setModel({ provider: "openai", id: "gpt-fast" })} />;
}

let container: HTMLDivElement;
let root: Root;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  for (const key of Object.keys(renders)) delete renders[key];
  world = createWorld();
  addSession(world, MAIN, PROJECT_CWD);
  addSession(world, BEAM, BEAM_CWD);
  world.overrides["pi/model/set"] = (params: { path: string; model: { provider: string; id: string } }) => ({ state: { ...world.states[params.path]!, model: params.model } });
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const deliver = (sessionPath: string, seq: number, update: Parameters<typeof FakeHostClient.current.notify<"session/update">>[1]["update"]) =>
  FakeHostClient.current.notify("session/update", { sessionPath, seq, at: "2026-09-08T10:00:00.000Z", update });

describe("scope isolation", () => {
  it("streams into the Beam session without re-rendering the main thread, and the other way round", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => settle(20));
    expect(container.querySelector('[data-slot="probe-main"]')?.getAttribute("data-path")).toBe(MAIN);
    expect(container.querySelector('[data-slot="probe-beam"]')?.getAttribute("data-path")).toBe(BEAM);

    const before = { ...renders };
    await act(async () => {
      deliver(BEAM, 1, { kind: "message_start", role: "assistant" });
      deliver(BEAM, 2, { kind: "text_delta", delta: "hello from Beam", contentIndex: 0 });
    });
    await act(async () => settle(5));
    expect(renders.main).toBe(before.main);
    expect(renders.beam).toBeGreaterThan(before.beam!);
    expect(container.querySelector('[data-slot="probe-beam"]')?.textContent).toContain("hello from Beam");
    expect(container.querySelector('[data-slot="probe-main"]')?.textContent).toBe("");

    const middle = { ...renders };
    await act(async () => {
      deliver(MAIN, 1, { kind: "message_start", role: "assistant" });
      deliver(MAIN, 2, { kind: "text_delta", delta: "hello from the project", contentIndex: 0 });
    });
    await act(async () => settle(5));
    expect(renders.beam).toBe(middle.beam);
    expect(renders.main).toBeGreaterThan(middle.main!);
    expect(container.querySelector('[data-slot="probe-main"]')?.textContent).toContain("hello from the project");
    expect(container.querySelector('[data-slot="probe-beam"]')?.textContent).toBe("hello from Beam");
  });

  it("binds the session-bound actions to the scope's session, not the main one", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => settle(20));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="scoped-set-model"]')!.click());
    await act(async () => settle(5));
    const set = world.calls.filter((call) => call.method === "pi/model/set");
    expect(set).toHaveLength(1);
    expect(set[0]!.params).toMatchObject({ path: BEAM, model: { provider: "openai", id: "gpt-fast" } });
    expect(container.querySelector('[data-slot="probe-beam"]')?.getAttribute("data-model")).toBe("gpt-fast");
    expect(container.querySelector('[data-slot="probe-main"]')?.getAttribute("data-model")).toBe("");
    // The scope's "current project" is Beam's workspace, so the composer never asks for a project.
    expect(container.querySelector('[data-slot="scoped-set-model"]')?.getAttribute("data-project")).toBe(BEAM_CWD);
  });

  it("opens the scoped session quietly and keeps it attached while the scope holds it", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => settle(20));
    const detached = world.calls.filter((call) => call.method === "pi/session/detach").map((call) => (call.params as { path: string }).path);
    expect(detached).not.toContain(BEAM);
    expect(container.querySelector('[data-slot="probe-main"]')?.getAttribute("data-path")).toBe(MAIN);
  });
});
