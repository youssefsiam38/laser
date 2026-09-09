// @vitest-environment happy-dom
/**
 * M13-T46 — Edit, Fork and Jump while a turn is running, through the real
 * `LaserProvider` and store against the fake worker.
 *
 * The engine will not move a session's leaf while a reply streams. So each of
 * the three asks the worker to stop the reply first and then move, as one
 * request (`stopFirst`); the worker owns that sequence. What a person must be
 * able to see afterwards is asserted here on the transcript and the tree:
 *
 *   - the stopped reply is recorded exactly as a Stop press records it — a
 *     `stopReason: "aborted"` row on the branch being left, never suppressed;
 *   - an edit re-prompts after the stop: it goes out as a prompt, not into
 *     the pending tray, and lands beside the abandoned version;
 *   - a move that fails after the stop leaves the session stopped and where
 *     it was, with the reason on screen;
 *   - a fork leaves the original stopped and recorded, and opens the fork.
 */
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
}));

import { LaserProvider, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import { versionsOf } from "../../src/components/thread/entries.js";
import { addSession, createWorld, FakeWorkerClient, PROJECT_CWD, runTurn, settle, startTurn, type TreeEntry, type World } from "./fake-worker.js";

const SESSION = `${PROJECT_CWD}/work.jsonl`;

let actions: LaserActions;

/** The current session's transcript as a reader sees it, one block per line. */
function Probe() {
  const { actions: a } = useLaserStable();
  actions = a;
  const first = useRef(false);
  if (!first.current) {
    first.current = true;
    void a.openSession(SESSION);
  }
  const current = useLaserState((s) => s.current ?? "");
  const blocks = useLaserState((s) =>
    (s.current ? s.open[s.current]?.blocks ?? [] : [])
      .map((b) => (b.kind === "assistant" ? `assistant:${b.text}${b.stopReason ? `[${b.stopReason}]` : ""}${b.streaming ? "…" : ""}` : b.kind === "user" ? `user:${b.text}` : b.kind))
      .join("|"),
  );
  const running = useLaserState((s) => (s.current ? s.open[s.current]?.running ?? false : false));
  const toast = useLaserState((s) => s.toasts.map((t) => `${t.level}:${t.text}`).join("|"));
  return (
    <span data-slot="probe" data-current={current} data-running={String(running)} data-toast={toast}>
      {blocks}
    </span>
  );
}

/**
 * What `Thread.tsx`'s `EntriesRefresh` does: re-read the tree whenever the
 * current session's turn settles. A move that stops the turn first settles it
 * inside the move — this is the re-read that must not race it.
 */
function SettleReread() {
  const { actions: a } = useLaserStable();
  const path = useLaserState((s) => s.current);
  const running = useLaserState((s) => (s.current ? s.open[s.current]?.running ?? false : false));
  useEffect(() => {
    if (path && !running) void a.refreshEntries();
  }, [a, path, running]);
  return null;
}

let container: HTMLDivElement;
let root: Root;
let world: World;
let prompt: TreeEntry;

const probe = () => container.querySelector('[data-slot="probe"]')!;
const transcript = () => probe().textContent ?? "";
const running = () => probe().getAttribute("data-running") === "true";
const current = () => probe().getAttribute("data-current") ?? "";
const toast = () => probe().getAttribute("data-toast") ?? "";
const calls = (method: string) => world.calls.filter((c) => c.method === method);
const original = () => world.live[SESSION]!;
const abortedOnDisk = (path: string) => world.live[path]!.entries.filter((e) => e.message?.role === "assistant" && (e.message as { stopReason?: string }).stopReason === "aborted");
const run = async <T,>(work: () => Promise<T>): Promise<T> => {
  let result!: T;
  await act(async () => {
    result = await work();
  });
  await act(async () => settle(10));
  return result;
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld({ answer: (p) => `answer to "${p}"` });
  addSession(world, SESSION);
  runTurn(world, SESSION, "explore the repo", "three packages");
  FakeWorkerClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LaserProvider url="ws://test">
        <Probe />
        <SettleReread />
      </LaserProvider>,
    ),
  );
  await act(async () => settle(20));
  // The second prompt is in and its reply is one word in.
  await act(async () => {
    prompt = startTurn(world, SESSION, "list the tests", "on it");
  });
  await act(async () => settle(10));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const OPENING = "user:explore the repo|assistant:three packages";

