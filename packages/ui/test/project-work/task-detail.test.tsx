// @vitest-environment happy-dom
/**
 * The Project Task detail (M21-T16, D-355 "Detail, by kind" → Task).
 *
 * The rules proven here are the ones a person is protected by, and none of
 * them is visible in a screenshot:
 *
 *   - a completion nothing has accepted is **refused here**, with the sentence
 *     that says why, and no request is sent;
 *   - a legal move calls `project/task/action` with the action that means what
 *     the person asked for;
 *   - a stale upstream is named from the refusal's own `data`;
 *   - a conflict names the other Task, and accepting shared-checkout risk is a
 *     revision of this Task's body (`scope.sharedWith`);
 *   - Start… records an execution link and never moves the Task.
 *
 * (AGENTS.md, D-342: a unit test over the real components.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type ClientRequests } from "@lasercode/protocol";

import { TaskDetail } from "../../src/components/project-work/TaskDetail.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";

import { item } from "./fixture.js";
import { detail, evidence, executionLink, repositoryLink, taskBody, type Detail } from "./plan-task-fixture.js";

const sessions = [
  { path: "/work/app/one.jsonl", id: "s1", cwd: "/work/app", name: "Wiring the board", createdAt: "2026-02-01T00:00:00.000Z", modifiedAt: "2026-02-02T00:00:00.000Z", messageCount: 4 },
  { path: "/elsewhere/two.jsonl", id: "s2", cwd: "/elsewhere", name: "Another project", createdAt: "2026-02-01T00:00:00.000Z", modifiedAt: "2026-02-03T00:00:00.000Z", messageCount: 2 },
];
const agents = [{ name: "builder", description: "Implements a task end to end." }];
const opened: string[] = [];

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast: () => {}, openSession: async (path: string) => void opened.push(path) } }),
    useCapability: () => ({ state: "available" }),
    useLaserState: (selector: (state: unknown) => unknown) =>
      selector({ sessions, agents: { snapshot: { agents } } } as never),
  };
});

let root: Root;
let container: HTMLDivElement;
let calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
let refuse: { method: ProjectWorkMethod; error: Error } | undefined;
let answers: Partial<Record<ProjectWorkMethod, unknown>>;

const rows = [
  item({ entityId: "t7", kind: "task", number: 7, title: "The store", state: "draft" }),
  item({ entityId: "p2", kind: "plan", number: 2, title: "Ship it" }),
];

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ProjectWorkStore => {
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (refuse?.method === method) throw refuse.error;
      if (method === "project/work/list") return { projectId: "p1", seq: 7, items: rows, counts: { total: 2, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 1, task: 1 } } };
      return answers[method] ?? {};
    }) as never,
  });
  store.rememberPath("/work/app");
  return store;
};

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined =>
  buttons().find((node) => (node.textContent ?? "").includes(label) || node.getAttribute("aria-label") === label);
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await settle(5);
  });
};
const editCode = async (label: string, value: string): Promise<void> => {
  let editor: HTMLElement | null = null;
  for (let attempt = 0; attempt < 40 && !editor; attempt += 1) {
    await act(async () => { await settle(25); });
    editor = document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  }
  expect(editor).not.toBeNull();
  await act(async () => {
    const view = EditorView.findFromDOM(editor!);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
};
/** Radix opens on pointerdown, not click; a plain `.click()` never gets there. */
const openMenu = async (label: string): Promise<void> => {
  await act(async () => {
    button(label)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await settle(100);
  });
};
const menuItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[role='menuitem'],[role='menuitemradio']")].find((node) => (node.textContent ?? "").includes(label));

const mount = async (value: Detail, store: ProjectWorkStore): Promise<void> => {
  const body = value.body!.body!;
  if (body.kind !== "task") throw new Error("this test mounts tasks");
  await act(async () => root.render(<TaskDetail store={store} detail={value} body={body.task} items={rows} />));
};

const called = (method: ProjectWorkMethod) => calls.filter((call) => call.method === method);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  refuse = undefined;
  answers = {};
  opened.length = 0;
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[role='dialog'],[role='menu']").forEach((node) => node.remove());
  resetWorkspaceUi();
});

