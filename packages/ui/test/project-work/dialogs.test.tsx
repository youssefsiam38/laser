// @vitest-environment happy-dom
/**
 * Create, Archive and Delete.
 *
 * The two things these have to get right, and the two things a screenshot
 * cannot prove: the next key is on screen *before* anything is created, and
 * **Enter confirms neither** destructive act — the typed field swallows it and
 * the cancelling control holds focus when the dialog opens (D-355, AGENTS.md).
 */
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRequests, ProjectWorkKind } from "@lasercode/protocol";

import { CreateDialog } from "../../src/components/project-work/CreateDialog.js";
import { DeleteDialog } from "../../src/components/project-work/ConfirmDialogs.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { openWorkCreate, resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";

import { fakeHost, item, type FakeProject } from "./fixture.js";

vi.mock("../../src/components/project-work/MarkdownSourceEditor.js", () => ({
  MarkdownSourceEditor: forwardRef(function MockMarkdownSourceEditor(
    props: { value: string; onChange(value: string): void; label: string; placeholder?: string; onCreateShortcut?(): void },
    ref,
  ) {
    const field = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({ focus: () => field.current?.focus(), measure: () => {} }), []);
    return (
      <textarea
        ref={field}
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          props.onCreateShortcut?.();
        }}
      />
    );
  }),
}));

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast: () => {} } }),
    useLaserState: () => undefined,
    useCapability: () => ({ state: "available" }),
  };
});

let root: Root;
let container: HTMLDivElement;

const world = (): FakeProject => ({
  projectId: "p1",
  paths: ["/work/app"],
  seq: 3,
  items: [item({ entityId: "e1", kind: "spec", number: 4 }), item({ entityId: "e2", kind: "task", number: 9 })],
  events: [],
});

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => node.textContent?.includes(label));
const createForm = (kind: ProjectWorkKind): HTMLFormElement => document.querySelector<HTMLInputElement>(`#${kind}-create-title`)!.closest("form")!;
const formButton = (form: HTMLFormElement, label: string): HTMLButtonElement | undefined =>
  [...form.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(label));

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
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
  resetWorkspaceUi();
});

const setInput = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

async function store(): Promise<ProjectWorkStore> {
  const host = fakeHost([world()]);
  const created = new ProjectWorkStore({ request: host.request, projectId: "p1" });
  await created.open();
  return created;
}

