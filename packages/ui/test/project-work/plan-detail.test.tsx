// @vitest-environment happy-dom
/**
 * The Plan detail: the Document and Dependencies views, and the graph
 * (M21-T16, D-355 "Detail, by kind" → Plan).
 *
 * What is proven here is what a screenshot cannot: that the two views are one
 * revision read two ways, that a node carries its key *and* the state the
 * board would show, that a host refusal is rendered in the host's own words
 * with the keys it named, and that a Task the plan stopped listing is still on
 * screen. (AGENTS.md, D-342: a unit test over the real components; nothing
 * here is a browser acceptance run.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanDetail } from "../../src/components/project-work/PlanDetail.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";

import { item } from "./fixture.js";
import { detail, planBody } from "./plan-task-fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;

const rows = [
  item({ entityId: "t1", kind: "task", number: 1, title: "The store", state: "done" }),
  item({ entityId: "t2", kind: "task", number: 2, title: "The shell", state: "ready" }),
  item({ entityId: "t3", kind: "task", number: 3, title: "The board", state: "draft" }),
];

const body = planBody({
  brief: "Ship the embedded workspace.",
  phases: [
    { id: "p1", name: "Spine", summary: "Protocol, host, worker.", taskKeys: ["TASK-1", "TASK-2"] },
    { id: "p2", name: "Surfaces", taskKeys: ["TASK-3"] },
  ],
  dependencies: [
    { from: "TASK-2", to: "TASK-1", reason: "the shell reads the store" },
    { from: "TASK-3", to: "TASK-2" },
  ],
  document: "## How this lands\n\nOne milestone, four tasks.",
});

const text = (): string => container.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => node.textContent?.includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
};

const mount = async (node: React.ReactNode): Promise<void> => {
  await act(async () => root.render(node));
};
const editCode = async (label: string, value: string): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  const editor = container.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  expect(editor).not.toBeNull();
  await act(async () => {
    const view = EditorView.findFromDOM(editor!);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetWorkspaceUi();
});

describe("the plan document", () => {
  it("says where the plan came from, and standalone is a real answer", async () => {
    await mount(<PlanDetail detail={detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body } })} body={body} items={rows} />);
    expect(text()).toContain("Standalone — the prompt was the brief.");
  });

  it("names the spec a plan was derived from", async () => {
    const fromSpec = detail({
      kind: "plan",
      number: 2,
      body: { kind: "plan", plan: body },
      edges: [
        {
          projectId: "p1",
          linkId: "l1",
          relation: "implements",
          subject: { projectId: "p1", kind: "plan", entityId: "e-plan-2", revisionId: "e-plan-2r1", digest: "a".repeat(64), label: "PLAN-2", key: "PLAN-2" },
          object: { projectId: "p1", kind: "spec", entityId: "e-spec-1", revisionId: "e-spec-1r1", digest: "b".repeat(64), label: "The relay", key: "SPEC-1" },
          createdBy: { kind: "person", label: "You" },
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    await mount(<PlanDetail detail={fromSpec} body={body} items={rows} />);
    expect(text()).toContain("from");
    expect(text()).toContain("SPEC-1");
  });

  it("draws the phases over the real tasks, with the state the board would say", async () => {
    await mount(<PlanDetail detail={detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body } })} body={body} items={rows} />);
    expect(container.querySelector("[data-slot='agent-plan']")).not.toBeNull();
    expect(text()).toContain("Spine");
    expect(text()).toContain("Surfaces");
    expect(text()).toContain("The store");
    expect(text()).toContain("Ready");
    // Real counts, never a percentage or a bar.
    expect(text()).toContain("1/3 done");
    expect(text()).not.toMatch(/\d+%/);
    expect(container.querySelector("[role='progressbar']")).toBeNull();
  });

  it("renders the markdown document through the shared renderer", async () => {
    await mount(<PlanDetail detail={detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body } })} body={body} items={rows} />);
    expect(container.querySelector("[data-slot='markdown-document']") ?? container.querySelector("h2")).not.toBeNull();
    expect(text()).toContain("How this lands");
  });

  it("offers no revision controls when the shared detail fence is read-only", async () => {
    const value = detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body } });
    await mount(<PlanDetail detail={value} body={body} items={rows} context={{ store: undefined, detail: value, editable: false, readOnlyReason: "Editing is disabled on an older revision.", onChanged: vi.fn(), items: rows }} />);
    expect(button("Edit plan")).toBeUndefined();
    expect(text()).toContain("Ship the embedded workspace.");
  });

  it("keeps an exact plan draft through Preview and saves it as a fenced revision", async () => {
    const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];
    const store = new ProjectWorkStore({
      projectId: "p1",
      request: (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { ref: {}, entity: {}, revision: { index: 2 }, seq: 8 };
      }) as never,
    });
    const value = detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body } });
    await mount(<PlanDetail detail={value} body={body} items={rows} context={{ store, detail: value, editable: true, onChanged: vi.fn(), items: rows, compact: true }} />);
    await click(button("Edit plan"));
    expect(container.querySelector('[data-slot="work-edit-footer"]')).not.toBeNull();
    await editCode("Brief", "Ship the **whole** workspace.");
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    await click(button("Preview"));
    expect(container.querySelector("[data-slot='markdown-document'] strong")?.textContent).toBe("whole");
    expect(calls).toHaveLength(0);
    await click(button("Cancel"));
    expect(text()).toContain("Ship the embedded workspace.");
    expect(text()).not.toContain("Ship the whole workspace.");
    await click(button("Edit plan"));
    await editCode("Brief", "Ship the **whole** workspace.");
    await click(button("Save as a new revision"));
    const revise = calls.find((call) => call.method === "project/work/revise");
    expect(revise?.params.expectedRevisionId).toBe("e-plan-2r1");
    const written = revise?.params.body as { plan: typeof body };
    expect(written.plan.brief).toBe("Ship the **whole** workspace.");
    expect(written.plan.phases).toEqual(body.phases);
    expect(written.plan.dependencies).toEqual(body.dependencies);
    expect(written.plan.document).toBe(body.document);
  });
});

describe("the dependencies view", () => {
  const open = async (over: Parameters<typeof detail>[0] extends never ? never : Partial<Parameters<typeof detail>[0]> = {}) => {
    const value = detail({ kind: "plan", number: 2, body: { kind: "plan", plan: body }, ...over } as Parameters<typeof detail>[0]);
    await mount(<PlanDetail detail={value} body={body} items={rows} />);
    await click(button("Dependencies"));
  };

  it("is the same revision read another way, and is a real tab", async () => {
    await open();
    const tabs = [...container.querySelectorAll("[role='tab']")];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(container.querySelector("[role='group'][aria-label='Dependency graph']")).not.toBeNull();
  });

  it("gives every node its key, its type and its state, and says what it waits for", async () => {
    await open();
    const nodes = [...container.querySelectorAll("[data-slot='plan-graph-node']")];
    expect(nodes).toHaveLength(3);
    const labels = nodes.map((node) => node.getAttribute("aria-label") ?? "");
    expect(labels).toContain("TASK-1: The store, Done");
    expect(labels.some((label) => label.startsWith("TASK-2: The shell, Ready, waiting on TASK-1"))).toBe(true);
    // One tab stop; the arrows move between nodes.
    expect(nodes.filter((node) => node.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("opens the task a node names", async () => {
    await open();
    const node = [...container.querySelectorAll<HTMLButtonElement>("[data-slot='plan-graph-node']")].find(
      (candidate) => candidate.dataset.nodeKey === "TASK-2",
    );
    await click(node);
    expect(workspaceUi().selection).toMatchObject({ entityId: "t2", kind: "task" });
  });

  it("renders a graph refusal in the host's own words, with the keys it named", async () => {
    await open({
      planGraph: {
        ok: false,
        problems: [{ problem: "cycle", keys: ["TASK-1", "TASK-2", "TASK-1"], message: "TASK-1 → TASK-2 → TASK-1 is a loop; a plan's tasks cannot wait on each other." }],
        orphans: [],
        order: [],
      },
    });
    expect(text()).toContain("TASK-1 → TASK-2 → TASK-1 is a loop; a plan's tasks cannot wait on each other.");
    expect(container.querySelector("[role='alert']")).not.toBeNull();
  });

  it("keeps a task the plan no longer lists, and says so", async () => {
    await open({
      planGraph: {
        ok: true,
        problems: [],
        orphans: [{ key: "TASK-9", entityId: "t9", title: "The old idea", state: "draft", reason: "removed_from_plan" }],
        order: ["TASK-1", "TASK-2", "TASK-3"],
      },
    });
    expect(text()).toContain("No longer in this plan");
    expect(text()).toContain("The old idea");
    expect(text()).toContain("TASK-9");
  });
});