describe("what stands in a task's way", () => {
  it("names the unmet dependency keys in the blocked banner", async () => {
    await mount(
      detail({
        kind: "task",
        number: 44,
        state: "blocked",
        body: { kind: "task", task: taskBody({ dependencies: ["TASK-7", "DES-3"] }) },
        readiness: { ready: false, unmetDependencies: ["TASK-7", "DES-3"], hasAcceptanceEvidence: false, hasPassingVerification: false, blockingComments: 0 },
      }),
      makeStore(),
    );
    const banner = container.querySelector("[data-slot='task-blocked']");
    expect(banner?.textContent).toContain("TASK-7, DES-3 must be done first.");
    expect(banner?.getAttribute("role")).toBe("status");
  });

  it("refuses a completion nothing has accepted, and sends nothing", async () => {
    await mount(
      detail({
        kind: "task",
        number: 44,
        state: "needs_review",
        body: { kind: "task", task: taskBody() },
        readiness: { ready: true, unmetDependencies: [], hasAcceptanceEvidence: false, hasPassingVerification: true, blockingComments: 0 },
      }),
      makeStore(),
    );
    await openMenu("Move TASK-44");
    await click(menuItem("Done"));
    expect(text()).toContain("A task is done when a passing acceptance record says so");
    expect(called("project/task/action")).toHaveLength(0);
  });

  it("asks for the move a person asked for, when the move is legal", async () => {
    answers["project/task/action"] = { entity: {}, transition: { from: "ready", to: "in_progress" }, seq: 8 };
    await mount(
      detail({
        kind: "task",
        number: 44,
        state: "ready",
        body: { kind: "task", task: taskBody() },
        readiness: { ready: true, unmetDependencies: [], hasAcceptanceEvidence: false, hasPassingVerification: false, blockingComments: 0 },
      }),
      makeStore(),
    );
    await openMenu("Move TASK-44");
    await click(menuItem("Running"));
    expect(called("project/task/action")[0]?.params).toMatchObject({
      projectId: "p1",
      entityId: "e-task-44",
      expectedRevisionId: "e-task-44r1",
      action: "start",
    });
  });

  it("names the upstream from the refusal's own data", async () => {
    const error = Object.assign(new Error("PLAN-3 changed after this task was planned. Reconcile it before starting this task."), {
      code: ErrorCodes.ProjectWorkRefused,
      data: { refused: "stale_upstream", upstream: { entityId: "e-plan-3", kind: "plan", key: "PLAN-3", revisionId: "r9" } },
    });
    refuse = { method: "project/task/action", error };
    await mount(
      detail({
        kind: "task",
        number: 44,
        state: "ready",
        body: { kind: "task", task: taskBody() },
        readiness: { ready: true, unmetDependencies: [], hasAcceptanceEvidence: false, hasPassingVerification: false, blockingComments: 0 },
      }),
      makeStore(),
    );
    await openMenu("Move TASK-44");
    await click(menuItem("Running"));
    expect(text()).toContain("PLAN-3 changed after this task was planned.");
    const stale = container.querySelector("[data-slot='task-stale']");
    expect(stale?.textContent).toContain("PLAN-3");
    expect(stale?.textContent).toContain("Open PLAN-3");
  });

  it("shows a stale upstream the host already paused it for", async () => {
    await mount(
      detail({
        kind: "task",
        number: 44,
        body: { kind: "task", task: taskBody() },
        readiness: {
          ready: true,
          unmetDependencies: [],
          hasAcceptanceEvidence: false,
          hasPassingVerification: false,
          blockingComments: 0,
          stalePausedBy: { entityId: "e-plan-2", kind: "plan", key: "PLAN-2", revisionId: "r2" },
        },
      }),
      makeStore(),
    );
    expect(container.querySelector("[data-slot='task-stale']")?.textContent).toContain("PLAN-2 changed after this task was planned.");
  });
});

describe("two tasks writing in the same place", () => {
  const conflicted = () =>
    detail({
      kind: "task",
      number: 44,
      state: "ready",
      body: { kind: "task", task: taskBody({ scope: { packages: ["@lasercode/ui"], repositories: [], paths: ["packages/ui/src"], capabilities: [] } }) },
      conflicts: [
        {
          entityId: "t7",
          key: "TASK-7",
          title: "The store",
          state: "in_progress",
          overlap: { packages: ["@lasercode/ui"], paths: [] },
          observed: true,
          accepted: false,
        },
      ],
    });

  it("names the other task and what it has already written in", async () => {
    await mount(conflicted(), makeStore());
    const panel = container.querySelector("[data-slot='task-conflicts']");
    expect(panel?.textContent).toContain("TASK-7");
    expect(panel?.textContent).toContain("has already written in @lasercode/ui");
  });

  it("records the person's acceptance in this task's own body", async () => {
    answers["project/work/revise"] = { ref: {}, entity: {}, revision: {}, seq: 9 };
    await mount(conflicted(), makeStore());
    await click(button("Accept shared-checkout risk"));
    const revise = called("project/work/revise")[0];
    expect(revise?.params).toMatchObject({ entityId: "e-task-44", expectedRevisionId: "e-task-44r1" });
    expect((revise?.params.body as { task: { scope: { sharedWith: string[] } } }).task.scope.sharedWith).toEqual(["TASK-7"]);
  });
});

