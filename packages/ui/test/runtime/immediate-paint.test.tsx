// @vitest-environment happy-dom
/**
 * RP-11: a conversation this device has seen before is on screen in the same
 * frame as the click, truthfully labelled, and nothing it shows may act until
 * the host has confirmed it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyWindow, PRODUCT_VERSION } from "@lasercode/protocol";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));
vi.mock("../../src/components/thread/messages.js", () => ({
  ThreadMessage: () => <MessagePrimitive.Root><MessagePrimitive.Parts /></MessagePrimitive.Root>,
}));
vi.mock("../../src/components/thread/use-conversation-find.js", () => ({
  useConversationFind: () => ({ open: false, root: undefined, bar: null }),
}));
vi.mock("../../src/components/thread/Composer.js", () => ({
  Composer: () => <ComposerPrimitive.Root><ComposerPrimitive.Input /><ComposerPrimitive.Send>Send</ComposerPrimitive.Send></ComposerPrimitive.Root>,
}));

import { Thread } from "../../src/components/thread/Thread.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { LaserProvider, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { installProvisionalSource, type ProvisionalSource } from "../../src/runtime/provisional-source.js";
import { TAIL_RECORD_SCHEMA } from "../../src/runtime/tail-cache/bounds.js";
import type { TailRecord } from "../../src/runtime/tail-cache/record.js";
import type { AppState } from "../../src/store.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";
import { seedProject, seedRememberedSessions, TEST_ENVIRONMENT_KEY } from "./environment-fixture.js";

const SEEN = `${PROJECT_CWD}/seen.jsonl`;
const SEEN_ID = "session-seen";
const START = `${PROJECT_CWD}/start.jsonl`;
const CACHED_TEXT = "What this device last saw";
const AUTHORITATIVE_TEXT = "What the host says now";

const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string): unknown => ({
  type: "message", id, parentId, message: { role, content: [{ type: "text", text }] },
});

const cached = (over: Partial<TailRecord> = {}): TailRecord => {
  const rows = [entry("c1", null, "user", CACHED_TEXT), entry("c2", "c1", "assistant", "I looked at it.")];
  return {
    schema: TAIL_RECORD_SCHEMA,
    appVersion: PRODUCT_VERSION,
    environmentKey: TEST_ENVIRONMENT_KEY,
    sessionId: SEEN_ID,
    revision: "r1.env.cached",
    leafId: "c2",
    epoch: "worker-old",
    seq: 7,
    entries: rows.map((value) => ({ id: (value as { id: string }).id, parentId: (value as { parentId: string | null }).parentId, json: JSON.stringify(value) })),
    truncated: false,
    attachments: [],
    attachmentsOmitted: 0,
    bytes: 256,
    capturedAt: new Date(Date.now() - 60_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
};

const authoritative = (path: string) => {
  if (path !== SEEN) {
    const other = [entry("s1", null, "user", "Another conversation entirely")];
    return historyWindow({ entries: other, leafId: "s1" }, { tail: 40 }, {
      sessionId: "session-start", epoch: "worker-new", seq: 1, revision: "r1.env.start", environmentKey: TEST_ENVIRONMENT_KEY,
    });
  }
  const rows = [entry("h1", null, "user", "The question the host still has"), entry("h2", "h1", "assistant", AUTHORITATIVE_TEXT)];
  return historyWindow({ entries: rows, leafId: "h2" }, { tail: 40 }, {
    sessionId: SEEN_ID, epoch: "worker-new", seq: 3, revision: "r1.env.current", environmentKey: TEST_ENVIRONMENT_KEY,
  });
};

let actions: LaserActions;
let state: AppState;
let aui: ReturnType<typeof useAui>;
let sendDisabled: boolean;
function Probe() {
  state = useLaserState((s) => s);
  actions = useLaserStable().actions;
  aui = useAui();
  sendDisabled = useAuiState((s) => (s.thread.extras as { sendDisabled?: boolean } | undefined)?.sendDisabled === true);
  return null;
}

let root: Root;
let container: HTMLDivElement;
let world: World;
let source: ProvisionalSource & { peek: ReturnType<typeof vi.fn>; prime: ReturnType<typeof vi.fn>; supersede: ReturnType<typeof vi.fn> };
let restore: ProvisionalSource;
let record: TailRecord | undefined;

const mutations = () => world.calls.filter((call) => [
  "session/prompt", "session/cancel", "pi/ui/response", "pi/session/fork", "pi/session/navigate",
  "pi/session/rename", "pi/session/delete", "session/pending/steer", "session/pending/edit",
  "session/pending/remove", "pi/model/set", "pi/thinking/set", "agents/stop", "tasks/stop", "pi/session/compact",
].includes(call.method));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  record = cached();
  source = {
    peek: vi.fn((target: { sessionId: string }) => (record && record.sessionId === target.sessionId ? record : undefined)),
    prime: vi.fn(async () => {}),
    supersede: vi.fn(),
  } as never;
  restore = installProvisionalSource(source);
  world = createWorld();
  addSession(world, START, PROJECT_CWD, { name: "Start here" });
  addSession(world, SEEN, PROJECT_CWD, { id: SEEN_ID, name: "Seen before", messageCount: 2 });
  // The session's own state carries the same opaque id its catalog row does:
  // the cache is addressed by that id and by nothing else (RP-10).
  world.states[SEEN] = { ...world.states[SEEN]!, id: SEEN_ID };
  world.overrides["pi/session/entries"] = (({ path }: { path: string }) => authoritative(path)) as never;
  FakeHostClient.reset(world);
  seedProject(PROJECT_CWD);
  seedRememberedSessions({ [PROJECT_CWD]: START });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(
    <LaserProvider url="ws://test"><WorkbenchProvider><Probe /><Thread /></WorkbenchProvider></LaserProvider>,
  ));
  await act(async () => settle(30));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  installProvisionalSource(restore);
});

/** Open the seen conversation with `session/load` held, and hand back its release. */
function openHeld(): { release: () => void; opened: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  world.overrides["session/load"] = (async ({ path }: { path: string }) => {
    if (path === SEEN) await held;
    return { state: world.states[path], replayFrom: 0, seq: 0 };
  }) as never;
  let opened!: Promise<void>;
  act(() => { opened = actions.openSession(SEEN).catch(() => {}); });
  return { release, opened };
}

