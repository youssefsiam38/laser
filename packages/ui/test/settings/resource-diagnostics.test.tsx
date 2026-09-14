// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResourceMeasure, ResourceProcess, ResourceRetention, ResourceSnapshot } from "@lasercode/protocol";

const fixture = vi.hoisted(() => ({
  state: undefined as any,
  client: { request: vi.fn() },
  actions: { openSession: vi.fn(), tasks: { stop: vi.fn() }, toast: vi.fn() },
  close: vi.fn(),
  reveal: vi.fn(),
  end: vi.fn(),
  poll: vi.fn(),
  pollStop: vi.fn(),
  pollRefresh: undefined as (() => void) | undefined,
}));

vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client: fixture.client, actions: fixture.actions }),
  useLaserState: (selector: (state: unknown) => unknown) => selector(fixture.state),
}));
vi.mock("@/components/workbench", () => ({ useWorkbench: () => ({ close: fixture.close }) }));
vi.mock("@/fleet/fleet-state", () => ({ revealInFleet: fixture.reveal }));
vi.mock("@/components/agents/end-agent", () => ({ requestEndAgent: fixture.end }));
vi.mock("@/runtime/visible-poll", () => ({
  startVisiblePoll: (refresh: () => void, interval: number) => {
    fixture.poll(refresh, interval);
    fixture.pollRefresh = refresh;
    return fixture.pollStop;
  },
  onVisible: () => () => {},
}));

import { ResourceDiagnostics, RESOURCE_POLL_MS } from "../../src/components/settings/resources/ResourceDiagnostics.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { click, render, text } from "./mcp/harness.js";

const available = (value: number): ResourceMeasure => ({ status: "available", value });
const unavailable = (reason: "unsupported_platform" | "incomplete_coverage" = "unsupported_platform"): ResourceMeasure => ({ status: "unavailable", reason });

const host: ResourceProcess = {
  key: "10@host",
  pid: 10,
  startToken: "host",
  role: "host",
  label: "host",
  memory: { pss: available(100), resident: available(1_000), peakResident: available(1_500), privateResident: available(90), commit: unavailable() },
  cpu: { seconds: available(2.5) },
  elapsedMs: available(20_000),
  io: { readBytes: unavailable(), writeBytes: unavailable() },
  source: "proc",
};
const worker: ResourceProcess = {
  ...host,
  key: "11@worker",
  pid: 11,
  startToken: "worker",
  parentKey: host.key,
  role: "project_worker",
  label: "worker",
  project: { id: "opaque", label: "project" },
  associations: { sessionIds: ["s1"], runIds: ["r1"], taskIds: ["t1"] },
  memory: { ...host.memory, pss: available(300) },
};

const snapshot: ResourceSnapshot = {
  id: "rs_1",
  at: "2026-09-13T10:00:00.000Z",
  platform: "linux",
  durationMs: 20,
  processes: [host, worker],
  totals: {
    coverage: { processes: 2, measured: 2, complete: true },
    knownPhysicalBytes: 400,
    physical: available(400),
    residentCoverage: { processes: 2, measured: 2, complete: true },
    knownResidentBytes: 2_000,
    residentSum: available(2_000),
  },
  byRole: [
    { role: "host", coverage: { processes: 1, measured: 1, complete: true }, knownPhysicalBytes: 100, physical: available(100) },
    { role: "project_worker", coverage: { processes: 1, measured: 1, complete: true }, knownPhysicalBytes: 300, physical: available(300) },
  ],
  health: { ok: true, collectors: [{ name: "proc", status: "ok" }], truncated: false, crossCheck: { status: "unavailable" } },
};
const history = { ...snapshot, id: "rs_0", at: "2026-09-13T09:59:55.000Z", totals: { ...snapshot.totals, knownPhysicalBytes: 350, physical: available(350) } };
const retention: ResourceRetention = { maxAgeMs: 3_600_000, maxSnapshots: 3_600, maxProcessRows: 20_000, maxBytes: 67_108_864, snapshots: 2, processRows: 4, bytes: 4_096, ownershipRecords: 1, maxOwnershipRecords: 512 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fixture.client.request.mockReset();
  fixture.actions.openSession.mockReset().mockResolvedValue(undefined);
  fixture.actions.tasks.stop.mockReset().mockResolvedValue({});
  fixture.actions.toast.mockReset();
  fixture.close.mockReset();
  fixture.reveal.mockReset();
  fixture.end.mockReset();
  fixture.poll.mockReset();
  fixture.pollStop.mockReset();
  fixture.pollRefresh = undefined;
  fixture.state = {
    sessions: [{ id: "s1", path: "/p/s1.jsonl", cwd: "/p", createdAt: snapshot.at, modifiedAt: snapshot.at, messageCount: 1 }],
    agents: { runs: { r1: { runId: "r1", sessionPath: "/p/s1.jsonl", status: "running" } } },
    tasks: { tasks: { t1: { id: "t1", sessionPath: "/p/s1.jsonl", status: "running" } } },
    open: { "/p/s1.jsonl": { pending: [{ id: "p1" }], queue: { steering: [], followUp: [] } } },
    catalogPresence: { "/p/s1.jsonl": true },
    catalogGroups: [{ cwd: "/p", total: 4 }],
    sessionsLoaded: true,
    connection: "open",
  };
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  delete (globalThis as { desktop?: unknown }).desktop;
});