describe("attempts, evidence and checkpoints", () => {
  const worked = () =>
    detail({
      kind: "task",
      number: 44,
      state: "needs_review",
      body: { kind: "task", task: taskBody({ planKey: "PLAN-2", acceptance: [{ id: "a1", text: "The board refuses an illegal drop", machineVerifiable: true, command: "pnpm -F @lasercode/ui test" }] }) },
      executionLinks: [
        executionLink({ linkId: "x1", targetId: "s1", attempt: 1, branch: "agents/board", baseCommitObjectId: "abc1234def", outcome: "failed", endedAt: "2026-02-02T09:00:00.000Z" }),
        executionLink({ linkId: "x2", targetId: "s1", attempt: 2, startedAt: "2026-02-02T10:00:00.000Z" }),
      ],
      evidence: [
        evidence({ evidenceId: "ev1", role: "acceptance", kind: "test", summary: "pnpm -F @lasercode/ui test", outcome: "passed", repositoryLinkId: "r1" }),
        evidence({ evidenceId: "ev2", role: "supporting", kind: "command_output", summary: "The attempt failed", outcome: "failed" }),
      ],
      repositoryLinks: [repositoryLink({ linkId: "r1", commit: "0123456789abcdef", checkpointId: "cp-3", relation: "verified_at" })],
    });

  it("lists every attempt, newest first, with what it ran on", async () => {
    await mount(worked(), makeStore());
    const attempts = [...container.querySelectorAll("[data-slot='task-attempts'] > li")];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.textContent).toContain("Attempt 2");
    expect(attempts[1]?.textContent).toContain("Attempt 1");
    expect(attempts[1]?.textContent).toContain("agents/board");
    expect(attempts[1]?.textContent).toContain("abc1234def");
    expect(text()).toContain("2 attempts");
  });

  it("opens the conversation an attempt ran in", async () => {
    await mount(worked(), makeStore());
    await click(button("Open the conversation"));
    expect(opened).toEqual(["/work/app/one.jsonl"]);
  });

  it("says what each piece of evidence is, and the exact revision it ran against", async () => {
    await mount(worked(), makeStore());
    const evidenceList = container.querySelector("[data-slot='task-evidence']");
    expect(evidenceList?.textContent).toContain("Test run");
    expect(evidenceList?.textContent).toContain("acceptance");
    expect(evidenceList?.textContent).toContain("0123456789");
    expect(evidenceList?.textContent).toContain("verified at");
  });

  it("draws the checkpoints git recorded", async () => {
    await mount(worked(), makeStore());
    const trail = container.querySelector("[data-slot='checkpoint-trail']");
    expect(trail?.textContent).toContain("verified at");
    expect(trail?.textContent).toContain("checkpoint");
  });

  it("says a task with acceptance evidence can be completed", async () => {
    await mount(worked(), makeStore());
    expect(text()).toContain("1 acceptance record — this task can be completed.");
  });

  it("has an honest empty state when nothing has been tried", async () => {
    await mount(detail({ kind: "task", number: 44, body: { kind: "task", task: taskBody() } }), makeStore());
    expect(text()).toContain("Nothing has been tried yet.");
    expect(text()).toContain("No repository states are recorded against this task yet.");
  });
});

