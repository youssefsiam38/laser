// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceShape, WorkspaceShapeKind } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FilesSection } from "../../src/components/telemetry/files-section.js";
import {
  filesWorkspaceEmptyText,
  resetWorkspaceShapeReader,
  workspaceShapeRequestCount,
} from "../../src/source-control/workspace-shape.js";

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  return {
    request,
    client: { request },
    cwd: "/p" as string | undefined,
  };
});

vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client: mocks.client }),
  useSessionMeta: () => ({ session: mocks.cwd ? { cwd: mocks.cwd } : undefined, path: "/s.jsonl" }),
}));

vi.mock("@/source-control/store.js", () => ({
  openChanges: vi.fn(),
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
  mocks.request.mockReset();
  mocks.cwd = "/p";
  resetWorkspaceShapeReader();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetWorkspaceShapeReader();
  vi.restoreAllMocks();
});

async function render(node: ReactNode) {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const emptyChanges = { scope: "session" as const, repos: [] };

it("repo with no files still says there are no changes", async () => {
  mocks.request.mockImplementation(async () => fakeShape("repo", ["/p"]));
  await render(<FilesSection changes={emptyChanges} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
  const empty = container.querySelector("[data-slot='telemetry-files-empty']");
  expect(empty?.getAttribute("data-kind")).toBe("empty");
  expect(empty?.textContent).toBe(filesWorkspaceEmptyText("empty"));
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith("pi/project/workspace", { cwd: "/p" });
});

it("workspace-of-repos with nothing touched says so in Files", async () => {
  mocks.request.mockImplementation(async () => fakeShape("workspace-of-repos", ["/p/app", "/p/lib"]));
  await render(<FilesSection changes={emptyChanges} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
  const empty = container.querySelector("[data-slot='telemetry-files-empty']");
  expect(empty?.getAttribute("data-kind")).toBe("untouched");
  expect(empty?.textContent).toBe(filesWorkspaceEmptyText("untouched"));
});

it("no-git is not an empty change list in Files", async () => {
  mocks.request.mockImplementation(async () => fakeShape("no-git", []));
  await render(<FilesSection changes={emptyChanges} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
  const empty = container.querySelector("[data-slot='telemetry-files-empty']");
  expect(empty?.getAttribute("data-kind")).toBe("no-git");
  expect(empty?.textContent).toBe(filesWorkspaceEmptyText("no-git"));
  expect(container.textContent).not.toContain("No changes in this workspace.");
});

it("bare-or-submodule is unsupported in Files", async () => {
  mocks.request.mockImplementation(async () => fakeShape("bare-or-submodule", ["/p"]));
  await render(<FilesSection changes={emptyChanges} status="ready" sessionKey="/s.jsonl" open onOpenChange={() => {}} />);
  const empty = container.querySelector("[data-slot='telemetry-files-empty']");
  expect(empty?.getAttribute("data-kind")).toBe("unsupported");
  expect(empty?.textContent).toBe(filesWorkspaceEmptyText("unsupported"));
});

it("does not call the method again when Files re-renders without a refresh", async () => {
  mocks.request.mockImplementation(async () => fakeShape("repo", ["/p"]));
  function Probe() {
    const [tick, setTick] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setTick((n) => n + 1)}>
          tick {tick}
        </button>
        <FilesSection
          changes={emptyChanges}
          status="ready"
          sessionKey="/s.jsonl"
          open
          onOpenChange={() => {}}
          onRefresh={() => {}}
        />
      </>
    );
  }
  await render(<Probe />);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(workspaceShapeRequestCount()).toBe(1);
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.request).toHaveBeenCalledTimes(1);
  const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh files"]');
  expect(refresh).toBeTruthy();
  await act(async () => {
    refresh!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.request).toHaveBeenLastCalledWith("pi/project/workspace", { cwd: "/p", rescan: true });
});
