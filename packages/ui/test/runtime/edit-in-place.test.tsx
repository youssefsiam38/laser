// @vitest-environment happy-dom
/**
 * M13-T35 — editing a message, and running a reply again, change THIS session.
 *
 * Pi's session file is an append-only tree with a leaf pointer, so this needs
 * no fork and never deletes anything: `navigateTree` moves the leaf to before
 * the prompt (`SessionManager.resetLeaf()` when it is the opening one) and
 * hands its text back, and what is sent next lands there as another version of
 * it. The abandoned wording, and everything that followed it, stays in the
 * file for the version picker.
 *
 * Two things could make this worse than the fork it replaces, and both are
 * asserted here: a transcript that shows both versions at once (the file holds
 * every branch, so hydration must render only the live one), and an action
 * that quietly does nothing when the engine refuses.
 *
 * These run the real `LaserProvider` against a fake that keeps the tree and
 * moves the leaf exactly as `AgentSession.navigateTree` does, so the assertion
 * is on the transcript a person sees.
 */
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-worker.js")).FakeWorkerClient,
}));

import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { userEntryAt, versionsOf, leafOf } from "../../src/components/thread/entries.js";
import { addSession, createWorld, FakeWorkerClient, PROJECT_CWD, runTurn, settle, type World } from "./fake-worker.js";

const SESSION = `${PROJECT_CWD}/work.jsonl`;

/** The transcript as a reader sees it: one entry per block, in order. */
function Probe() {
  const blocks = useLaserState((s) =>
    (s.open[SESSION]?.blocks ?? []).map((b) => `${b.kind}:${"text" in b ? b.text : b.id}`).join("|"),
  );
  const toast = useLaserState((s) => s.toasts.map((t) => `${t.level}:${t.text}`).join("|"));
  return (
    <span data-slot="transcript" data-toast={toast}>
      {blocks}
    </span>
  );
}

/**
 * The moves the transcript's own controls make, in the order they make them:
 * `navigate` first (and only if it moved), then the prompt.
 */
