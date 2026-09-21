// @vitest-environment happy-dom
/**
 * A scope's thread list survives its own re-renders (M16-T47 · review #4).
 *
 * `LaserThreadScope` builds its store, its history loader and its
 * `RemoteThreadListAdapter` from the transcript window it owns. assistant-ui
 * treats a new adapter object as a new adapter: it bumps its generations and
 * throws `ThreadListAdapterChangedError` out of whatever was in flight. So the
 * window owner has to keep its identity across renders, or every render of a
 * scoped surface silently cancels the thread-list work under it — including
 * the `initialize` that creates the session a first message is being sent to.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAui, type Aui } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));
vi.mock("../../src/runtime/threadList.js", async (original) => {
  const actual = await original<typeof import("../../src/runtime/threadList.js")>();
  return { ...actual, createThreadListAdapter: vi.fn(actual.createThreadListAdapter) };
});

import { sessionKindFor } from "../../src/agents/model.js";
import { LaserProvider, LaserThreadScope } from "../../src/runtime/LaserProvider.js";
import { createThreadListAdapter, type CreationTarget } from "../../src/runtime/threadList.js";
import type { AppState } from "../../src/store.js";
import { addSession, CHAT_CWD, createWorld, FakeHostClient, settle, type World } from "../world/fake-host.js";

const SCOPED = `${CHAT_CWD}/one.jsonl`;
const adapters = vi.mocked(createThreadListAdapter);

/** A scope over the Chat workspace: the plain conversations, and nothing else. */
const filter = (session: { cwd: string; agent?: AppState["sessions"][number]["agent"] }, state: AppState) =>
  sessionKindFor(session, state.agents.snapshot) === "chat";
const createIn = (state: AppState): CreationTarget | undefined => {
  const cwd = state.agents.snapshot?.workspaces.chat;
  return cwd ? { cwd, sessionKind: "chat" } : undefined;
};

let handle: Aui | undefined;
let rerender: (() => void) | undefined;

function Probe() {
  handle = useAui();
  return null;
}

function Harness({ path }: { path?: string | undefined }) {
  const [tick, setTick] = useState(0);
  rerender = () => setTick((n) => n + 1);
  return (
    <LaserProvider url="ws://test">
      <LaserThreadScope path={path} onPathChange={() => {}} filter={filter} createIn={createIn} unavailable="Chat is still connecting.">
        <Probe />
        <span data-slot="tick">{tick}</span>
      </LaserThreadScope>
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  handle = undefined;
  rerender = undefined;
  adapters.mockClear();
  world = createWorld();
  addSession(world, SCOPED, CHAT_CWD);
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps one thread-list adapter across renders of the scope", async () => {
  await act(async () => root.render(<Harness path={SCOPED} />));
  await act(async () => settle(20));
  // Mounting settles on one adapter: the workspace and the session arrive
  // asynchronously, and each is a real change of what the list is over.
  const built = adapters.mock.results.map((result) => result.value);
  expect(built.length).toBeGreaterThan(0);

  // What a scoped surface does all day: the scope re-renders because the
  // shell above it did, with the same session and the same workspace.
  for (let index = 0; index < 3; index++) await act(async () => { rerender!(); await settle(0); });
  expect(container.querySelector('[data-slot="tick"]')?.textContent).toBe("3");
  expect(adapters.mock.results.map((result) => result.value)).toEqual(built);
});

it("does not cancel thread-list work in flight when the scope re-renders", async () => {
  await act(async () => root.render(<Harness path={SCOPED} />));
  await act(async () => settle(20));

  // A changed adapter marks the list for replacement until it has been read
  // again, and everything the list is asked for in between fails with
  // `ThreadListAdapterChangedError` — the session's own runtime included.
  act(() => { rerender!(); });
  let settled: unknown;
  try { settled = await handle!.threads.item({ index: 0 }).initialize(); }
  catch (error) { settled = error; }
  expect(settled).toMatchObject({ remoteId: SCOPED });
  await act(async () => settle(0));
});
