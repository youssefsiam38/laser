// @vitest-environment happy-dom
/**
 * Re-opening a session must not double its transcript (M13-T27).
 *
 * A view hydrated from `pi/session/entries` that has never received a live
 * `session/update` used to keep `lastSeq === 0`, because 0 was doing two
 * incompatible jobs: "I hold nothing" and "I hold everything the file had".
 * The next open then asked for `fromSeq: 0`, the worker replayed its entire
 * buffer, and every message was appended a second time under the copy already
 * on screen. A child agent that ran while nothing was attached is always in
 * that state, which is how the agents work surfaced it.
 *
 * These run the real `LaserProvider` against a fake that replays like the
 * worker does (test/runtime/fake-worker.ts), so the assertion is on the
 * transcript the person sees, not on a string.
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import {
  addSession,
  appendEntry,
  createWorld,
  emit,
  emitOffline,
  FakeWorkerClient,
  PROJECT_CWD,
  restartWorker,
  runTurn,
  settle,
  type World,
} from "./fake-worker.js";

const CHILD = `${PROJECT_CWD}/child.jsonl`;

/** The transcript as a reader sees it: one entry per block, in order. */
function Probe() {
  const blocks = useLaserState(
    (s) => (s.open[CHILD]?.blocks ?? []).map((b) => `${b.kind}:${"text" in b ? b.text : b.id}`).join("|"),
  );
  const lastSeq = useLaserState((s) => s.open[CHILD]?.lastSeq ?? -1);
  return <span data-slot="transcript" data-last-seq={String(lastSeq)}>{blocks}</span>;
}

/** Buttons rather than effects: each click is one deliberate open. */
function Controls() {
  const { actions } = useLaserStable();
  const first = useRef(false);
  if (!first.current) {
    first.current = true;
    void actions.openSession(CHILD);
  }
  return (
    <>
      <button data-slot="reopen" onClick={() => void actions.openSession(CHILD)} />
      <button data-slot="reopen-scoped" onClick={() => void actions.openSession(CHILD, { select: false })} />
      <button
        data-slot="reopen-twice"
        onClick={() => {
          void actions.openSession(CHILD);
          void actions.openSession(CHILD, { select: false });
        }}
      />
    </>
  );
}

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <Controls />
      <Probe />
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

const transcript = () => container.querySelector('[data-slot="transcript"]')?.textContent ?? "";
const lastSeq = () => Number(container.querySelector('[data-slot="transcript"]')?.getAttribute("data-last-seq"));
const click = async (slot: string) => {
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!.click());
  await act(async () => settle(10));
};
const loads = () => world.calls.filter((c) => c.method === "session/load");
const hydrations = () => world.calls.filter((c) => c.method === "pi/session/entries");

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  addSession(world, CHILD);
  // The run happened while nothing was attached: the file has both messages
  // and the worker's replay buffer has all five updates that produced them.
  runTurn(world, CHILD, "explore the repo", "found three packages");
  FakeWorkerClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => settle(20));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("re-opening an open session", () => {
  it("shows each message once and asks the worker only for what it is missing", async () => {
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages");
    // Hydrating stamped the worker's watermark rather than leaving it at 0.
    expect(lastSeq()).toBe(5);
    expect(loads()[0]!.params).toEqual({ path: CHILD });

    await click("reopen");

    expect(transcript()).toBe("user:explore the repo|assistant:found three packages");
    expect(loads()).toHaveLength(2);
    expect(loads()[1]!.params).toEqual({ path: CHILD, fromSeq: 5 });
    // Nothing was re-read: the view was already whole.
    expect(hydrations()).toHaveLength(1);
  });

  it("still receives the updates that land after it hydrated", async () => {
    await act(async () => emit(world, CHILD, { kind: "message_start", role: "assistant" }));
    await act(async () => emit(world, CHILD, { kind: "text_delta", delta: "and one script", contentIndex: 0 }));
    await act(async () => settle(10));

    expect(transcript()).toBe("user:explore the repo|assistant:found three packages|assistant:and one script");
    expect(lastSeq()).toBe(7);

    await click("reopen");
    expect(loads()[1]!.params).toEqual({ path: CHILD, fromSeq: 7 });
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages|assistant:and one script");
  });

  it("keeps the transcript single through a scoped open, which takes the same path", async () => {
    await click("reopen-scoped");
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages");
    expect(loads()[1]!.params).toEqual({ path: CHILD, fromSeq: 5 });
    expect(hydrations()).toHaveLength(1);
  });

  it("hydrates once when two surfaces open the same session at the same time", async () => {
    await click("reopen-twice");
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages");
    // The second open joined the first rather than starting its own round trip.
    expect(loads()).toHaveLength(2);
    expect(hydrations()).toHaveLength(1);
  });

  it("resyncs instead of doubling when the worker restarted and counts from 1 again", async () => {
    restartWorker(world, CHILD);
    // The respawned worker re-loads the session and its first event lands in
    // the buffer before we ask, so the empty-buffer branch is not the one that
    // runs — and this update is not in the file yet.
    await act(async () => emit(world, CHILD, { kind: "message_start", role: "assistant" }));
    await act(async () => emit(world, CHILD, { kind: "text_delta", delta: "back", contentIndex: 0 }));
    await act(async () => settle(10));

    await click("reopen");

    // Re-read from the file (the epoch we held no longer exists), and adopted
    // the new epoch's watermark rather than sliding back to 0.
    expect(hydrations()).toHaveLength(2);
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages");
    expect(lastSeq()).toBe(2);

    // …and the session is alive again: the next update is applied, not deduped.
    await act(async () => emit(world, CHILD, { kind: "message_start", role: "assistant" }));
    await act(async () => emit(world, CHILD, { kind: "text_delta", delta: "still here", contentIndex: 0 }));
    await act(async () => settle(10));
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages|assistant:still here");
  });

  it("re-reads the file when the replay buffer no longer reaches back to us", async () => {
    // The session kept working while this view heard nothing (a dropped
    // socket). The buffer keeps only the last two updates, so seq 5 — what we
    // hold — is below its floor and the worker cannot patch the gap.
    world.replayBuffer = 2;
    for (let i = 0; i < 3; i++) emitOffline(world, CHILD, { kind: "turn_start" });
    emitOffline(world, CHILD, { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: "later work" }] } });
    appendEntry(world, CHILD, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "later work" }] } });
    await act(async () => settle(10));

    await click("reopen");

    expect(hydrations()).toHaveLength(2);
    expect(transcript()).toBe("user:explore the repo|assistant:found three packages|assistant:later work");
  });
});