function Controls() {
  const { actions } = useLaserStable();
  const entries = useLaserState((s) => s.open[SESSION]?.entries ?? []);
  const leafId = useLaserState((s) => s.open[SESSION]?.leafId);
  const [refused, setRefused] = useState(false);
  const first = useRef(false);
  if (!first.current) {
    first.current = true;
    void actions.openSession(SESSION);
  }
  const edit = async (ordinal: number, text: string) => {
    const entryId = userEntryAt(entries, ordinal, leafId);
    if (!entryId) return;
    if (!(await actions.navigate(entryId))) {
      setRefused(true);
      return;
    }
    await actions.send([{ type: "text", text }], "prompt");
    // What `Thread` does when a turn ends: the tree has a new branch in it now.
    await actions.refreshEntries();
  };
  const rerun = async (ordinal: number) => {
    const entryId = userEntryAt(entries, ordinal, leafId);
    if (!entryId) return;
    const moved = await actions.navigate(entryId);
    if (!moved) return;
    await actions.send([{ type: "text", text: moved.editorText ?? "" }], "prompt");
    await actions.refreshEntries();
  };
  /** The second choice: the same edit, into a new session file. */
  const forkEdit = async (ordinal: number, text: string) => {
    const entryId = userEntryAt(entries, ordinal, leafId);
    if (!entryId) return;
    await actions.fork(entryId);
    await actions.send([{ type: "text", text }], "prompt");
    await actions.refreshEntries();
  };
  const versions = (ordinal: number): string[] => {
    const entryId = userEntryAt(entries, ordinal, leafId);
    return entryId ? versionsOf(entries, entryId) : [];
  };
  return (
    <>
      <span data-slot="versions" data-refused={String(refused)}>
        {versions(0).length}
      </span>
      <button data-slot="edit-first" onClick={() => void edit(0, "count the packages instead")} />
      <button data-slot="edit-second" onClick={() => void edit(1, "and the scripts too")} />
      <button data-slot="rerun-second" onClick={() => void rerun(1)} />
      <button data-slot="fork-second" onClick={() => void forkEdit(1, "and the scripts too")} />
      <button
        data-slot="switch-version"
        onClick={() => {
          const [oldest] = versions(0);
          if (oldest) void actions.jump(leafOf(entries, oldest));
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
const toast = () => container.querySelector('[data-slot="transcript"]')?.getAttribute("data-toast") ?? "";
const versions = () => container.querySelector('[data-slot="versions"]')?.textContent ?? "";
const refused = () => container.querySelector('[data-slot="versions"]')?.getAttribute("data-refused") === "true";
const click = async (slot: string) => {
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!.click());
  await act(async () => settle(10));
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld({ answer: (prompt) => `answer to "${prompt}"` });
  addSession(world, SESSION);
  runTurn(world, SESSION, "explore the repo", 'answer to "explore the repo"');
  runTurn(world, SESSION, "list the tests", 'answer to "list the tests"');
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

const OPENING = 'user:explore the repo|assistant:answer to "explore the repo"';
const SECOND = 'user:list the tests|assistant:answer to "list the tests"';

describe("editing a message you sent", () => {
  it("starts from a whole transcript with nothing to pick between", async () => {
    expect(transcript()).toBe(`${OPENING}|${SECOND}`);
    expect(versions()).toBe("1");
  });

  it("replaces a middle message in this session and keeps the old one reachable", async () => {
    await click("edit-second");

    // The edit took the second message's place: the session is still one
    // conversation, and the wording that was there is not in it.
    expect(transcript()).toBe(`${OPENING}|user:and the scripts too|assistant:answer to "and the scripts too"`);
    expect(transcript()).not.toContain("list the tests");
    // Still one session file, not a fork.
    expect(world.calls.some((c) => c.method === "pi/session/fork")).toBe(false);
    expect(Object.keys(world.live)).toEqual([SESSION]);
  });

  it("replaces the opening message, which has no parent to branch from", async () => {
    await click("edit-first");

    // `resetLeaf()`: the leaf goes to before the first entry and the new
    // opening message is a second root. Everything that followed the old one
    // is off the branch, not deleted.
    expect(transcript()).toBe('user:count the packages instead|assistant:answer to "count the packages instead"');
    expect(versions()).toBe("2");
    const live = world.live[SESSION]!;
    expect(live.entries).toHaveLength(6);
    expect(live.entries.filter((e) => e.parentId === null)).toHaveLength(2);
  });

  it("goes back to the version it replaced, and forward again", async () => {
    await click("edit-first");
    expect(transcript()).toContain("count the packages instead");

    await click("switch-version");

    // The whole original branch is back, both turns of it.
    expect(transcript()).toBe(`${OPENING}|${SECOND}`);
    expect(versions()).toBe("2");
  });

  it("still forks when that is the choice, and never shows the fork empty on the way in", async () => {
    await click("fork-second");

    const forked = Object.keys(world.live).find((path) => path !== SESSION)!;
    expect(forked).toBeDefined();
    // The original file is exactly as it was; the edit is in the new one.
    expect(world.live[SESSION]!.entries.map((e) => e.message?.content[0]?.text)).toEqual([
      "explore the repo",
      'answer to "explore the repo"',
      "list the tests",
      'answer to "list the tests"',
    ]);
    // The fork is what the person is now looking at, and the edit is in it.
    expect(world.live[forked]!.entries.map((e) => e.message?.content[0]?.text)).toEqual([
      "explore the repo",
      'answer to "explore the repo"',
      "and the scripts too",
      'answer to "and the scripts too"',
    ]);

    // The fork is on screen with a transcript from the moment it becomes the
    // open session: `fork` reads its entries before dispatching the switch, so
    // there is no frame where the open session is empty (see the note in
    // `LaserProvider.fork` — that empty frame threw out of assistant-ui).
    const entriesRead = world.calls.findIndex((c) => c.method === "pi/session/entries" && (c.params as { path: string }).path === forked);
    const promptSent = world.calls.findIndex((c) => c.method === "session/prompt" && (c.params as { path: string }).path === forked);
    expect(entriesRead).toBeGreaterThan(-1);
    expect(entriesRead).toBeLessThan(promptSent);
  });

  it("says so and changes nothing when a feature refuses the move", async () => {
    world.live[SESSION]!.navigateCancelled = true;

    await click("edit-second");

    expect(refused()).toBe(true);
    expect(transcript()).toBe(`${OPENING}|${SECOND}`);
    expect(toast()).toBe("warning:A feature stopped that change.");
    // Refused means refused: nothing was sent behind the person's back.
    expect(world.calls.filter((c) => c.method === "session/prompt")).toHaveLength(0);
  });
});

describe("running a reply again", () => {
  it("answers again in this session, from the engine's own text for that prompt", async () => {
    world.answer = (prompt) => `second thoughts on "${prompt}"`;

    await click("rerun-second");

    expect(transcript()).toBe(`${OPENING}|user:list the tests|assistant:second thoughts on "list the tests"`);
    // The prompt that was re-sent is the entry's text, not one re-derived here.
    const sent = world.calls.filter((c) => c.method === "session/prompt").at(-1)!.params as { content: Array<{ text: string }> };
    expect(sent.content[0]!.text).toBe("list the tests");
  });

  it("keeps the first answer as the other version of that question", async () => {
    world.answer = (prompt) => `second thoughts on "${prompt}"`;
    await click("rerun-second");

    const live = world.live[SESSION]!;
    const prompts = live.entries.filter((e) => e.message?.role === "user");
    expect(prompts).toHaveLength(3);
    // Two versions of "list the tests", sharing the reply above them.
    const asked = prompts.filter((e) => e.message?.content[0]?.text === "list the tests");
    expect(asked).toHaveLength(2);
    expect(asked[0]!.parentId).toBe(asked[1]!.parentId);
  });
});

describe("hydration after the tree has branched", () => {
  it("shows one version of the conversation on a reload, never both", async () => {
    await click("edit-second");
    const once = transcript();

    // A reload is a first open of a file that now holds two branches: the
    // whole tree comes back, and only the branch in play is the transcript.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => settle(20));

    expect(transcript()).toBe(once);
    expect(transcript()).not.toContain("list the tests");
  });
});
