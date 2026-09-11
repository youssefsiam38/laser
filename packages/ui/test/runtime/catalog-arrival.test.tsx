// @vitest-environment happy-dom
/**
 * A session that arrives from outside while the app sits on the project
 * screen (M13-T53).
 *
 * The project screen is assistant-ui's unstarted "new" thread. A session the
 * CLI creates (`new <project>`) reaches the UI as a catalog row, not as
 * anything this page did, and the runtime lists it under its own id. The
 * first send from the project screen then reuses that unstarted session — the
 * launcher's rule — and assistant-ui adopts its path into the "new" thread,
 * dropping the listed row as an orphan. If the selection had already moved
 * onto that row (the launcher used to select it mid-initialize, and a deep
 * link can), the main thread pointed at an entry that no longer existed and
 * every render threw `useClientLookup: key "<path>" not found`: a black
 * screen until a reload.
 *
 * These run the real `LaserProvider`, the real runtime and the real project
 * screen against the fake host, with React's own scheduler rather than `act`,
 * because the failure is an ordering between the host's replies and React's
 * commits, and `act` would batch it away.
 */
import { Component, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { useAui, useAuiState } from "@assistant-ui/react";
import type { SessionSummary } from "@lasercode/protocol";
import { EmptyState } from "../../src/components/thread/EmptyState.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable, useLaserState } from "../../src/runtime/LaserProvider.js";
import { sessionState, summary } from "../agents/fixtures.js";
import { createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

/** What the sessions panel and the transcript header read; the main item is a lookup that throws when the runtime lost it. */
function Probe() {
  const aui = useAui();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const mainRemoteId = useAuiState((s) => s.threadListItem.remoteId);
  // The rows as the sessions panel names them: by session, whatever the
  // runtime's own id for a thread born on this page.
  const rows = threadIds.map((id) => threadItems.find((item) => item.id === id)?.remoteId ?? id);
  const current = useLaserState((s) => s.current);
  // The imperative face too: the shell resolves rows this way.
  const viaItem = aui.threads.item("main").getState().remoteId;
  return (
    <span
      data-slot="probe"
      data-main={mainThreadId}
      data-threads={rows.join("|")}
      data-remote={mainRemoteId ?? ""}
      data-via-item={viaItem ?? ""}
      data-current={current ?? ""}
    />
  );
}

/** The project screen needs a project; the shell's rail sets it. */
function PickProject() {
  const { setCurrentProject } = useLaserStable();
  useEffect(() => setCurrentProject(PROJECT_CWD), [setCurrentProject]);
  return null;
}

function Controls() {
  const { actions } = useLaserStable();
  const aui = useAui();
  return (
    <>
      <button data-slot="open-row" onClick={() => void actions.openSession(cliPath())} />
      {/* The sessions panel's row: a switch the runtime makes on its own, not through the controlled selection. */}
      <button data-slot="click-row" onClick={() => aui.threads.switchToThread(cliPath())} />
    </>
  );
}

/** What a person sees when a render throws: nothing. This records it instead. */
class Boundary extends Component<{ children: ReactNode }, { error: string | undefined }> {
  override state = { error: undefined as string | undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    if (this.state.error !== undefined) return <span data-slot="crash">{this.state.error}</span>;
    return this.props.children;
  }
}

function Harness() {
  return (
    <Boundary>
      <LaserProvider url="ws://test">
        <TooltipProvider>
          <PickProject />
          <Controls />
          <Probe />
          <EmptyState />
        </TooltipProvider>
      </LaserProvider>
    </Boundary>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;
let created = 0;
let consoleError: ReturnType<typeof vi.spyOn>;

const cliPath = () => `${PROJECT_CWD}/cli-${created}.jsonl`;
const probe = () => container.querySelector<HTMLElement>('[data-slot="probe"]');
const crash = () => container.querySelector('[data-slot="crash"]')?.textContent ?? undefined;
const suggestion = () => container.querySelector<HTMLButtonElement>('ul[aria-label="Suggested prompts"] button')!;
const calls = (method: string) => world.calls.filter((call) => call.method === method);
const errorsLike = (needle: string) =>
  consoleError.mock.calls.filter((args) => args.some((arg) => String(arg instanceof Error ? arg.message : arg).includes(needle)));

/**
 * The CLI ran `new <project>`: the host's worker holds an unwritten session,
 * the catalog lists it, and the host tells every client its attention moved.
 * The provider re-lists on that, coalesced over 250ms.
 */
const cliCreates = async (extra: Partial<SessionSummary> = {}, options: { wait?: boolean } = {}) => {
  created += 1;
  const path = cliPath();
  // A new array: the fake hands the store its own array, and a row pushed in
  // place would already be "known" when the notification asks.
  world.sessions = [...world.sessions, summary({ path, cwd: PROJECT_CWD, messageCount: 0, attention: "finished_unread", ...extra })];
  world.states[path] = sessionState({ path, cwd: PROJECT_CWD, messageCount: 0 });
  FakeHostClient.current.notify("pi/session/attention", { path, cwd: PROJECT_CWD, attention: "finished_unread", at: "2026-09-09T00:00:00.000Z" });
  if (options.wait !== false) await settle(320);
  return path;
};

beforeEach(async () => {
  // Deliberately not an act environment: see the file comment.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  localStorage.clear();
  created = 0;
  world = createWorld();
  FakeHostClient.reset(world);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(<Harness />);
  await settle(50);
});
afterEach(async () => {
  root.unmount();
  await settle(10);
  container.remove();
  consoleError.mockRestore();
});

describe("a session created from outside while the project screen is up", () => {
  it("starts on the project screen: an unstarted main thread and no session", () => {
    expect(crash()).toBeUndefined();
    expect(probe()?.dataset["current"]).toBe("");
    expect(probe()?.dataset["main"]).toMatch(/^__LOCALID_/);
    expect(probe()?.dataset["threads"]).toBe("");
  });

  it("lists the row and keeps the project screen where it is", async () => {
    const path = await cliCreates();
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    expect(probe()?.dataset["threads"]).toBe(path);
    expect(probe()?.dataset["current"]).toBe("");
    expect(probe()?.dataset["main"]).toMatch(/^__LOCALID_/);
  });

  it("opens the row when a deep link selects it", async () => {
    const path = await cliCreates();
    container.querySelector<HTMLButtonElement>('[data-slot="open-row"]')!.click();
    await vi.waitFor(() => {
      expect(probe()?.dataset["current"]).toBe(path);
      expect(probe()?.dataset["main"]).toBe(path);
      expect(probe()?.dataset["remote"]).toBe(path);
      expect(probe()?.dataset["threads"]).toBe(path);
    });
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
  });

  it("survives a suggestion pressed after the row arrived, reusing that session", async () => {
    const path = await cliCreates();
    suggestion().click();
    await settle(100);
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    // The launcher's rule: an unstarted session in the project is the one to use.
    expect(calls("session/new")).toHaveLength(0);
    expect(calls("session/prompt").map((c) => (c.params as { path: string }).path)).toEqual([path]);
    // One row for one session, and the screen is on it.
    expect(probe()?.dataset["current"]).toBe(path);
    expect(probe()?.dataset["remote"]).toBe(path);
    expect(probe()?.dataset["viaItem"]).toBe(path);
    expect(probe()?.dataset["threads"]?.split("|").filter(Boolean)).toHaveLength(1);
  });

  it("survives a suggestion pressed the instant the row arrives", async () => {
    const path = await cliCreates({}, { wait: false });
    suggestion().click();
    await settle(400);
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    expect(calls("session/prompt").map((c) => (c.params as { path: string }).path)).toEqual([path]);
    expect(probe()?.dataset["current"]).toBe(path);
    expect(probe()?.dataset["remote"]).toBe(path);
    expect(probe()?.dataset["viaItem"]).toBe(path);
    expect(probe()?.dataset["threads"]?.split("|").filter(Boolean)).toHaveLength(1);
  });

  it("survives a row that arrives while the first send is creating its own session", async () => {
    suggestion().click();
    // The row lands between `session/new` and the reply's adoption.
    await settle(0);
    const path = await cliCreates({}, { wait: false });
    await settle(400);
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    expect(calls("session/new")).toHaveLength(1);
    const own = (calls("session/prompt")[0]?.params as { path: string }).path;
    expect(own).not.toBe(path);
    expect(probe()?.dataset["current"]).toBe(own);
    expect(probe()?.dataset["remote"]).toBe(own);
    expect(probe()?.dataset["viaItem"]).toBe(own);
    expect(new Set(probe()?.dataset["threads"]?.split("|").filter(Boolean))).toEqual(new Set([own, path]));
  });

  it("survives the row being clicked in the sessions panel while a send is reusing it", async () => {
    const path = await cliCreates();
    suggestion().click();
    container.querySelector<HTMLButtonElement>('[data-slot="click-row"]')!.click();
    await settle(100);
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    expect(calls("session/prompt").map((c) => (c.params as { path: string }).path)).toEqual([path]);
    expect(probe()?.dataset["current"]).toBe(path);
    expect(probe()?.dataset["remote"]).toBe(path);
    expect(probe()?.dataset["viaItem"]).toBe(path);
    expect(probe()?.dataset["threads"]?.split("|").filter(Boolean)).toEqual([path]);
  });

  it("survives a deep link onto the row while a send is reusing it", async () => {
    const path = await cliCreates();
    suggestion().click();
    container.querySelector<HTMLButtonElement>('[data-slot="open-row"]')!.click();
    await settle(100);
    expect(crash()).toBeUndefined();
    expect(errorsLike("useClientLookup")).toEqual([]);
    expect(calls("session/prompt").map((c) => (c.params as { path: string }).path)).toEqual([path]);
    expect(probe()?.dataset["current"]).toBe(path);
    expect(probe()?.dataset["remote"]).toBe(path);
    expect(probe()?.dataset["viaItem"]).toBe(path);
    expect(probe()?.dataset["threads"]?.split("|").filter(Boolean)).toHaveLength(1);
  });
});
