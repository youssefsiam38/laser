// @vitest-environment happy-dom
/**
 * `actions.moveSession` over the real `LaserProvider` and a fake host that
 * moves the file the way the real one does (M13-T58). What is asserted is the
 * state a person's screen is built from: the old path is gone from the open
 * views and no longer followed, the catalog rows list the session under its
 * project, and opening the moved path makes it the current session with the
 * same transcript. A refused move leaves everything as it was.
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeWorkerClient, runTurn, settle, startTurn, type World } from "./fake-worker.js";

const CHAT_CWD = "/state/chat";
const CHAT = `${CHAT_CWD}/c1.jsonl`;
const PROJECT = "/home/me/app";
const MOVED = `${PROJECT}/sessions/c1.jsonl`;

let outcome: { moved?: string; error?: string } = {};

function Probe() {
  const current = useLaserState((s) => s.current ?? "");
  const open = useLaserState((s) => Object.keys(s.open).sort().join("|"));
  const rows = useLaserState((s) => s.sessions.map((row) => `${row.path}@${row.cwd}:${row.agent?.kind ?? "-"}`).join("|"));
  const blocks = useLaserState((s) => (s.current ? (s.open[s.current]?.blocks ?? []).map((b) => `${b.kind}:${"text" in b ? b.text : b.id}`).join("|") : ""));
  return <span data-slot="probe" data-current={current} data-open={open} data-rows={rows} data-blocks={blocks} />;
}

function Controls() {
  const { actions } = useLaserStable();
  const first = useRef(false);
  if (!first.current) {
    first.current = true;
    void actions.openSession(CHAT);
  }
  return (
    <>
      <button
        data-slot="move"
        onClick={() => {
          outcome = {};
          void actions
            .moveSession(CHAT, PROJECT)
            .then((moved) => {
              outcome = { moved };
              void actions.openSession(moved);
            })
            .catch((error: unknown) => {
              outcome = { error: error instanceof Error ? error.message : String(error) };
            });
        }}
      />
    </>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

const probe = (name: string) => container.querySelector('[data-slot="probe"]')?.getAttribute(`data-${name}`) ?? "";
const click = async (slot: string) => {
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!.click());
  await act(async () => settle(20));
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  outcome = {};
  world = createWorld();
  addSession(world, CHAT, CHAT_CWD);
  world.sessions[0]!.agent = { agentName: "chat", kind: "chat" };
  runTurn(world, CHAT, "ideas for dinner", "pasta");
  FakeWorkerClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LaserProvider url="ws://test">
        <Controls />
        <Probe />
      </LaserProvider>,
    ),
  );
  await act(async () => settle(20));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("moving a Chat session into a project", () => {
  it("asks the host once, drops the old path, re-lists the session under its project and opens it there with the same transcript", async () => {
    expect(probe("current")).toBe(CHAT);
    expect(probe("blocks")).toBe("user:ideas for dinner|assistant:pasta");
    expect(probe("rows")).toBe(`${CHAT}@${CHAT_CWD}:chat`);

    await click("move");

    expect(outcome).toEqual({ moved: MOVED });
    const moves = world.calls.filter((c) => c.method === "pi/session/move");
    expect(moves).toEqual([{ method: "pi/session/move", params: { path: CHAT, cwd: PROJECT } }]);
    // The old path is neither open nor followed; the moved one is current.
    expect(probe("open")).toBe(MOVED);
    expect(probe("current")).toBe(MOVED);
    expect(probe("rows")).toBe(`${MOVED}@${PROJECT}:root`);
    expect(probe("blocks")).toBe("user:ideas for dinner|assistant:pasta");
    // Nothing asked the worker for the old path after the move.
    const after = world.calls.slice(world.calls.findIndex((c) => c.method === "pi/session/move") + 1);
    expect(after.filter((c) => (c.params as { path?: string } | null)?.path === CHAT)).toEqual([]);
    expect(after.some((c) => c.method === "session/load" && (c.params as { path: string }).path === MOVED)).toBe(true);
  });

  it("leaves everything in place when the host refuses, and says why", async () => {
    startTurn(world, CHAT, "and dessert?", "tirami");
    await act(async () => settle(5));
    await click("move");
    expect(outcome).toEqual({ error: "This chat is still answering. Wait for it to finish, or stop it, then move it." });
    expect(probe("current")).toBe(CHAT);
    expect(probe("open")).toBe(CHAT);
    expect(probe("rows")).toBe(`${CHAT}@${CHAT_CWD}:chat`);
  });
});
