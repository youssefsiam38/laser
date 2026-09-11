// @vitest-environment happy-dom
/**
 * The general guard for the frozen opening screen (M13-T115, D-218): the real
 * provider, the real destination controller and the real `StartupShell`
 * against a host that holds the restored session's load behind a project
 * trust question, exactly as `ProjectRegistry.ensureTrusted` does before a
 * worker starts. The question must be answerable while the screen is up, and
 * the answer is what brings the screen down. Nothing here knows where the
 * dialog is mounted or how the screen is stacked; if either regresses, the
 * gate never falls and this fails.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotifications, ProjectInfo } from "@lasercode/protocol";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { LaserProvider, PROJECT_STORAGE_KEY } from "../../src/runtime/LaserProvider.js";
import { StartupShell } from "../../src/components/shell/Shell.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const CODE = `${PROJECT_CWD}/code.jsonl`;
const REQUEST: HostNotifications["pi/project/trust_request"] = { id: "trust-1", cwd: PROJECT_CWD, reasons: ["settings.json"], timeoutMs: 120_000 };
const PROJECT: ProjectInfo = { cwd: PROJECT_CWD, name: "p", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", trustReasons: ["settings.json"], pinned: false, sessionCount: 1 };

let root: Root;
let container: HTMLDivElement;
let world: World;
/** Lets the held `session/load` finish, the way a trust answer lets the worker start. */
let releaseLoad: () => void;
let loadsHeld = 0;

const screen = () => document.querySelector<HTMLElement>('[data-slot="startup-restoration"]:not([data-exiting])');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  globalThis.history.replaceState(null, "", "/");
  world = createWorld();
  FakeHostClient.reset(world);
  addSession(world, CODE, PROJECT_CWD, { firstMessage: "yesterday's work" });
  localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
  loadsHeld = 0;
  // The host cannot serve the load until the project's worker may start, and
  // the worker may not start until someone answers the trust question.
  world.overrides["session/load"] = ((params: { path: string }) => {
    loadsHeld += 1;
    FakeHostClient.current.notify("pi/project/trust_request", REQUEST);
    return new Promise((resolve) => {
      releaseLoad = () => resolve({ state: world.states[params.path], replayFrom: 0, seq: 0 });
    });
  }) as never;
  world.overrides["pi/project/trust"] = ((params: { cwd: string; trusted: boolean }) => {
    FakeHostClient.current.notify("pi/project/trust_resolved", { id: REQUEST.id, cwd: params.cwd, trusted: params.trusted });
    releaseLoad();
    return { project: { ...PROJECT, trust: params.trusted ? "trusted" : "declined" } };
  }) as never;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.history.replaceState(null, "", "/");
});

async function mount(): Promise<void> {
  await act(async () => root.render(
    <LaserProvider url="ws://test">
      <StartupShell><main>Operational shell</main></StartupShell>
    </LaserProvider>,
  ));
  await act(async () => settle(40));
}

describe("a trust question during startup restoration", () => {
  it("is asked over the opening screen, and answering it brings the screen down", async () => {
    await mount();

    // The screen is up for the remembered session, whose load the host holds.
    expect(loadsHeld).toBe(1);
    expect(screen()?.getAttribute("aria-label")).toBe("Returning to your last session");
    expect(document.body.textContent).not.toContain("Operational shell");

    // The question reached the person anyway, with focus on the safe answer.
    expect(dialog()?.textContent).toContain("Trust p?");
    expect(dialog()?.textContent).toContain("settings.json");
    expect(document.activeElement).toBe(button("Not now"));

    await act(async () => button("Trust this project")!.click());
    await act(async () => settle(40));

    const trust = world.calls.filter((call) => call.method === "pi/project/trust");
    expect(trust).toHaveLength(1);
    expect(trust[0]!.params).toMatchObject({ cwd: PROJECT_CWD, trusted: true, remember: true });
    expect(dialog()).toBeNull();
    expect(screen()).toBeNull();
    expect(document.body.textContent).toContain("Operational shell");
  });

  it("comes down on Not now as well: the session opens without the project's settings", async () => {
    await mount();
    expect(screen()).not.toBeNull();
    expect(dialog()).not.toBeNull();

    await act(async () => button("Not now")!.click());
    await act(async () => settle(40));

    const trust = world.calls.filter((call) => call.method === "pi/project/trust");
    expect(trust[0]!.params).toMatchObject({ cwd: PROJECT_CWD, trusted: false });
    expect(dialog()).toBeNull();
    expect(screen()).toBeNull();
    expect(document.body.textContent).toContain("Operational shell");
  });
});
