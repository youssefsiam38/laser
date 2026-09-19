// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { HistorySection } from "../../src/components/telemetry/history-section.js";
import { useSessionTelemetry } from "../../src/components/shell/TelemetryPanel.js";
import type { SessionTelemetry } from "@lasercode/protocol";

const mocks = vi.hoisted(() => {
  const listeners: Array<(method: string, params: unknown) => void> = [];
  const request = vi.fn();
  const subscribe = vi.fn((listener: (method: string, params: unknown) => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  });
  return {
    listeners,
    request,
    subscribe,
    client: { request, subscribe },
    current: "/session",
    entries: {} as Record<string, readonly unknown[]>,
    complete: false,
  };
});

vi.mock("../../src/runtime/index.js", () => ({
  useLaserState: (selector: (state: unknown) => unknown) =>
    selector({
      current: mocks.current,
      open: {
        [mocks.current]: {
          path: mocks.current,
          running: false,
          entries: mocks.entries[mocks.current],
          history: { complete: mocks.complete, branchesUnloaded: false },
        },
      },
    }),
  useSessionMeta: () => ({ path: mocks.current, running: false, compacting: false }),
  useLaserStable: () => ({
    client: mocks.client,
    actions: { refreshEntries: async () => {}, fork: async () => {}, jump: async () => {} },
  }),
  useWholeTranscriptRefusal: () => ({ paused: false, explanation: undefined }),
}));
vi.mock("../../src/components/shell/shell-context.js", async () => {
  const { useState } = await import("react");
  return {
    useShell: () => {
      const [historyOpen, setHistoryOpen] = useState(false);
      return { historyOpen, setHistoryOpen };
    },
  };
});

const snapshot = (over: Partial<SessionTelemetry> = {}): SessionTelemetry => ({
  revision: "r1.test",
  environmentKey: "e1.test",
  authority: "live",
  scope: "session",
  spend: { billing: "none" },
  history: { prompts: 2, records: 4, compactions: 0, branches: 0 },
  work: { turns: 2, durationMs: 0, tools: { total: 7, ranked: [], other: 0, failed: [] } },
  ...over,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.listeners.length = 0;
  mocks.request.mockReset();
  mocks.subscribe.mockClear();
  mocks.current = "/session";
  mocks.entries = { "/session": [] };
  mocks.complete = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("requests telemetry once, takes session/update snapshots, and never polls", async () => {
  const first = snapshot();
  const next = snapshot({ history: { prompts: 3, records: 6, compactions: 0, branches: 0 } });
  mocks.request.mockImplementation(async () => first);
  function Probe() {
    const telemetry = useSessionTelemetry();
    return <div>{telemetry ? `${telemetry.history?.records}` : "none"}</div>;
  }
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe("4");
  expect(mocks.request.mock.calls).toEqual([["pi/session/telemetry", { path: "/session" }]]);
  await act(async () => {
    for (const listener of mocks.listeners) {
      listener("session/update", { sessionPath: "/session", telemetry: next });
    }
  });
  expect(container.textContent).toBe("6");
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("shows History as the session total when the whole session is loaded", async () => {
  const entry = (id: string) => ({ id, type: "message", message: { role: "user", content: id } });
  const label = { id: "label", type: "label", targetId: "one", label: "bookmark" };
  mocks.entries = { "/session": [entry("one"), entry("two"), label] };
  mocks.complete = true;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <HistorySection history={{ prompts: 2, records: 3, compactions: 0, branches: 0 }} />
      </TooltipProvider>,
    ),
  );
  expect(container.textContent).toContain("3");
  expect(container.textContent).not.toMatch(/\d+ of \d+/);
});

it("qualifies History only while the client holds fewer records than the session", async () => {
  const entry = (id: string) => ({ id, type: "message", message: { role: "user", content: id } });
  mocks.entries = { "/session": [entry("one"), entry("two")] };
  mocks.complete = false;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <HistorySection history={{ prompts: 10, records: 20, compactions: 0, branches: 0 }} />
      </TooltipProvider>,
    ),
  );
  expect(container.textContent).toMatch(/2 of 20/);
});