describe("+ Create", () => {
  it("shows the key this project hands out next, before anything is created", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("spec"));

    // SPEC-4 exists, so the next one is SPEC-5 — and the copy says the number
    // is assigned when it is created, because only the host mints it.
    expect(text()).toContain("SPEC-5");
    expect(text()).toContain("assigned when it is created");

    // Switching kind switches the key, with no request in between.
    await act(async () => button("Plan")?.click());
    expect(text()).toContain("PLAN-1");
  });

  it("will not create anything without a title and the one field that kind is about", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("research"));
    expect(text()).toContain("Question tree");
    expect(text()).toContain("Research boundary");
    expect(button("Create research")?.disabled).toBe(true);
  });

  it("shows distinct structure immediately and keeps each kind's exact draft while switching", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("spec"));

    const specForm = document.querySelector<HTMLFormElement>("#spec-create-title")?.closest("form");
    expect(specForm?.textContent).toContain("Requirements and acceptance");
    await setInput(specForm!.querySelector<HTMLInputElement>("#spec-create-title")!, "Spec title");
    await setInput(specForm!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!, "  **spec bytes**  ");

    await act(async () => button("Plan")?.click());
    const planForm = document.querySelector<HTMLFormElement>("#plan-create-title")?.closest("form");
    expect(planForm?.textContent).toContain("Dependency graph");
    await setInput(planForm!.querySelector<HTMLInputElement>("#plan-create-title")!, "Plan title");
    await setInput(planForm!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!, "Plan bytes");

    await act(async () => button("Spec")?.click());
    expect((document.querySelector<HTMLInputElement>("#spec-create-title")?.value)).toBe("Spec title");
    expect(specForm!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')?.value).toBe("  **spec bytes**  ");
  });

  it("preserves every kind's title, prose, row, and Preview mode across switches", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("spec"));

    const rows: Record<ProjectWorkKind, { add: string; input: string; value: string }> = {
      spec: { add: "Add outcome", input: 'input[aria-label="Outcome 1"]', value: "Spec outcome" },
      research: { add: "Add in scope", input: 'input[aria-label="In scope 1"]', value: "Research scope" },
      design: { add: "Add principle", input: 'input[aria-label="Principle 1"]', value: "Design principle" },
      plan: { add: "Add phase", input: 'input[aria-label="Phase 1 name"]', value: "Plan phase" },
      task: { add: "Add affected area", input: 'input[aria-label="Affected area 1"]', value: "Task path" },
    };

    for (const kind of ["spec", "research", "design", "plan", "task"] as const) {
      await act(async () => button(kind === "task" ? "Task" : `${kind[0]!.toUpperCase()}${kind.slice(1)}`)?.click());
      const form = createForm(kind);
      await setInput(form.querySelector<HTMLInputElement>(`#${kind}-create-title`)!, `${kind} title`);
      await setInput(form.querySelector<HTMLTextAreaElement>("textarea")!, `${kind} prose`);
      await act(async () => formButton(form, rows[kind].add)?.click());
      await setInput(form.querySelector<HTMLInputElement>(rows[kind].input)!, rows[kind].value);
      await act(async () => formButton(form, "Preview")?.click());
    }

    for (const kind of ["spec", "research", "design", "plan", "task"] as const) {
      await act(async () => button(kind === "task" ? "Task" : `${kind[0]!.toUpperCase()}${kind.slice(1)}`)?.click());
      const form = createForm(kind);
      expect(form.querySelector<HTMLInputElement>(`#${kind}-create-title`)?.value).toBe(`${kind} title`);
      expect(form.textContent).toContain(`${kind} prose`);
      expect(form.querySelector<HTMLInputElement>(rows[kind].input)?.value).toBe(rows[kind].value);
      expect(formButton(form, "Preview")?.getAttribute("aria-selected")).toBe("true");
    }
  });

  it("focuses an empty primary editor after Ctrl/Cmd+Enter, including when that editor is inactive", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("spec"));
    const form = createForm("spec");
    const title = form.querySelector<HTMLInputElement>("#spec-create-title")!;
    const primary = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!;
    await setInput(title, "Needs a brief");
    title.focus();
    await act(async () => primary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(primary);
    expect(text()).toContain("Write the brief.");

    await act(async () => formButton(form, "Add requirement")?.click());
    const editRequirement = [...form.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Edit source") && candidate.closest("section")?.textContent?.includes("Requirement 1"),
    );
    await act(async () => editRequirement?.click());
    const requirement = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Requirement 1"]')!;
    expect(form.querySelector('textarea[aria-label="Brief"]')).toBeNull();
    requirement.focus();
    await act(async () => requirement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(form.querySelector('textarea[aria-label="Brief"]'));
    expect(form.querySelector('textarea[aria-label="Requirement 1"]')).toBeNull();
  });

  it("names incomplete Plan rows, focuses their region, and retains what was entered", async () => {
    const work = await store();
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("plan"));
    const form = createForm("plan");
    await setInput(form.querySelector<HTMLInputElement>("#plan-create-title")!, "A plan");
    const primary = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!;
    await setInput(primary, "Plan it");
    await act(async () => formButton(form, "Add phase")?.click());
    const selectedTask = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => selectedTask.click());
    primary.focus();
    await act(async () => primary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    expect(text()).toContain("Name every phase that has selected Tasks or a summary.");
    expect(text()).not.toContain("String must contain");
    expect(document.activeElement).toBe(document.querySelector("#plan-create-details"));
    expect(selectedTask.checked).toBe(true);
    expect(form.querySelector<HTMLInputElement>("#plan-create-title")?.value).toBe("A plan");
    expect(primary.value).toBe("Plan it");
  });

  it("selects the new entity and clears all drafts after success", async () => {
    const work = await store();
    vi.spyOn(work, "create").mockResolvedValue({
      ok: true,
      value: {
        entity: { entityId: "new-task", kind: "task", key: "TASK-10" },
        revision: { revisionId: "r1" },
        ref: {},
        seq: 4,
      } as never,
    });
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("spec"));
    await setInput(createForm("spec").querySelector<HTMLInputElement>("#spec-create-title")!, "Unsaved other draft");
    await setInput(createForm("spec").querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!, "Other prose");
    await act(async () => button("Task")?.click());
    const form = createForm("task");
    await setInput(form.querySelector<HTMLInputElement>("#task-create-title")!, "Created task");
    await setInput(form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Outcome"]')!, "Created outcome");
    await act(async () => button("Create task")?.click());

    expect(workspaceUi()).toMatchObject({ creating: undefined, tab: "work", selection: { entityId: "new-task", kind: "task" } });
    await act(async () => openWorkCreate("task"));
    expect(createForm("task").querySelector<HTMLInputElement>("#task-create-title")?.value).toBe("");
    expect(createForm("task").querySelector<HTMLTextAreaElement>('textarea[aria-label="Outcome"]')?.value).toBe("");
    await act(async () => button("Spec")?.click());
    expect(createForm("spec").querySelector<HTMLInputElement>("#spec-create-title")?.value).toBe("");
    expect(createForm("spec").querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')?.value).toBe("");
  });

  it("previews without writing, blocks Enter/composition, and fences duplicate pending creates", async () => {
    const work = await store();
    let settleCreate: ((value: Awaited<ReturnType<ProjectWorkStore["create"]>>) => void) | undefined;
    const creating = new Promise<Awaited<ReturnType<ProjectWorkStore["create"]>>>((resolve) => { settleCreate = resolve; });
    const createSpy = vi.spyOn(work, "create").mockImplementation(() => creating);

    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("task"));
    const form = document.querySelector<HTMLFormElement>("#task-create-title")?.closest("form");
    const title = form!.querySelector<HTMLInputElement>("#task-create-title")!;
    const outcome = form!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Outcome"]')!;
    await setInput(title, "Typed task");
    const exactOutcome = "  **exact outcome**\n<script id=\"draft-script\">bad()</script>  ";
    await setInput(outcome, exactOutcome);
    outcome.setSelectionRange(4, 9);
    await act(async () => button("Add affected area")?.click());
    const affected = form!.querySelector<HTMLInputElement>('input[aria-label="Affected area 1"]')!;
    await setInput(affected, "packages/ui");

    const writeTab = form!.querySelector<HTMLButtonElement>('button[role="tab"][aria-controls$="write"]')!;
    await act(async () => writeTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(createSpy).not.toHaveBeenCalled();
    expect(form?.textContent).toContain("exact outcome");
    expect(form?.querySelector("#draft-script")).toBeNull();

    const previewTab = form!.querySelector<HTMLButtonElement>('button[role="tab"][aria-controls$="preview"]')!;
    await act(async () => previewTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect([outcome.selectionStart, outcome.selectionEnd]).toEqual([4, 9]);
    await act(async () => {
      outcome.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(createSpy).not.toHaveBeenCalled();

    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(createSpy).not.toHaveBeenCalled();

    await act(async () => button("Create task")?.click());
    await act(async () => button("Create task")?.click());
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      body: { kind: "task", task: { outcome: exactOutcome, scope: { paths: ["packages/ui"] } } },
    });

    expect(outcome.closest("fieldset")?.disabled).toBe(true);
    expect(affected.closest("fieldset")?.disabled).toBe(true);
    expect(button("Add affected area")?.closest("fieldset")?.disabled).toBe(true);
    await setInput(outcome, "changed while pending");
    await setInput(affected, "changed/while-pending");
    await act(async () => button("Add non-goal")?.click());
    expect(outcome.value).toBe(exactOutcome);
    expect(affected.value).toBe("packages/ui");
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      body: { kind: "task", task: { outcome: exactOutcome, scope: { paths: ["packages/ui"] } } },
    });

    await act(async () => settleCreate?.({ ok: false, failure: { kind: "refused", message: "Try again." } }));
    expect(text()).toContain("Try again.");
    expect(outcome.value).toBe(exactOutcome);
    expect(outcome.closest("fieldset")?.disabled).toBe(false);
    expect(affected.closest("fieldset")?.disabled).toBe(false);
    await setInput(outcome, "editable after failure");
    expect(outcome.value).toBe("editable after failure");
  });

  it("ignores a successful response after the dialog scope closes", async () => {
    const work = await store();
    let finish: ((value: Awaited<ReturnType<ProjectWorkStore["create"]>>) => void) | undefined;
    vi.spyOn(work, "create").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(<CreateDialog store={work} />));
    await act(async () => openWorkCreate("design"));
    const form = document.querySelector<HTMLFormElement>("#design-create-title")?.closest("form");
    await setInput(form!.querySelector<HTMLInputElement>("#design-create-title")!, "Design it");
    await setInput(form!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Brief"]')!, "A real brief");
    await act(async () => button("Create design")?.click());

    await act(async () => openWorkCreate(undefined));
    await act(async () => finish?.({
      ok: true,
      value: {
        entity: { entityId: "late", kind: "design", key: "DES-2" },
        revision: { revisionId: "r1" },
        ref: {},
        seq: 4,
      } as never,
    }));

    expect(workspaceUi().creating).toBeUndefined();
    expect(workspaceUi().selection).toBeUndefined();
  });
});

