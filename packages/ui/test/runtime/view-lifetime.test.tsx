// @vitest-environment happy-dom
/**
 * RP-5 end to end, over the real provider and a fake that replays like the
 * worker does: fifty visited conversations converge to a bounded number of
 * hydrated transcripts, every session keeps its light record, and nothing a
 * person is using is ever released — the session they are looking at, a
 * question waiting for them, or words they typed and nobody else has.
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAui } from "@assistant-ui/react";

// Fifty real opens through the provider and a replaying fake: slow on purpose,
// and slower again when the whole suite runs beside it.
vi.setConfig({ testTimeout: 60_000 });

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { VIEW_CACHE_LIMITS } from "../../src/runtime/view-cache.js";
import { isDormantView } from "../../src/view-summary.js";
import type { AppState } from "../../src/store.js";
import { addSession, createWorld, FakeWorkerClient, PROJECT_CWD, runTurn, settle, type World } from "./fake-worker.js";

const pathOf = (index: number): string => `${PROJECT_CWD}/s${index}.jsonl`;
const SESSIONS = 50;

let snapshot: AppState = {} as AppState;
let open: (path: string) => Promise<void> = async () => {};
let composerText: (text: string) => void = () => {};
let readComposer: () => string = () => "";

function Probe() {
  snapshot = useLaserState((state) => state);
  const { actions } = useLaserStable();
  const aui = useAui();
  const bound = useRef(false);
  if (!bound.current) {
    bound.current = true;
  }
  open = (path) => actions.openSession(path);
  composerText = (text) => aui.thread.composer().setText(text);
  readComposer = () => aui.thread.composer().getState().text;
  return null;
}

const hydratedPaths = (): string[] =>
  Object.keys(snapshot.open).filter((path) => !isDormantView(snapshot.open[path])).sort();
const dormantPaths = (): string[] =>
  Object.keys(snapshot.open).filter((path) => isDormantView(snapshot.open[path])).sort();
const entryReads = (path: string): number =>
  world.calls.filter((call) => call.method === "pi/session/entries" && (call.params as { path?: string }).path === path).length;

let container: HTMLDivElement;
let root: Root;
let world: World;

const visit = async (path: string) => {
  await act(async () => { await open(path); });
  await act(async () => settle(5));
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  for (let index = 1; index <= SESSIONS; index++) {
    const path = pathOf(index);
    addSession(world, path);
    runTurn(world, path, `question ${index}`, `answer ${index}`);
  }
  FakeWorkerClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>));
  await act(async () => settle(10));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("fifty visited conversations", () => {
  it("keep their identity and release all but a bounded few transcripts", async () => {
    for (let index = 1; index <= SESSIONS; index++) await visit(pathOf(index));

    // Every session the window has opened is still a record it can name.
    expect(Object.keys(snapshot.open)).toHaveLength(SESSIONS);
    // Only a bounded few keep a transcript: the limit, plus what is pinned.
    expect(hydratedPaths().length).toBeLessThanOrEqual(VIEW_CACHE_LIMITS.views + 1);
    expect(dormantPaths().length).toBeGreaterThanOrEqual(SESSIONS - VIEW_CACHE_LIMITS.views - 1);

    for (const path of dormantPaths()) {
      const view = snapshot.open[path]!;
      expect(view.blocks).toEqual([]);
      expect(view.entries).toEqual([]);
      expect(view.history).toBeUndefined();
      // The row can still say what this conversation is.
      expect(view.summary?.firstUser).toMatch(/^question \d+$/);
      expect(view.state.path).toBe(path);
    }
    // The one on screen is never released.
    expect(isDormantView(snapshot.open[pathOf(SESSIONS)])).toBe(false);
  });

  it("read a released conversation again when a person opens it, and keep the reader's place honest", async () => {
    for (let index = 1; index <= 20; index++) await visit(pathOf(index));
    const released = pathOf(1);
    expect(isDormantView(snapshot.open[released])).toBe(true);
    const readsBefore = entryReads(released);

    await visit(released);

    expect(isDormantView(snapshot.open[released])).toBe(false);
    expect(snapshot.open[released]!.blocks.map((block) => ("text" in block ? block.text : block.id)))
      .toEqual(["question 1", "answer 1"]);
    expect(entryReads(released)).toBe(readsBefore + 1);
  });

  it("stop being resumed by a reconnect once their transcript is released", async () => {
    for (let index = 1; index <= 20; index++) await visit(pathOf(index));
    const client = FakeWorkerClient.instances.at(-1)!;
    const attached = [...client.attached.keys()].sort();

    for (const path of dormantPaths()) expect(attached).not.toContain(path);
    for (const path of hydratedPaths()) expect(attached).toContain(path);
  });
});

describe("what a person is holding", () => {
  it("keeps a session whose composer holds unsent words, and lets it go when they are gone", async () => {
    const drafted = pathOf(1);
    await visit(drafted);
    await act(async () => composerText("a thought I have not sent"));
    await act(async () => settle(5));

    for (let index = 2; index <= 12; index++) await visit(pathOf(index));

    // Held: its transcript is still here after eleven other conversations.
    expect(isDormantView(snapshot.open[drafted])).toBe(false);

    // The words come back with the conversation.
    await visit(drafted);
    expect(readComposer()).toBe("a thought I have not sent");
    expect(isDormantView(snapshot.open[drafted])).toBe(false);

    // Once they are sent or cleared, it is an ordinary candidate again.
    await act(async () => composerText(""));
    await act(async () => settle(5));
    for (let index = 13; index <= 24; index++) await visit(pathOf(index));
    expect(isDormantView(snapshot.open[drafted])).toBe(true);
  });

  it("keeps a session with a question, and one that arrives after its transcript went", async () => {
    const waiting = pathOf(1);
    await visit(waiting);
    const client = FakeWorkerClient.instances.at(-1)!;
    await act(async () => client.deliver("pi/ui/request", { path: waiting, id: "q1", method: "confirm", title: "Run it?" } as never));
    await act(async () => settle(5));

    for (let index = 2; index <= 12; index++) await visit(pathOf(index));
    expect(isDormantView(snapshot.open[waiting])).toBe(false);
    expect(snapshot.open[waiting]!.dialogs.map((dialog) => dialog.id)).toEqual(["q1"]);

    // A question for a conversation whose transcript is already gone.
    const late = pathOf(2);
    for (let index = 13; index <= 30; index++) await visit(pathOf(index));
    expect(isDormantView(snapshot.open[late])).toBe(true);
    await act(async () => client.deliver("pi/ui/request", { path: late, id: "q2", method: "confirm", title: "Delete it?" } as never));
    await act(async () => settle(5));

    // Visible and actionable from its light record: the question is kept, the
    // transcript under it is not rebuilt out of live updates, and further
    // switching never drops it.
    expect(snapshot.open[late]!.dialogs.map((dialog) => dialog.id)).toEqual(["q2"]);
    expect(snapshot.open[late]!.blocks).toEqual([]);
    for (let index = 31; index <= 42; index++) await visit(pathOf(index));
    expect(snapshot.open[late]!.dialogs.map((dialog) => dialog.id)).toEqual(["q2"]);

    // Opening it reads the conversation again, so the question is answered
    // beside its transcript and never over an empty one.
    await visit(late);
    expect(isDormantView(snapshot.open[late])).toBe(false);
    expect(snapshot.open[late]!.blocks.length).toBeGreaterThan(0);
    expect(snapshot.open[late]!.dialogs.map((dialog) => dialog.id)).toEqual(["q2"]);

    // And from now on it is held, because a question is waiting in it.
    for (let index = 43; index <= 50; index++) await visit(pathOf(index));
    expect(isDormantView(snapshot.open[late])).toBe(false);
  });
});