describe("while a reply streams", () => {
  it("starts from a streaming transcript", () => {
    expect(transcript()).toBe(`${OPENING}|user:list the tests|assistant:on it…`);
    expect(running()).toBe(true);
  });

  it("a move without stopFirst is still refused by the engine, and the turn keeps running", async () => {
    await run(() => actions.jump(prompt.parentId!));
    expect(toast()).toMatch(/Wait for the current response to finish/);
    expect(running()).toBe(true);
    expect(transcript()).toBe(`${OPENING}|user:list the tests|assistant:on it…`);
  });

  it("jump: stops the reply — recorded as a Stop would be — then moves, one request", async () => {
    await run(() => actions.jump(prompt.parentId!, { stopFirst: true }));
    // One request carried both; the UI never sent `session/cancel` itself.
    expect(calls("session/cancel")).toHaveLength(0);
    expect(calls("pi/session/navigate").map((c) => c.params)).toEqual([{ path: SESSION, entryId: prompt.parentId, stopFirst: true }]);
    expect(running()).toBe(false);
    // The session sits before the prompt now; the stop is on the branch left
    // behind, in the file, reachable through the prompt's version picker.
    expect(transcript()).toBe(OPENING);
    expect(original().leafId).toBe(prompt.parentId);
    const stopped = abortedOnDisk(SESSION);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.parentId).toBe(prompt.id);
  });

  it("edit: stops, moves before the prompt, and the new wording goes out as a prompt beside the old one", async () => {
    const moved = await run(() => actions.navigate(prompt.id, { stopFirst: true }));
    expect(moved).toEqual({ editorText: "list the tests" });
    expect(running()).toBe(false);
    // Between the stop and the send the transcript is honest: the abandoned
    // reply is off the path, the stop is in the file.
    expect(transcript()).toBe(OPENING);
    expect(abortedOnDisk(SESSION)).toHaveLength(1);

    await run(() => actions.send([{ type: "text", text: "list the tests and the scripts" }], "prompt"));
    // A prompt, not a tray entry (D-149): the turn had been stopped.
    expect(calls("session/pending/add")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(1);
    expect(transcript()).toBe(`${OPENING}|user:list the tests and the scripts|assistant:answer to "list the tests and the scripts"`);
    // Two versions of the prompt now: the abandoned one, with its stopped
    // reply, and the edit.
    await run(() => actions.refreshEntries());
    const edited = original().entries.find((e) => e.message?.content[0]?.text === "list the tests and the scripts")!;
    expect(versionsOf(original().entries, edited.id)).toEqual([prompt.id, edited.id]);
  });

  it("a move that fails after the stop leaves the session stopped, unmoved, and says why", async () => {
    const moved = await run(() => actions.navigate("gone", { stopFirst: true }));
    expect(moved).toBe(false);
    expect(toast()).toMatch(/gone is not in this session/);
    expect(running()).toBe(false);
    // Stopped: the reply settled as aborted, and that row stays on screen.
    expect(transcript()).toBe(`${OPENING}|user:list the tests|assistant:on it[aborted]`);
    // Unmoved: the leaf is the stopped reply, exactly as after a Stop press.
    const stopped = abortedOnDisk(SESSION);
    expect(stopped).toHaveLength(1);
    expect(original().leafId).toBe(stopped[0]!.id);
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("fork: leaves the original stopped and recorded, and opens the fork", async () => {
    await run(() => actions.fork(prompt.id, { stopFirst: true }));
    expect(calls("session/cancel")).toHaveLength(0);
    expect(calls("pi/session/fork").map((c) => c.params)).toEqual([{ path: SESSION, entryId: prompt.id, stopFirst: true }]);
    // The fork is open: history up to the prompt, nothing of the abandoned reply.
    expect(current()).not.toBe(SESSION);
    expect(transcript()).toBe(OPENING);
    expect(running()).toBe(false);
    expect(abortedOnDisk(current())).toHaveLength(0);
    // The original is stopped and its file says so, under the prompt it answered.
    expect(original().streaming).toBeUndefined();
    const stopped = abortedOnDisk(SESSION);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.parentId).toBe(prompt.id);
    // And the original's own updates carried the stop before the fork's state
    // — the record a person finds when they open it again.
    const kinds = original().buffer.map((u) => (u.update.kind === "message_end" ? `${u.update.kind}:${u.update.stopReason ?? ""}` : u.update.kind));
    expect(kinds.slice(-4)).toEqual(["message_end:aborted", "agent_end", "state", "agent_settled"]);
  });

  it("the tree re-read a settle triggers does not race the move, and never asks a forked-away path", async () => {
    world.calls.length = 0;
    await run(() => actions.fork(prompt.id, { stopFirst: true }));
    // The stop settled the original mid-request; the re-read that follows a
    // settle was held, because the fork hydrates the session it opens itself.
    // (The read after the switch is the fork's own, as on any session change.)
    const asked = calls("pi/session/entries").map((c) => (c.params as { path: string }).path);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(SESSION);
    expect(toast()).toBe("");
    // The same for a move within the file: one read, after the leaf moved.
    world.calls.length = 0;
    await run(() => actions.navigate(world.live[current()]!.entries[0]!.id, { stopFirst: false }));
    expect(calls("pi/session/entries")).toHaveLength(1);
    expect(toast()).toBe("");
  });

  it("fork: a fork that fails after the stop leaves the original stopped, open and unmodified", async () => {
    await run(() => actions.fork("gone", { stopFirst: true }));
    expect(toast()).toMatch(/gone is not in this session/);
    expect(current()).toBe(SESSION);
    expect(running()).toBe(false);
    expect(transcript()).toBe(`${OPENING}|user:list the tests|assistant:on it[aborted]`);
    expect(abortedOnDisk(SESSION)).toHaveLength(1);
    expect(Object.keys(world.live)).toEqual([SESSION]);
  });
});
