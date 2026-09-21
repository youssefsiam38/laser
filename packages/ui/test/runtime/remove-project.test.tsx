// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@lasercode/protocol";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));

import { LaserProvider, useLaserStable, useLaserState, type LaserActions } from "../../src/runtime/LaserProvider.js";
import type { ArchiveStore } from "../../src/runtime/threadList.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../world/fake-host.js";

const FIRST = `${PROJECT_CWD}/first.jsonl`;
const SECOND = `${PROJECT_CWD}/second.jsonl`;
const OTHER_CWD = "/q";
const OTHER = `${OTHER_CWD}/other.jsonl`;

let controls: { actions: LaserActions; archive: ArchiveStore; projects: readonly string[]; codeProject: string | undefined; toasts: string[] };

function Probe() {
  const { actions, archive, projects, currentProject } = useLaserStable();
  const toasts = useLaserState((state) => state.toasts.map((toast) => toast.text));
  controls = { actions, archive, projects, codeProject: currentProject, toasts };
  return null;
}

let root: Root;
let container: HTMLDivElement;
let world: World;

const project = (cwd: string, sessionCount: number): ProjectInfo => ({
  cwd, name: cwd.slice(1), addedAt: "2026-09-06T00:00:00.000Z", trust: "not_required", pinned: false, sessionCount,
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  globalThis.history.replaceState(null, "", "/");
  world = createWorld();
  FakeHostClient.reset(world);
  addSession(world, FIRST, PROJECT_CWD);
  addSession(world, SECOND, PROJECT_CWD);
  addSession(world, OTHER, OTHER_CWD);
  // Unpinned after "Remove": the host keeps listing a directory whose
  // transcripts it has seen, and the client subtracts what it archived.
  world.overrides["pi/project/list"] = () => ({ projects: [project(PROJECT_CWD, 2), project(OTHER_CWD, 1)] });
  world.overrides["pi/project/remove"] = () => ({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(): Promise<void> {
  await act(async () => root.render(<LaserProvider url="ws://test"><Probe /></LaserProvider>));
  await act(async () => settle(40));
}

async function run(step: () => unknown): Promise<void> {
  await act(async () => { await step(); await settle(30); });
}

const lastToast = () => controls.toasts.at(-1);

describe("removing a project", () => {
  it("takes a project whose chats are all archived off the rail, even after its sessions were opened", async () => {
    await mount();
    await run(() => controls.actions.openSession(FIRST));
    await run(() => controls.actions.openSession(SECOND));
    await run(() => controls.actions.openSession(OTHER));
    expect(controls.projects).toContain(PROJECT_CWD);

    await run(() => { controls.archive.add(FIRST); controls.archive.add(SECOND); });
    await run(() => controls.actions.removeProject(PROJECT_CWD));

    expect(lastToast()).toBe("p is off the list. Nothing on disk was deleted.");
    expect(controls.projects).not.toContain(PROJECT_CWD);
    expect(controls.projects).toContain(OTHER_CWD);
  });

  it("leaves the project when the archived session on screen was in it", async () => {
    await mount();
    await run(() => controls.actions.openSession(SECOND));
    await run(() => controls.actions.openSession(FIRST));
    expect(controls.codeProject).toBe(PROJECT_CWD);

    await run(() => { controls.archive.add(FIRST); controls.archive.add(SECOND); });
    await run(() => controls.actions.removeProject(PROJECT_CWD));

    expect(lastToast()).toBe("p is off the list. Nothing on disk was deleted.");
    expect(controls.projects).not.toContain(PROJECT_CWD);
    expect(controls.codeProject).not.toBe(PROJECT_CWD);
  });

  it("keeps the project in the rail while an unarchived session in it is open", async () => {
    await mount();
    await run(() => controls.actions.openSession(FIRST));
    // The host no longer counts anything there, but the person is looking at FIRST.
    world.overrides["pi/project/list"] = () => ({ projects: [project(OTHER_CWD, 1)] });
    await run(() => controls.archive.add(SECOND));
    await run(() => controls.actions.removeProject(PROJECT_CWD));

    expect(lastToast()).toBe("p is off the list. It stays in the rail while one of its sessions is open, so that session cannot go missing.");
    expect(controls.projects).toContain(PROJECT_CWD);
  });
});
