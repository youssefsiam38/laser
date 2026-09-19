// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceShape, WorkspaceShapeKind } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import {
  ChangesOverlayHost,
  openChanges,
  resetChangesAdapter,
  resetChangesUi,
  setChangesAdapter,
} from "../../src/source-control/index.js";
import { createMockAdapter } from "../../src/source-control/mock.js";
import { setChangesScope } from "../../src/source-control/store.js";
import {
  bindWorkspaceShapeRequest,
  filesWorkspaceEmptyText,
  overlayWorkspaceEmptyCopy,
  readWorkspaceShape,
  resetWorkspaceShapeReader,
} from "../../src/source-control/workspace-shape.js";

vi.mock("../../src/source-control/diff-body.js", () => ({
  DiffBody: ({ page }: { page: { path: string } }) => <div data-slot="diff-body">{page.path}</div>,
}));

function fakeShape(kind: WorkspaceShapeKind, roots: string[]): WorkspaceShape {
  return {
    cwd: "/p",
    kind,
    repositories: roots.map((root, index) => ({
      root,
      name: root.split("/").pop() || root,
      projectRoot: index === 0,
      gitDir: `${root}/.git`,
      insideWorkTree: kind !== "bare-or-submodule",
    })),
    hasCommit: kind === "repo" || kind === "nested-repo",
    truncated: false,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetChangesUi();
  resetChangesAdapter();
  resetWorkspaceShapeReader();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetChangesUi();
  resetChangesAdapter();
  resetWorkspaceShapeReader();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ChangesOverlayHost />
      </TooltipProvider>,
    ),
  );
}

async function open(args: Parameters<typeof openChanges>[0] = { scope: { kind: "session" } }) {
  await act(async () => {
    openChanges(args);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="changes-overlay"]');
  expect(node).toBeTruthy();
  return node!;
}

function emptyAdapter(shape: WorkspaceShape) {
  const request = vi.fn(async () => shape);
  bindWorkspaceShapeRequest(request);
  const adapter = createMockAdapter();
  adapter.listChanges = async (scope) => ({ scope, repos: [] });
  adapter.getWorkspace = (options) => readWorkspaceShape("/p", options);
  return { adapter, request };
}

it("repo with nothing changed keeps the no-changes copy and hides the repository filter", async () => {
  const { adapter, request } = emptyAdapter(fakeShape("repo", ["/p"]));
  setChangesAdapter(adapter);
  await mount();
  await open();
  expect(overlay().textContent).toMatch(/Nothing changed/);
  expect(overlay().querySelector('[data-slot="workspace-empty"]')).toBeNull();
  expect(overlay().querySelector('[data-slot="changes-repo-filter"]')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("workspace-of-repos with nothing touched says the session did not change them", async () => {
  const copy = overlayWorkspaceEmptyCopy("untouched");
  const { adapter } = emptyAdapter(fakeShape("workspace-of-repos", ["/p/app", "/p/lib"]));
  setChangesAdapter(adapter);
  await mount();
  await open();
  const empty = overlay().querySelector('[data-slot="workspace-empty"]');
  expect(empty?.getAttribute("data-kind")).toBe("untouched");
  expect(empty?.textContent).toBe(copy.body);
  expect(overlay().textContent).toContain(copy.title);
  expect(overlay().querySelector('[data-slot="changes-repo-filter"]')).toBeTruthy();
});

it("no-git is not an empty change list", async () => {
  const copy = overlayWorkspaceEmptyCopy("no-git");
  const { adapter } = emptyAdapter(fakeShape("no-git", []));
  setChangesAdapter(adapter);
  await mount();
  await open();
  const empty = overlay().querySelector('[data-slot="workspace-empty"]');
  expect(empty?.getAttribute("data-kind")).toBe("no-git");
  expect(empty?.textContent).toBe(copy.body);
  expect(overlay().textContent).toContain(copy.title);
  expect(overlay().textContent).not.toMatch(/Nothing changed/);
  expect(overlay().querySelector('[data-slot="changes-repo-filter"]')).toBeNull();
});

it("bare-or-submodule says this release cannot show it", async () => {
  const copy = overlayWorkspaceEmptyCopy("unsupported");
  const { adapter } = emptyAdapter(fakeShape("bare-or-submodule", ["/p"]));
  setChangesAdapter(adapter);
  await mount();
  await open();
  const empty = overlay().querySelector('[data-slot="workspace-empty"]');
  expect(empty?.getAttribute("data-kind")).toBe("unsupported");
  expect(empty?.textContent).toBe(copy.body);
  expect(overlay().querySelector('[data-slot="changes-repo-filter"]')).toBeNull();
});

it("hides the repository filter when the workspace is one repository", async () => {
  const request = vi.fn(async () => fakeShape("repo", ["/p/app"]));
  bindWorkspaceShapeRequest(request);
  const adapter = createMockAdapter();
  adapter.getWorkspace = (options) => readWorkspaceShape("/p", options);
  setChangesAdapter(adapter);
  await mount();
  await open({ scope: { kind: "session" } });
  expect(overlay().querySelector('[data-slot="changes-repo-filter"]')).toBeNull();
});

it("shows the repository filter when the workspace has more than one repository", async () => {
  const request = vi.fn(async () => fakeShape("workspace-of-repos", ["/p/app", "/p/lib"]));
  bindWorkspaceShapeRequest(request);
  const adapter = createMockAdapter();
  adapter.listChanges = async (scope) => ({
    scope,
    repos: [{ repo: "/p/app", branch: "main", files: [{ path: "a.ts", status: "modified", added: 1, removed: 0 }] }],
  });
  adapter.getWorkspace = (options) => readWorkspaceShape("/p", options);
  setChangesAdapter(adapter);
  await mount();
  await open({ scope: { kind: "session" } });
  const filter = overlay().querySelector('[data-slot="changes-repo-filter"]');
  expect(filter).toBeTruthy();
  expect(filter?.textContent).toMatch(/All repositories/);
});

it("does not call pi/project/workspace again when the overlay scope updates", async () => {
  const { adapter, request } = emptyAdapter(fakeShape("repo", ["/p"]));
  setChangesAdapter(adapter);
  await mount();
  await open({ scope: { kind: "session" } });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    setChangesScope({ kind: "uncommitted" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(overlay().textContent).toMatch(/Nothing changed/);
  expect(filesWorkspaceEmptyText("empty")).toBe("No changes in this workspace.");
});
