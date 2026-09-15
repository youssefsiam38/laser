// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResourceMeasure, ResourceProcess, ResourceRetention, ResourceSnapshot } from "@lasercode/protocol";

const fixture = vi.hoisted(() => ({
  state: undefined as any,
  client: {
    request: vi.fn(),
    get connection() { return fixture.state?.connection ?? "closed"; },
  },
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

it("shows an initial disconnected state without polling or inventing a refresh error", async () => {
  fixture.state = { ...fixture.state, connection: "closed" };
  await mount();
  expect(text()).toContain("Resource diagnostics need a host connection");
  expect(text()).toContain("will refresh as soon as the connection returns");
  expect(fixture.client.request).not.toHaveBeenCalled();
  expect(fixture.poll).not.toHaveBeenCalled();
});

it("stops polling while disconnected and refreshes once immediately on reconnect", async () => {
  await mount();
  const initialSnapshots = fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot").length;

  fixture.state = { ...fixture.state, connection: "closed" };
  await act(async () => {
    root!.render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>);
  });
  expect(fixture.pollStop).toHaveBeenCalledOnce();
  expect(text()).toContain("The host is disconnected. These values are the last sample received.");
  await act(async () => fixture.pollRefresh?.());
  expect(fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot")).toHaveLength(initialSnapshots);

  fixture.state = { ...fixture.state, connection: "open" };
  await act(async () => {
    root!.render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>);
    await Promise.resolve();
  });
  expect(fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot")).toHaveLength(initialSnapshots + 1);
  expect(fixture.poll).toHaveBeenCalledTimes(2);
});

it("does not turn a transport disconnect during refresh into a refresh error", async () => {
  await mount();
  let rejectRefresh: ((reason: Error) => void) | undefined;
  fixture.client.request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
  await click("Refresh");
  fixture.state = { ...fixture.state, connection: "closed" };
  await act(async () => {
    root!.render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>);
    rejectRefresh?.(new Error("socket closed"));
    await Promise.resolve();
  });
  expect(text()).toContain("These values are the last sample received");
  expect(text()).not.toContain("latest refresh failed");
  expect(text()).not.toContain("socket closed");
});

it("keeps initial and manual refreshes available while hidden but guards poll refreshes", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await mount();
  const afterInitial = fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot").length;
  expect(afterInitial).toBe(1);

  await click("Refresh");
  const afterManual = fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot").length;
  expect(afterManual).toBe(2);
  await act(async () => fixture.pollRefresh?.());
  expect(fixture.client.request.mock.calls.filter(([method]) => method === "resource/snapshot")).toHaveLength(2);
});

it("acknowledges and disables manual controls while a refresh is in flight", async () => {
  await mount();
  let resolveRefresh: ((value: { snapshot: ResourceSnapshot; retention: ResourceRetention }) => void) | undefined;
  fixture.client.request.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  await click("Refresh");
  const refresh = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Refreshing"))!;
  const download = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Download redacted report"))!;
  expect(refresh.disabled).toBe(true);
  expect(download.disabled).toBe(true);
  await act(async () => resolveRefresh?.({ snapshot, retention }));
  expect(refresh.disabled).toBe(false);
});

it("shows honest summaries, retained-state table semantics, human copy and keyboard-operable detail", async () => {
  await mount();
  const body = text();
  expect(body).toContain("Whole application");
  expect(body).toContain("Renderer");
  expect(body).toContain("Host");
  expect(body).toContain("Workers");
  expect(body).toContain("Unavailable · No process with this role was discovered");
  expect(body).toContain("Retained bytes are not currently reported by Project workers");
  expect(body).not.toMatch(/RP-\d|M18-T|typed producer|contract handoff/i);
  expect(body).toContain("Process detailsWorking");
  expect(body).toContain("No desktop measurement is available yet");
  expect(body).toContain("3,600 samples");
  expect(container!.querySelectorAll('[data-slot="number-ticker"]')).toHaveLength(3);
  const table = container!.querySelector<HTMLTableElement>('[data-section="retained-state"] table')!;
  expect(table).toBeInstanceOf(HTMLTableElement);
  expect(table.querySelector("caption")?.textContent).toBe("Retained state by store and owner");
  expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Store",
    "Owner",
    "Count",
    "Retained bytes",
  ]);
  expect(table.querySelector('thead th:nth-child(2)')?.className).toContain("hidden md:table-cell");
  expect(table.querySelector('tbody th[scope="row"] [data-handoff="T4"]')).not.toBeNull();
  expect(body).toContain("64.0 MB");
  const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Show details for worker"]')!;
  expect([...container!.querySelectorAll('[data-slot="collapsible-content"]')].every((node) => node.hasAttribute("hidden"))).toBe(true);
  expect(trigger.tagName).toBe("BUTTON");
  trigger.focus();
  await act(async () => trigger.click());
  const content = [...container!.querySelectorAll('[data-slot="collapsible-content"]')].find((node) => !node.hasAttribute("hidden"))!;
  expect(content.textContent).toContain("11@worker");
  const unavailableValue = [...content.querySelectorAll("dd")].find((node) => node.textContent?.includes("Not available on this platform"))!;
  expect(unavailableValue.className).toContain("whitespace-normal");
  expect(unavailableValue.className).not.toContain("truncate");
  expect(text()).not.toContain("Associations hosted by a process");
  expect(text()).toContain("They do not divide or allocate its memory");
});