async function mount() {
  fixture.client.request.mockImplementation((method: string) => {
    if (method === "resource/snapshot") return Promise.resolve({ snapshot, retention });
    if (method === "resource/history") return Promise.resolve({ snapshots: [history, snapshot], retention });
    if (method === "resource/export") return Promise.resolve({ document: '{"redacted":true}', bytes: 17, truncated: false });
    return Promise.resolve({});
  });
  ({ root, container } = await render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

it("loads snapshot then history, starts one 5s visible poll, and stops it on unmount", async () => {
  await mount();
  expect(fixture.client.request.mock.calls.slice(0, 2)).toEqual([
    ["resource/snapshot", { refresh: true }],
    ["resource/history", { limit: 60 }],
  ]);
  expect(fixture.poll).toHaveBeenCalledWith(expect.any(Function), RESOURCE_POLL_MS);
  await act(async () => fixture.pollRefresh?.());
  expect(fixture.client.request).toHaveBeenLastCalledWith("resource/snapshot", { refresh: true });
  await act(async () => root!.unmount());
  root = undefined;
  expect(fixture.pollStop).toHaveBeenCalledOnce();
});

it("shows honest distinct summaries, producer handoffs, retention and keyboard-operable hidden detail", async () => {
  await mount();
  const body = text();
  expect(body).toContain("Whole application");
  expect(body).toContain("Renderer");
  expect(body).toContain("Host");
  expect(body).toContain("Workers");
  expect(body).toContain("Unavailable · No process with this role was discovered");
  expect(body).toContain("Contract handoff: M18-T4");
  expect(body).toContain("Contract handoff: M18-T5");
  expect(body).toContain("Contract handoff: M18-T6");
  expect(body).toContain("Contract handoff: M18-T7");
  expect(body).toContain("3,600 samples");
  expect(body).toContain("64.0 MB");
  const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Show details for worker"]')!;
  expect([...container!.querySelectorAll('[data-slot="collapsible-content"]')].every((node) => node.hasAttribute("hidden"))).toBe(true);
  expect(trigger.tagName).toBe("BUTTON");
  trigger.focus();
  await act(async () => trigger.click());
  const content = [...container!.querySelectorAll('[data-slot="collapsible-content"]')].find((node) => !node.hasAttribute("hidden"))!;
  expect(content.textContent).toContain("11@worker");
  expect(text()).not.toContain("Associations hosted by a process");
  expect(text()).toContain("They do not divide or allocate its memory");
});

it("re-resolves navigation and native lifecycle ownership at click time without a PID action", async () => {
  (globalThis as { desktop?: unknown }).desktop = {};
  await mount();
  await click("Show details for worker");
  const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Hide details for worker"]')!;
  const detail = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const buttons = [...detail.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.some((button) => /PID|signal|kill/i.test(button.textContent ?? ""))).toBe(false);
  await act(async () => buttons.find((button) => button.textContent === "Show in fleet")!.click());
  await act(async () => { await Promise.resolve(); });
  expect(fixture.close).toHaveBeenCalled();
  expect(fixture.actions.openSession).toHaveBeenCalledWith("/p/s1.jsonl");
  expect(fixture.reveal).toHaveBeenCalledWith("agent:/p/s1.jsonl");

  await act(async () => buttons.find((button) => button.textContent?.includes("End agent"))!.click());
  expect(fixture.end).toHaveBeenCalledWith("r1");
  fixture.end.mockClear();
  delete fixture.state.agents.runs.r1;
  await act(async () => buttons.find((button) => button.textContent?.includes("End agent"))!.click());
  expect(fixture.end).not.toHaveBeenCalled();
  expect(text()).toContain("This run is no longer in the current run registry");

  await act(async () => buttons.find((button) => button.textContent === "Stop")!.click());
  expect(fixture.actions.tasks.stop).toHaveBeenCalledWith("/p/s1.jsonl", "t1");
  fixture.actions.tasks.stop.mockClear();
  delete fixture.state.tasks.tasks.t1;
  await act(async () => buttons.find((button) => button.textContent === "Stop")!.click());
  expect(fixture.actions.tasks.stop).not.toHaveBeenCalled();
  expect(text()).toContain("This task is no longer in the current task registry");
});

it("retains the last good data on refresh failure and downloads the host export byte-for-byte", async () => {
  await mount();
  fixture.client.request.mockRejectedValueOnce(new Error("collector did not answer"));
  await click("Refresh");
  expect(text()).toContain("last good sample is still shown");
  expect(text()).toContain("Stale");

  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await click("Download redacted report");
  expect(fixture.client.request).toHaveBeenLastCalledWith("resource/export", {});
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
  expect(await blob.text()).toBe('{"redacted":true}');
  expect(anchorClick).toHaveBeenCalledOnce();
  expect(text()).toContain("Redacted resource report downloaded");
});

it("surfaces host export truncation and a retryable export failure", async () => {
  await mount();
  fixture.client.request.mockImplementation((method: string) => method === "resource/export"
    ? Promise.resolve({ document: "{}", bytes: 2, truncated: true })
    : Promise.resolve({ snapshot, retention }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await click("Download redacted report");
  expect(text()).toContain("older samples were omitted");
  fixture.client.request.mockRejectedValueOnce(new Error("export unavailable"));
  await click("Download redacted report");
  expect(text()).toContain("Could not download the redacted report");
  expect(text()).toContain("export unavailable");
});

it("draws the empty and degraded states without turning unavailable data into success", async () => {
  const empty = {
    ...snapshot,
    processes: [],
    totals: {
      ...snapshot.totals,
      coverage: { processes: 0, measured: 0, complete: false },
      knownPhysicalBytes: 0,
      physical: unavailable("incomplete_coverage"),
    },
    byRole: [],
    health: { ok: false, collectors: [{ name: "proc", status: "failed", detail: "collector timed out" }], truncated: true, crossCheck: { status: "diverged", detail: "working sets differed" } },
  } satisfies ResourceSnapshot;
  fixture.client.request.mockImplementation((method: string) => method === "resource/snapshot"
    ? Promise.resolve({ snapshot: empty, retention })
    : Promise.resolve({ snapshots: [empty], retention }));
  ({ root, container } = await render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(text()).toContain("No owned processes were discovered");
  expect(text()).toContain("Needs attention");
  expect(text()).toContain("collector timed out");
  expect(text()).toContain("Truncated at the collection bound");
  expect(text()).toContain("Unavailable · 0 of 0 processes measured");
});

it("draws the deliberate initial failure state with retry instead of an empty success surface", async () => {
  fixture.client.request.mockRejectedValue(new Error("Resource diagnostics are disabled on this host."));
  ({ root, container } = await render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(text()).toContain("Could not read resource diagnostics");
  expect(text()).toContain("disabled on this host");
  expect(text()).not.toContain("No owned processes were discovered");
});
