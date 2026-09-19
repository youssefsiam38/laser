// @vitest-environment happy-dom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  return {
    request,
    stable: {
      client: { request },
      actions: { toast: vi.fn() },
      projectInfo: {
        "/workspace/api": {
          cwd: "/workspace/api", name: "API", addedAt: "2026-01-01T00:00:00.000Z",
          trust: "trusted", pinned: true, sessionCount: 2,
        },
        "/workspace/site": {
          cwd: "/workspace/site", name: "Site", addedAt: "2026-01-01T00:00:00.000Z",
          trust: "trusted", pinned: true, sessionCount: 1,
        },
      },
    },
  };
});
vi.mock("@/runtime", () => ({
  useCapability: () => ({ state: "available" }),
  useLaserStable: () => mocks.stable,
}));

import { SettingsScreen } from "../../src/components/settings/SettingsScreen.js";
import { WorkbenchProvider } from "../../src/components/workbench/index.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { click, field, render, text, type } from "./mcp/harness.js";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  mocks.request.mockReset();
});

it("shows blocked, trust and legacy resolver state without exposing saved arguments", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string; config?: unknown }) => {
    if (method === "pi/project/env/status") {
      return params.cwd === "/workspace/api"
        ? { status: { cwd: params.cwd, state: "failed", approved: true, error: "The saved setup exited before Bash could start.", resolverArgumentCount: 2, config: { enabled: true, command: "/opt/tools/project-env", args: [], required: true } } }
        : { status: { cwd: params.cwd, state: "untrusted", approved: false, config: { enabled: true, preface: "source scripts/project-shell.sh", command: "", args: [], required: true } } };
    }
    if (method === "pi/project/env/set") {
      return { status: { cwd: params.cwd, state: "untrusted", approved: false, config: params.config } };
    }
    return {};
  });

  ({ root } = await render(
    <TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="projects" /></WorkbenchProvider></TooltipProvider>,
  ));
  await act(async () => { await Promise.resolve(); });
  await click("Expand API project settings");

  expect(text()).toContain("Blocked");
  expect(text()).toContain("The saved setup exited before Bash could start.");
  expect(text()).toContain("Executable: /opt/tools/project-env · 2 saved arguments hidden");
  expect(text()).not.toContain("private-value");
  await click("Collapse API project settings");
  expect(text()).toContain("Not trusted");
  await click("Expand Site project settings");
  expect(text()).toContain("Trust this project before its saved setup can run.");
  await click("Save command");
  expect(text()).toContain("Saved, but it will not run until this project is trusted.");
});

it("replaces Environment with collapsible Projects and saves exactly one Bash pre-command per project", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string; config?: unknown }) => {
    if (method === "pi/project/env/status") {
      return params.cwd === "/workspace/api"
        ? { status: { cwd: params.cwd, state: "ready", approved: true, config: { enabled: true, preface: "source .venv/bin/activate", command: "", args: [], required: true } } }
        : { status: { cwd: params.cwd, state: "not-configured", approved: false } };
    }
    if (method === "pi/project/env/set") {
      return { status: { cwd: params.cwd, state: params.config ? "ready" : "not-configured", approved: Boolean(params.config), ...(params.config ? { config: params.config } : {}) } };
    }
    return {};
  });

  ({ root } = await render(
    <TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="projects" /></WorkbenchProvider></TooltipProvider>,
  ));
  await act(async () => { await Promise.resolve(); });
  await click("Expand API project settings");

  expect(text()).toContain("Projects");
  expect(text()).not.toContain("Environment");
  expect(field("Command to run before Bash").value).toBe("source .venv/bin/activate");
  expect(document.querySelector('[aria-label="Collapse API project settings"]')).toBeTruthy();
  expect(document.querySelector('[aria-label="Expand Site project settings"]')).toBeTruthy();

  await click("Collapse API project settings");
  await click("Expand Site project settings");
  await type("Command to run before Bash", "source scripts/project-shell.sh");
  await click("Save command");
  expect(mocks.request).toHaveBeenCalledWith("pi/project/env/set", {
    cwd: "/workspace/site",
    config: {
      enabled: true,
      preface: "source scripts/project-shell.sh",
      command: "",
      args: [],
      required: true,
    },
  });

  await type("Command to run before Bash", "");
  await click("Remove command");
  expect(mocks.request).toHaveBeenLastCalledWith("pi/project/env/set", {
    cwd: "/workspace/site",
    config: null,
  });
});

it("saves the per-project agent isolation default with token-only controls", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string; isolation?: string; retention?: string }) => {
    if (method === "pi/project/env/status") {
      return { status: { cwd: params.cwd, state: "not-configured", approved: false } };
    }
    if (method === "pi/project/isolation/set") {
      return { ok: true };
    }
    if (method === "pi/project/checkpoint/retention/set") {
      return { project: { cwd: params.cwd, name: "API", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 2, checkpointRetention: params.retention } };
    }
    return {};
  });

  ({ root } = await render(
    <TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="projects" /></WorkbenchProvider></TooltipProvider>,
  ));
  await act(async () => { await Promise.resolve(); });
  await click("Expand API project settings");
  expect(text()).toContain("Decide per agent");
  expect(text()).toContain("Each new agent isolates when this project can");
  expect(text()).not.toContain("start_agent");
  expect(text()).not.toContain("worktree strict");
  expect(text()).not.toContain("The caller's worktree");
  await click("Share my checkout");
  expect(mocks.request).toHaveBeenCalledWith("pi/project/isolation/set", { cwd: "/workspace/api", isolation: "share" });
  expect(text()).toContain("New agents share this checkout");
});

it("saves per-project checkpoint retention with token-only controls", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string; retention?: string }) => {
    if (method === "pi/project/env/status") {
      return { status: { cwd: params.cwd, state: "not-configured", approved: false } };
    }
    if (method === "pi/project/checkpoint/retention/set") {
      return { project: { cwd: params.cwd, name: "API", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 2, checkpointRetention: params.retention } };
    }
    return {};
  });

  ({ root } = await render(
    <TooltipProvider><WorkbenchProvider><SettingsScreen initialTab="projects" /></WorkbenchProvider></TooltipProvider>,
  ));
  await act(async () => { await Promise.resolve(); });
  await click("Expand API project settings");
  expect(text()).toContain("Last 200 turns");
  await click("Off");
  expect(mocks.request).toHaveBeenCalledWith("pi/project/checkpoint/retention/set", { cwd: "/workspace/api", retention: "off" });
  expect(text()).toContain("Existing checkpoints for this project are removed now");
});