it("renders the retained counters the host reports, and says what is still missing from them", async () => {
  const complete: ResourceSnapshot = {
    ...snapshot,
    stores: {
      entries: { taskRegistry: { count: 12, bytes: 65_536 }, deliveryRegistry: { count: 4 } },
      coverage: { workers: 1, answered: 1, complete: true },
    },
  };
  fixture.client.request.mockImplementation((method: string) => method === "resource/snapshot"
    ? Promise.resolve({ snapshot: complete, retention })
    : Promise.resolve({ snapshots: [complete], retention }));
  ({ root, container } = await render(<TooltipProvider><ResourceDiagnostics /></TooltipProvider>));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const rowOf = (store: string) => container!.querySelector(`[data-section="retained-state"] [data-store="${store}"]`)!.closest("tr")!;
  expect(rowOf("taskRegistry").textContent).toContain("12");
  expect(rowOf("taskRegistry").textContent).toContain("64 KB");
  expect(rowOf("taskRegistry").textContent).not.toContain("not currently reported");
  expect(rowOf("deliveryRegistry").textContent).toContain("4");
  expect(rowOf("deliveryRegistry").textContent).not.toContain("This count is not currently reported");
  // A counter with no producer yet is still named, never drawn as zero.
  expect(rowOf("providerQueues").textContent).toContain("This count is not currently reported by Workers");

  const partial: ResourceSnapshot = {
    ...snapshot,
    stores: {
      entries: { taskRegistry: { count: 12 }, deliveryRegistry: { count: 4 } },
      coverage: { workers: 2, answered: 1, complete: false, reason: "collector_failed" },
    },
  };
  // A producer that sends a byte total anyway is still only half the machine.
  partial.stores!.entries.taskRegistry!.bytes = 65_536;
  fixture.client.request.mockImplementation((method: string) => method === "resource/snapshot"
    ? Promise.resolve({ snapshot: partial, retention })
    : Promise.resolve({ snapshots: [partial], retention }));
  await click("Refresh");
  expect(rowOf("taskRegistry").textContent).toContain("at least; 1 of 2 workers answered");
  expect(rowOf("taskRegistry").textContent).toContain("Retained bytes are complete only when every live worker answers");
  expect(rowOf("taskRegistry").textContent).not.toContain("64 KB");
  // The host counted delivery itself, so a silent worker cannot soften it.
  expect(rowOf("deliveryRegistry").textContent).not.toContain("at least");
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
  expect(text()).toContain("This run is not currently known to the run registry");
  const actionAlert = container!.querySelector('[data-slot="error-state"]')!;
  expect(actionAlert.getAttribute("role")).toBe("alert");
  const dismiss = [...actionAlert.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Dismiss"))!;
  expect(dismiss.className).toContain("pointer-coarse:min-h-11");
  await act(async () => dismiss.click());
  expect(container!.querySelector('[data-slot="error-state"]')).toBeNull();

  await act(async () => buttons.find((button) => button.textContent === "Stop")!.click());
  expect(fixture.actions.tasks.stop).toHaveBeenCalledWith("/p/s1.jsonl", "t1");
  fixture.actions.tasks.stop.mockClear();
  delete fixture.state.tasks.tasks.t1;
  await act(async () => buttons.find((button) => button.textContent === "Stop")!.click());
  expect(fixture.actions.tasks.stop).not.toHaveBeenCalled();
  expect(text()).toContain("This task is not currently known to the task registry");

  for (const button of container!.querySelectorAll<HTMLButtonElement>('[data-slot="resource-diagnostics"] button')) {
    expect(button.className, button.textContent ?? button.getAttribute("aria-label") ?? "button").toContain("pointer-coarse:min-h-11");
  }
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
  const truncated = [...container!.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes("older ones were omitted"));
  expect(truncated).toBeDefined();
  // What was omitted is the *older* end: the host exports the newest window.
  expect(truncated?.textContent).toContain("most recent samples");
  expect(truncated?.classList.contains("sr-only")).toBe(false);
  fixture.client.request.mockRejectedValueOnce(new Error("export unavailable"));
  await click("Download redacted report");
  expect(text()).not.toContain("older ones were omitted");
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
  expect(text()).toContain("Process detailsFailed · collector timed out");
  expect(text()).toContain("Differs from desktop measurements · working sets differed");
  expect(text()).not.toContain("diverged");
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
