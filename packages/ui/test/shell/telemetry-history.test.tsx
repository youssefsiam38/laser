// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { HistorySection } from "../../src/components/telemetry/history-section.js";
import * as model from "../../src/components/shell/model.js";

const mocks = vi.hoisted(() => ({ loadAllEntries: vi.fn(async () => true), refreshEntries: vi.fn(async () => {}), running: false,
  current: "/session", entries: {} as Record<string, readonly unknown[]>, refusing: [] as string[] }));
vi.mock("../../src/runtime/index.js", () => ({
  useLaserState: (selector: (state: unknown) => unknown) => selector({ current: mocks.current, open: { [mocks.current]: { path: mocks.current, running: mocks.running, entries: mocks.entries[mocks.current], history: { complete: false, branchesUnloaded: false } } } }),
  useSessionMeta: () => ({ path: mocks.current, running: mocks.running, compacting: false }),
  useLaserStable: () => ({ actions: mocks }),
  useWholeTranscriptRefusal: () => ({ paused: mocks.refusing.includes("whole_transcript"), explanation: mocks.refusing.includes("whole_transcript") ? "This window is low on memory, so loading a whole conversation at once is paused. Earlier messages still load a page at a time." : undefined }),
}));
vi.mock("../../src/components/shell/shell-context.js", async () => {
  const { useState } = await import("react");
  return { useShell: () => { const [historyOpen, setHistoryOpen] = useState(false); return { historyOpen, setHistoryOpen }; } };
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.loadAllEntries.mockClear();
  mocks.refreshEntries.mockClear();
  mocks.running = false;
  mocks.current = "/session";
  mocks.entries = { "/session": [] };
  mocks.refusing = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("reuses immutable snapshots on switch-back while keeping folded counts truthful and invalidating new entries", async () => {
  const project = vi.spyOn(model, "historyRows");
  const entry = (id: string) => Object.freeze({ id, type: "message", message: Object.freeze({ role: "user", content: id }) });
  const first = Object.freeze([entry("first")]);
  const second = Object.freeze([entry("second"), entry("third")]);
  mocks.entries = { "/session": first, "/other": second };
  const render = () => act(async () => root.render(<TooltipProvider><HistorySection /></TooltipProvider>));
  await render();
  expect(container.textContent).toContain("1 loaded");
  expect(container.querySelector('button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("false");
  mocks.current = "/other";
  await render();
  expect(container.textContent).toContain("2 loaded");
  mocks.current = "/session";
  await render();
  expect(container.textContent).toContain("1 loaded");
  expect(project.mock.calls.map(([entries]) => entries)).toEqual([first, second]);
  mocks.entries["/session"] = Object.freeze([...first, entry("new turn"), Object.freeze({ id: "label", type: "label", targetId: "first", label: "bookmark" })]);
  await render();
  expect(project).toHaveBeenCalledTimes(3);
  expect(project.mock.results[2]?.value[0]?.label).toBe("bookmark");
  expect(container.textContent).toContain("2 loaded");
  expect(mocks.refreshEntries).not.toHaveBeenCalled();
  expect(mocks.loadAllEntries).not.toHaveBeenCalled();
});

it("explains a pressure refusal in place and does not offer a bypass", async () => {
  const render = () => act(async () => root.render(<TooltipProvider><HistorySection /></TooltipProvider>));
  await render();
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => disclosure.click());
  mocks.refreshEntries.mockClear();
  mocks.refusing = ["whole_transcript"];
  await render();
  expect(container.textContent).toContain("This window is low on memory, so loading a whole conversation at once is paused. Earlier messages still load a page at a time.");
  const refresh = container.querySelector<HTMLButtonElement>('button[aria-label^="Refresh paused"]')!;
  expect(refresh.disabled).toBe(true);
  await act(async () => refresh.click());
  expect(mocks.refreshEntries).not.toHaveBeenCalled();
});

it("refreshes only metadata when History opens and while its run settles", async () => {
  const render = () => act(async () => root.render(<TooltipProvider><HistorySection /></TooltipProvider>));
  await render();
  expect(mocks.refreshEntries).not.toHaveBeenCalled();
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(mocks.refreshEntries.mock.calls).toEqual([[{ tail: true }]]);
  mocks.running = true;
  await render();
  mocks.running = false;
  await render();
  expect(mocks.refreshEntries.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ tail: true }]));
  expect(mocks.loadAllEntries).not.toHaveBeenCalled();
});

it("qualifies a held count on the history figure while collapsed", async () => {
  const entry = (id: string) => ({ id, type: "message", message: { role: "user", content: id } });
  mocks.entries = { "/session": [entry("a"), entry("b")] };
  await act(async () => root.render(<TooltipProvider><HistorySection history={{ prompts: 40, records: 100, compactions: 3, branches: 1 }} /></TooltipProvider>));
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure.textContent).toContain("2 of 100");
  expect(container.textContent).not.toMatch(/loaded so far/i);
});