describe("immediate paint from this device", () => {
  it("commits the cached tail in the click's own turn, and renders it before the host answers anything", async () => {
    const before = world.calls.length;
    const { release } = openHeld();
    // The store transaction happens in the same synchronous turn as the click:
    // no await, no timer, and no answer from the host.
    expect(state.open[SEEN]?.provisional).toMatchObject({ revision: "r1.env.cached", sessionId: SEEN_ID });
    expect(state.open[SEEN]?.validated).toBeUndefined();
    expect(state.open[SEEN]?.hydrated).toBe(false);
    expect(state.open[SEEN]?.blocks).toHaveLength(2);
    expect(world.calls.slice(before).filter((call) => call.method === "pi/session/entries")).toEqual([]);
    // React commits it without anything else happening: no reply, no timers.
    await act(async () => {});
    expect(container.textContent).toContain(CACHED_TEXT);
    expect(world.calls.slice(before).filter((call) => call.method === "pi/session/entries")).toEqual([]);
    // Nothing on screen is a loading state, and nothing reads as a new session.
    expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
    expect(container.textContent).not.toContain("New session");
    release();
  });

  it("shows no empty frame and no skeleton from the click to the host's answer", async () => {
    const frames: string[] = [];
    const observe = () => frames.push(container.textContent ?? "");
    const { release, opened } = openHeld();
    await act(async () => {});
    observe();
    await act(async () => { await settle(5); });
    observe();
    await act(async () => { release(); await opened; await settle(30); });
    observe();
    for (const frame of frames) {
      expect(frame).not.toContain("New session");
      expect(frame.length).toBeGreaterThan(0);
    }
    expect(frames[0]).toContain(CACHED_TEXT);
    expect(frames.at(-1)).toContain(AUTHORITATIVE_TEXT);
  });

  it("refuses every mutation while the paint is provisional, and sends nothing", async () => {
    const { release, opened } = openHeld();
    expect(sendDisabled).toBe(true);
    // Let the runtime settle onto the chosen conversation, then write into the
    // composer that belongs to it.
    await act(async () => { await settle(5); });
    await act(async () => { aui.composer.setText("A draft written while the host is asked"); });
    await act(async () => { aui.composer.send(); await settle(5); });
    // The draft is the person's: fenced, never taken away, never dropped.
    expect(aui.composer.getState().text).toBe("A draft written while the host is asked");
    await act(async () => {
      await actions.send([{ type: "text", text: "direct" }], "prompt").catch(() => {});
      await actions.abort();
      await actions.answerDialog({ id: "nope", kind: "confirm", value: true } as never);
      await actions.fork("c1").catch(() => {});
      await actions.navigate("c1").catch(() => {});
      await actions.compact().catch(() => {});
      await actions.rename("Renamed while fenced").catch(() => {});
      await settle(10);
    });
    expect(mutations()).toEqual([]);
    await act(async () => { release(); await opened; await settle(30); });
    // Authority arrived: the same composer may send now, and the draft is here.
    expect(sendDisabled).toBe(false);
    expect(aui.composer.getState().text).toBe("A draft written while the host is asked");
    await act(async () => { aui.composer.send(); await settle(10); });
    expect(world.calls.filter((call) => call.method === "session/prompt")).toHaveLength(1);
  });

  it("replaces the cached tail atomically and retires the record the host disagreed with", async () => {
    const { release, opened } = openHeld();
    await act(async () => {});
    expect(container.textContent).toContain(CACHED_TEXT);
    await act(async () => { release(); await opened; await settle(30); });
    const view = state.open[SEEN]!;
    expect(view.provisional).toBeUndefined();
    expect(view.validated).toMatchObject({ revision: "r1.env.current", environmentKey: TEST_ENVIRONMENT_KEY, sessionId: SEEN_ID });
    expect(view.entries.map((value) => (value as { id: string }).id)).toEqual(["h1", "h2"]);
    expect(container.textContent).toContain(AUTHORITATIVE_TEXT);
    expect(source.supersede).toHaveBeenCalledWith(SEEN_ID, "r1.env.current");
  });

  it("keeps the readable snapshot, says so and offers Retry when the host cannot be reached", async () => {
    world.overrides["session/load"] = (({ path }: { path: string }) => {
      if (path === SEEN) throw new Error("The host is not answering. Try again.");
      return { state: world.states[path], replayFrom: 0, seq: 0 };
    }) as never;
    await act(async () => { await actions.openSession(SEEN).catch(() => {}); await settle(30); });
    expect(container.textContent).toContain(CACHED_TEXT);
    expect(container.textContent).toContain("Couldn’t reach the host. This is your last view of this conversation.");
    expect(container.querySelector('[data-slot="conversation-skeleton"]')).toBeNull();
    expect(sendDisabled).toBe(true);
    expect(mutations()).toEqual([]);
    const retry = [...container.querySelectorAll("button")].find((button) => /retry|try again/i.test(button.textContent ?? ""));
    expect(retry).toBeDefined();
    delete world.overrides["session/load"];
    await act(async () => { retry!.click(); await settle(40); });
    expect(container.textContent).toContain(AUTHORITATIVE_TEXT);
    expect(sendDisabled).toBe(false);
  });

  it("paints nothing from another environment, another build or an expired capture, and stays truthful", async () => {
    for (const refused of [
      cached({ environmentKey: "e1.another-environment" }),
      cached({ appVersion: "0.0.1-other" }),
      cached({ schema: "tail-cache/1" as TailRecord["schema"] }),
      cached({ capturedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString() }),
      cached({ entries: [{ id: "c1", parentId: null, json: "{not json" }] }),
    ]) {
      record = refused;
      const { release, opened } = openHeld();
      expect(state.open[SEEN]?.provisional).toBeUndefined();
      expect(container.textContent).not.toContain(CACHED_TEXT);
      await act(async () => { release(); await opened; await settle(30); });
      await act(async () => { await actions.openSession(START); await settle(20); });
    }
  });

  it("paints nothing for a conversation this device has never seen, and promotes it for next time", () => {
    record = undefined;
    const { release } = openHeld();
    expect(state.open[SEEN]?.provisional).toBeUndefined();
    expect(source.prime).toHaveBeenCalledWith([SEEN_ID]);
    release();
  });

  it("never paints over a conversation that is already on screen", async () => {
    await act(async () => { await actions.openSession(SEEN); await settle(30); });
    expect(state.open[SEEN]?.validated?.revision).toBe("r1.env.current");
    source.peek.mockClear();
    await act(async () => { await actions.openSession(START); await settle(20); });
    const { release, opened } = openHeld();
    // The view still holds its own authoritative transcript: there is nothing
    // to paint, and the cached record must not replace it.
    expect(state.open[SEEN]?.provisional).toBeUndefined();
    expect(state.open[SEEN]?.entries.map((value) => (value as { id: string }).id)).toEqual(["h1", "h2"]);
    await act(async () => { release(); await opened; await settle(30); });
    expect(state.open[SEEN]?.validated?.revision).toBe("r1.env.current");
  });
});
