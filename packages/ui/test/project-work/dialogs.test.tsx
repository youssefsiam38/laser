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
import type { ClientRequests } from "@lasercode/protocol";

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
    return <textarea ref={field} aria-label={props.label} value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} />;
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
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ body: { kind: "task", task: { outcome: exactOutcome } } });

    await act(async () => settleCreate?.({ ok: false, failure: { kind: "refused", message: "Try again." } }));
    expect(text()).toContain("Try again.");
    expect(outcome.value).toBe(exactOutcome);
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
