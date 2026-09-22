// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/hooks/index.js", async (original) => ({
  ...(await original<typeof import("../../src/hooks/index.js")>()),
  useBreakpoint: () => "mobile" as const,
  useIsWide: () => false,
}));
vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ projects: ["/work/app"], actions: { toast: () => {} } }),
    useCapability: () => ({ state: "available" }),
    useLaserState: (selector: (state: unknown) => unknown) => selector({ agents: { snapshot: { agents: [] } }, sessions: [] }),
  };
});

import { ProjectWorkspace } from "../../src/components/project-work/Workspace.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { bindProjectWork, projectWorkFor, resetProjectWork } from "../../src/project-work/registry.js";
import { openWorkspace, resetWorkspaceUi, selectWork } from "../../src/project-work/workspace-state.js";
import type { ProjectWorkMethod } from "../../src/project-work/store.js";

import { item } from "./fixture.js";
import { bodyPage, detailFixture, specFixture } from "./bodies-fixture.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetProjectWork();
  resetWorkspaceUi();
  const row = item({ entityId: "e1", kind: "spec", number: 1, title: "A narrow detail" });
  const detail = detailFixture({ kind: "spec", number: 1, entityId: "e1", title: row.title, body: bodyPage({ kind: "spec", spec: specFixture() }) });
  const request = (async (method: ProjectWorkMethod) => {
    if (method === "project/work/list") return { projectId: "p1", seq: 7, items: [row], counts: { total: 1, needsAttention: 0, byKind: { spec: 1, research: 0, design: 0, plan: 0, task: 0 } } };
    if (method === "project/work/get") return detail;
    if (method === "project/work/identity") return { projectId: "p1", state: "linked", choices: [], hidden: false, detail: "This folder is part of this project." };
    throw new Error(`unexpected ${method}`);
  }) as never;
  bindProjectWork(request);
  const store = projectWorkFor("p1")!;
  store.rememberPath("/work/app");
  await store.open();
  openWorkspace({ projectId: "p1" });
  selectWork({ entityId: "e1", kind: "spec" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[data-slot='sheet-content']").forEach((node) => node.remove());
  resetProjectWork();
  resetWorkspaceUi();
});

it("opens the existing Inspector as a sheet from a narrow opened detail", async () => {
  await act(async () => root.render(<TooltipProvider><ProjectWorkspace /></TooltipProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const open = document.body.querySelector<HTMLButtonElement>('button[aria-label="Details and review"]');
  expect(open).not.toBeNull();
  await act(async () => open!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const sheet = document.body.querySelector("[data-slot='sheet-content']");
  expect(sheet).not.toBeNull();
  expect(sheet?.querySelector("[data-slot='work-inspector']")).not.toBeNull();
  expect(sheet?.textContent).toContain("This item");
});
