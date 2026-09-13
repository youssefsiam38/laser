// @vitest-environment happy-dom
/**
 * M16-T34 / D-245: Settings says how much disk the log store is taking and what
 * it keeps, and clearing it is a decision a person makes with the facts in
 * front of them.
 */
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogStats } from "@lasercode/protocol";

const client = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn(() => () => {}) }));
const actions = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client, actions }) }));

import { LogStoreSetting } from "../../src/components/settings/LogStoreSetting.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { click, render, text } from "./mcp/harness.js";

const stats: LogStats = {
  total: 139_296,
  bySection: { provider: 25_148, tools: 90_000, session: 20_000, subagents: 4_000, host: 148 },
  oldestAt: "2026-09-01T08:00:00.000Z",
  newestAt: "2026-09-13T08:00:00.000Z",
  bytes: 1_288_490_188,
  retention: {
    maxRows: 200_000,
    maxAgeDays: 14,
    bodyBudgetBytes: 1024 * 1024 * 1024,
    bodiesPerSession: 50,
    retainedBodyBytes: 900 * 1024 * 1024,
  },
  providerResponseBodies: "unavailable",
};

let root: Root | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  client.request.mockReset();
  actions.toast.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const mount = async () => {
  ({ root } = await render(<TooltipProvider><LogStoreSetting /></TooltipProvider>));
};

it("shows the size, what is kept and what is dropped, from the host's own limits", async () => {
  client.request.mockImplementation((method: string) => (method === "pi/logs/stats" ? Promise.resolve({ stats }) : Promise.resolve({})));
  await mount();

  expect(client.request).toHaveBeenCalledWith("pi/logs/stats", {});
  const body = text();
  expect(body).toContain("1.20 GB");
  expect(body).toContain("139,296");
  // The budget is the host's, shown as it reported it — never a literal here.
  expect(body).toContain("900.0 MB of 1.00 GB");
  expect(body).toContain("50 most recent requests in each session");
  expect(body).toContain("14 days");
  expect(body).toContain("200,000");
});

it("asks before clearing, says what goes and what stays, then reloads the numbers", async () => {
  let current = stats;
  client.request.mockImplementation((method: string) => {
    if (method === "pi/logs/stats") return Promise.resolve({ stats: current });
    if (method === "pi/logs/clear") {
      const { oldestAt: _oldest, newestAt: _newest, ...rest } = stats;
      current = { ...rest, total: 0, bytes: 24_576, retention: { ...stats.retention, retainedBodyBytes: 0 } };
      return Promise.resolve({ deleted: 139_296 });
    }
    return Promise.resolve({});
  });
  await mount();

  await click("Clear the log store");
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const asked = dialog!.textContent ?? "";
  expect(asked).toContain("139,296 rows");
  expect(asked).toContain("1.20 GB");
  expect(asked).toContain("returns that space to the disk");
  expect(asked).toContain("conversations, projects and settings are untouched");

  // Cancel keeps everything, and is the focused default.
  expect(document.activeElement?.textContent).toContain("Keep the logs");
  await click("Keep the logs");
  expect(client.request).not.toHaveBeenCalledWith("pi/logs/clear", expect.anything());

  await click("Clear the log store");
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.includes("Clear the log store"));
  await act(async () => confirm!.click());
  expect(client.request).toHaveBeenCalledWith("pi/logs/clear", {});
  expect(actions.toast).toHaveBeenCalledWith("info", "Cleared the log store: 139,296 rows removed.");
  expect(text()).toContain("24 KB");
  expect(text()).not.toContain("139,296");
});

it("says why there is nothing to show when the host has no store", async () => {
  client.request.mockImplementation((method: string) =>
    method === "pi/logs/stats"
      ? Promise.reject(new Error("Logging is switched off for this host (logFile: false)."))
      : Promise.resolve({}),
  );
  await mount();
  expect(text()).toContain("Logging is switched off for this host");
  expect(document.querySelector("button")).toBeNull();
});