describe("task authoring", () => {
  it("keeps every write disabled behind the shared historical/archive fence", async () => {
    const source = taskBody();
    const value = detail({ kind: "task", number: 44, body: { kind: "task", task: source } });
    const store = makeStore();
    await act(async () => root.render(<TaskDetail store={store} detail={value} body={source} items={rows} context={{ store, detail: value, editable: false, readOnlyReason: "Editing is disabled on an older revision.", onChanged: vi.fn(), items: rows }} />));
    expect(button("Edit task")).toBeUndefined();
    expect(button("Start…")?.disabled).toBe(true);
    expect(button("Nobody yet")?.disabled).toBe(true);
    expect(called("project/work/revise")).toHaveLength(0);
  });

  it("keeps the full task and its records through Preview, then saves explicitly", async () => {
    answers["project/work/revise"] = { ref: {}, entity: {}, revision: { index: 2 }, seq: 9 };
    const source = taskBody({
      outcome: "Ship the board.",
      notes: "Keep the **reasoning**.",
      scope: { packages: ["@lasercode/ui"], repositories: ["repo1"], paths: ["packages/ui/src"], capabilities: ["project-work"], sharedWith: ["TASK-7"] },
    });
    const value = detail({ kind: "task", number: 44, body: { kind: "task", task: source }, evidence: [evidence({ evidenceId: "ev1" })] });
    const store = makeStore();
    await act(async () => root.render(<TaskDetail store={store} detail={value} body={source} items={rows} context={{ store, detail: value, editable: true, onChanged: vi.fn(), items: rows, compact: true }} />));
    await click(button("Edit task"));
    expect(document.body.querySelector('[data-slot="work-edit-footer"]')).not.toBeNull();
    await editCode("Outcome", "Ship the **complete** board.");
    expect(document.body.querySelectorAll(".cm-editor")).toHaveLength(1);
    await click(button("Preview"));
    expect(document.body.querySelector("[data-slot='markdown-document'] strong")?.textContent).toBe("complete");
    expect(called("project/work/revise")).toHaveLength(0);
    await click(button("Cancel"));
    expect(text()).toContain("Ship the board.");
    expect(text()).not.toContain("Ship the complete board.");
    await click(button("Edit task"));
    await editCode("Outcome", "Ship the **complete** board.");
    await click(button("Save as a new revision"));
    const revise = called("project/work/revise")[0];
    const written = revise?.params.body as { task: typeof source };
    expect(written.task.outcome).toBe("Ship the **complete** board.");
    expect(written.task.scope.capabilities).toEqual(["project-work"]);
    expect(written.task.scope.sharedWith).toEqual(["TASK-7"]);
    expect(value.evidence).toHaveLength(1);
  });
});

describe("who does it, and where it happens", () => {
  it("assigns the task to an agent this device has, as a revision", async () => {
    answers["project/work/revise"] = { ref: {}, entity: {}, revision: {}, seq: 9 };
    await mount(detail({ kind: "task", number: 44, body: { kind: "task", task: taskBody() } }), makeStore());
    await openMenu("Nobody yet");
    await click(menuItem("builder"));
    const revise = called("project/work/revise")[0];
    expect((revise?.params.body as { task: { assignment: unknown } }).task.assignment).toEqual({ policy: "agent", agentName: "builder" });
  });

  it("offers only this project's conversations, and links the attempt to the one picked", async () => {
    answers["project/task/link-execution"] = { link: {}, entity: {}, seq: 10 };
    await mount(detail({ kind: "task", number: 44, body: { kind: "task", task: taskBody() } }), makeStore());
    await click(button("Start…"));
    expect(text()).toContain("Wiring the board");
    expect(text()).not.toContain("Another project");
    await click(button("Wiring the board"));
    const link = called("project/task/link-execution")[0];
    expect(link?.params).toMatchObject({ entityId: "e-task-44", expectedRevisionId: "e-task-44r1" });
    expect(link?.params.execution).toMatchObject({ kind: "session", targetId: "s1", attempt: 1 });
    // Linking is not a transition: nothing asked the task to move.
    expect(called("project/task/action")).toHaveLength(0);
  });

  it("shows the conflicts the host answers the link with", async () => {
    answers["project/task/link-execution"] = {
      link: {},
      entity: {},
      seq: 10,
      conflicts: [{ entityId: "t7", key: "TASK-7", title: "The store", state: "in_progress", overlap: { packages: [], paths: ["packages/ui/src"] }, observed: false, accepted: false }],
    };
    await mount(detail({ kind: "task", number: 44, body: { kind: "task", task: taskBody() } }), makeStore());
    await click(button("Start…"));
    await click(button("Wiring the board"));
    expect(text()).toContain("TASK-7 says it writes in packages/ui/src.");
  });

  it("opens the plan a task belongs to", async () => {
    await mount(detail({ kind: "task", number: 44, body: { kind: "task", task: taskBody({ planKey: "PLAN-2" }) } }), makeStore());
    await click(button("PLAN-2"));
    expect(workspaceUi().selection).toMatchObject({ entityId: "p2", kind: "plan" });
  });
});

type _Requests = ClientRequests;
