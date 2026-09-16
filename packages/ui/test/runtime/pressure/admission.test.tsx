// @vitest-environment happy-dom
/**
 * What a window refuses when memory is short, and what it must never touch
 * doing it (RP-8 milestone F, D-265).
 *
 * The refusal is proved through the real provider and a real client: the host
 * publishes its summary, the window reads it the way the host decides it, and
 * the one thing it will not start — a whole-transcript read — is refused
 * *before* a request leaves the process. Everything a person is holding stays
 * exactly where it was: the transcript on screen, the draft they typed, the
 * conversation they selected. Bounded reads keep working, and the moment the
 * host says the pressure has passed, so does the refusal.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryPressureLevelState, MemoryPressureRoleState } from "@lasercode/protocol";

vi.setConfig({ testTimeout: 15_000 });

vi.mock("../../../src/client.js", async (original) => {
  const { FakeWorkerClient } = await import("../fake-worker.js");
  const { historyWindow } = await import("@lasercode/protocol");
  return { ...(await original<typeof import("../../../src/client.js")>()), HostClient: class extends FakeWorkerClient {
    override async request(method: string, params: unknown): Promise<unknown> {
      const result = await super.request(method, params);
      if (method !== "pi/session/entries") return result;
      const p = params as import("@lasercode/protocol").ClientRequests["pi/session/entries"]["params"];
      if (!p.window) return result;
      return historyWindow(result as { entries: unknown[]; leafId: string | null }, p.window, {
        path: p.path, epoch: "fixture", seq: FakeWorkerClient.world.live[p.path]!.seq,
      });
    }
  } };
});
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p>{text}</p> }));

import { LaserProvider, useLaserStable, useLaserView, useRendererPressure, type LaserActions } from "../../../src/runtime/LaserProvider.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { addSession, createWorld, FakeWorkerClient, PROJECT_CWD, runTurn, settle, type World } from "../fake-worker.js";

const PATH = `${PROJECT_CWD}/pressure.jsonl`;
let root: Root;
let container: HTMLDivElement;
let world: World;
let actions: LaserActions;
let view: ReturnType<typeof useLaserView>;
let refusing: readonly string[] = [];
let rows: readonly { action: string; refusal?: string | undefined }[] = [];
let refusalRenders = 0;

function RefusalProbe() {
  useRendererPressure((state) => state.refusing.includes("whole_transcript"));
  refusalRenders += 1;
  return null;
}

function Controls() {
  const stable = useLaserStable();
  actions = stable.actions;
  view = useLaserView();
  const pressure = useRendererPressure();
  refusing = pressure.refusing;
  rows = pressure.rows;
  useEffect(() => { void stable.actions.openSession(PATH); }, [stable.actions]);
  return null;
}

const flush = async () => { await act(async () => settle(30)); };

const role = (name: MemoryPressureRoleState["role"], level: MemoryPressureLevelState): MemoryPressureRoleState =>
  level === "unknown"
    ? { role: name, level, inputs: [], coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" } }
    : {
        role: name,
        level,
        inputs: [{ kind: "physical", value: { status: "available", value: 800 * 1024 * 1024 }, warningBytes: 512 * 1024 * 1024, criticalBytes: 768 * 1024 * 1024 }],
        coverage: { expected: 1, answered: 1, complete: true },
      };

/** What the host publishes to the windows on this machine. */
const publish = async (epoch: number, hostLevel: MemoryPressureLevelState): Promise<void> => {
  const roles = [role("host", hostLevel), role("project_worker", "normal"), role("desktop_renderer", "unknown"), role("machine", "normal")];
  const level = hostLevel === "normal" ? "unknown" : hostLevel; // the renderer row is unknown, by design
  const summary = { level, roles, refusing: [], totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 } };
  await act(async () => {
    for (const client of FakeWorkerClient.instances) client.deliver("resource/pressure", { epoch, summary } as never);
    await settle(5);
  });
  await flush();
};

const wholeReads = () => world.calls.filter((call) => {
  if (call.method !== "pi/session/entries") return false;
  const window = (call.params as { window?: { all?: boolean } }).window;
  return window === undefined || window.all === true;
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  addSession(world, PATH);
  for (let index = 1; index <= 60; index++) runTurn(world, PATH, `Prompt ${index}`, `Answer ${index}`);
  FakeWorkerClient.reset(world);
  refusalRenders = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<LaserProvider url="ws://test"><TooltipProvider><ThreadPrimitive.Root>
    <Controls />
    <RefusalProbe />
    <ComposerPrimitive.Root><ComposerPrimitive.Input data-test="composer" /></ComposerPrimitive.Root>
  </ThreadPrimitive.Root></TooltipProvider></LaserProvider>));
  await flush();
  expect(view?.blocks.length).toBeGreaterThan(0);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("refuses a whole-transcript read without sending anything, and keeps everything a person holds", async () => {
  const blocks = view?.blocks.length;
  const path = view?.path;
  const input = container.querySelector<HTMLTextAreaElement>('[data-test="composer"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "half a thought");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  await publish(1, "critical");
  expect(refusing).toEqual(["whole_transcript"]);

  const before = world.calls.length;
  await act(async () => { await actions.loadAllEntries(); });
  await flush();
  // Nothing was asked for: no request of any kind left this window.
  expect(world.calls.length).toBe(before);
  expect(wholeReads()).toHaveLength(0);
  // And nothing here moved.
  expect(view?.path).toBe(path);
  expect(view?.blocks.length).toBe(blocks);
  expect(input.value).toBe("half a thought");
  expect(document.activeElement).toBe(input);
});

it("keeps bounded reads working while it refuses the whole tree", async () => {
  await publish(1, "warning");
  const before = view?.blocks.length ?? 0;
  await act(async () => { await actions.loadEarlierEntries(); });
  await flush();
  expect(view!.blocks.length).toBeGreaterThan(before);
  expect(wholeReads()).toHaveLength(0);
  // A tail refresh is bounded too, and is never refused.
  await act(async () => { await actions.refreshEntries({ tail: true }); });
  await flush();
  expect(wholeReads()).toHaveLength(0);
});

it("gives a manual refresh no way around the policy, and says why", async () => {
  await publish(1, "critical");
  const before = world.calls.length;
  await act(async () => { await actions.refreshEntries(); });
  await flush();
  expect(world.calls.length).toBe(before);
  expect(refusing).toEqual(["whole_transcript"]);
  // The refusal is recorded once, where this window keeps its own record.
  expect(rows.filter((row) => row.action === "admission_refused" && row.refusal === "whole_transcript")).toHaveLength(1);
});

it("stops refusing when the host says the pressure has passed", async () => {
  await publish(1, "critical");
  expect(refusing).toEqual(["whole_transcript"]);
  await publish(2, "normal");
  expect(refusing).toEqual([]);
  await act(async () => { await actions.loadAllEntries(); });
  await flush();
  expect(wholeReads().length).toBeGreaterThan(0);
});

it("keeps a selected refusal subscriber still when unrelated pressure state changes", async () => {
  const initial = refusalRenders;
  await act(async () => {
    for (const client of FakeWorkerClient.instances) client.deliver("resource/pressure", { malformed: true } as never);
    await settle(5);
  });
  expect(refusalRenders).toBe(initial);
  await publish(5, "critical");
  expect(refusalRenders).toBe(initial + 1);
  await publish(4, "critical");
  expect(refusalRenders).toBe(initial + 1);
});

it("ignores a stale publication, so an older decision cannot lift a refusal", async () => {
  await publish(5, "critical");
  await publish(4, "normal");
  expect(refusing).toEqual(["whole_transcript"]);
});