describe("Delete", () => {
  const detail = {
    ref: { projectId: "p1", kind: "spec", entityId: "e1", revisionId: "r1", digest: "a".repeat(64), label: "A spec", key: "SPEC-4" },
    entity: {
      projectId: "p1",
      entityId: "e1",
      kind: "spec",
      key: "SPEC-4",
      keyNumber: 4,
      title: "A spec",
      state: "draft",
      currentRevisionId: "r1",
      currentDigest: "a".repeat(64),
      revisionCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  } as unknown as ClientRequests["project/work/get"]["result"];

  it("asks for the key to be typed, and Enter never confirms it", async () => {
    const work = await store();
    const deletes: unknown[] = [];
    vi.spyOn(work, "remove").mockImplementation(async (_entity, options) => {
      deletes.push(options);
      return { ok: true, value: { deleted: options?.confirm === true, orphans: [], seq: 4 } };
    });

    await act(async () => root.render(<DeleteDialog store={work} detail={detail} open onOpenChange={() => {}} />));
    await act(async () => {});

    // The preview came from the host, and it wrote nothing.
    expect(deletes).toEqual([undefined]);
    expect(text()).toContain("Type");
    expect(text()).toContain("SPEC-4");

    const confirm = button("Delete SPEC-4");
    expect(confirm?.disabled).toBe(true);

    const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Type SPEC-4 to confirm deletion"]');
    expect(field).not.toBeNull();
    // Focus is on the cancelling control, never on the one that acts.
    expect(document.activeElement?.textContent).toContain("Cancel");

    // Enter in the field does nothing at all.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      field!.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(deletes).toEqual([undefined]);

    // The exact key, typed, is the only thing that enables it.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, "SPEC-4");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Delete SPEC-4")?.disabled).toBe(false);
    await act(async () => button("Delete SPEC-4")?.click());
    expect(deletes).toEqual([undefined, { confirm: true }]);
  });
});
