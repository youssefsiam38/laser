// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type ProjectWorkBody, type ProjectWorkKind, type SpecBody } from "@lasercode/protocol";

let reviseCapability = true;
vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast: () => {} } }),
    useCapability: (method: string) => ({ state: method === "project/work/revise" && !reviseCapability ? "explained" : "available", explanation: "Writing was revoked." }),
    useLaserState: (selector: (state: unknown) => unknown) => selector({ agents: { snapshot: { agents: [] } }, sessions: [] }),
  };
});
vi.mock("../../src/components/design/use-design-access.js", () => ({
  useDesignAccess: () => ({ access: { state: { kind: "absent", detail: "No index yet." } } }),
}));

import { WorkDetail } from "../../src/components/project-work/WorkDetail.js";
import { useWorkEditSession } from "../../src/components/project-work/edit-session.js";
import type { WorkBodyContext } from "../../src/components/project-work/bodies/context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi, selectWork } from "../../src/project-work/workspace-state.js";
import { designFixture } from "../design/fixture.js";
import { detail as detailAnswer, planBody, taskBody } from "./plan-task-fixture.js";
import { researchFixture, specFixture } from "./bodies-fixture.js";

interface Variant {
  kind: ProjectWorkKind;
  body: ProjectWorkBody;
  edit: string;
  field: string;
  save: string;
  draft: string;
  serverBody: ProjectWorkBody;
}

const variants: Variant[] = [
  { kind: "spec", body: { kind: "spec", spec: specFixture() }, edit: "Edit", field: "Brief", save: "Save as a new revision", draft: "My **spec** draft.", serverBody: { kind: "spec", spec: specFixture({ brief: "Server spec." }) } },
  { kind: "research", body: { kind: "research", research: researchFixture() }, edit: "Edit framing", field: "Question", save: "Save as a new revision", draft: "My **research** draft?", serverBody: { kind: "research", research: researchFixture({ question: "Server research?", questions: [{ id: "q1", text: "Server research?", state: "open", findings: [] }] }) } },
  { kind: "design", body: { kind: "design", design: designFixture() }, edit: "Edit brief", field: "Brief", save: "Save revision", draft: "My **design** draft.", serverBody: { kind: "design", design: { ...designFixture(), brief: "Server design." } } },
  { kind: "plan", body: { kind: "plan", plan: planBody({ phases: [{ id: "p1", name: "One", taskKeys: [] }] }) }, edit: "Edit plan", field: "Brief", save: "Save as a new revision", draft: "My **plan** draft.", serverBody: { kind: "plan", plan: planBody({ brief: "Server plan.", phases: [{ id: "p1", name: "One", taskKeys: [] }] }) } },
  { kind: "task", body: { kind: "task", task: taskBody() }, edit: "Edit task", field: "Outcome", save: "Save as a new revision", draft: "My **task** draft.", serverBody: { kind: "task", task: taskBody({ outcome: "Server task." }) } },
];

let root: Root;
let container: HTMLDivElement;

const settle = async (ms = 0): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};
const button = (label: string): HTMLButtonElement | undefined => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(label));
const click = async (node: HTMLElement | undefined): Promise<void> => {
  expect(node).toBeDefined();
  await act(async () => { node!.click(); });
};
const editCode = async (label: string, value: string): Promise<void> => {
  let content: HTMLElement | null = null;
  for (let attempt = 0; attempt < 40 && !content; attempt += 1) {
    await settle(25);
    content = document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  }
  expect(content).not.toBeNull();
  const view = EditorView.findFromDOM(content!);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
};

function answer(kind: ProjectWorkKind, body: ProjectWorkBody, revisionId = "r1", title = `${kind} title`) {
  const value = detailAnswer({ entityId: "e1", kind, number: 1, title, body });
  value.ref.revisionId = revisionId;
  value.revision.revisionId = revisionId;
  value.revision.index = revisionId === "r1" ? 1 : 2;
  value.entity.currentRevisionId = revisionId;
  value.entity.revisionCount = revisionId === "r1" ? 1 : 2;
  value.fence.revisionId = revisionId;
  return value;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reviseCapability = true;
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

describe.each(variants)("$kind edit lifetime", (variant) => {
  it("keeps the draft and original fence through a same-current-view refresh and refusal", async () => {
    let current = answer(variant.kind, variant.body);
    const revise: Array<Record<string, unknown>> = [];
    const store = new ProjectWorkStore({
      projectId: "p1",
      request: (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
        if (method === "project/work/get") return current;
        if (method === "project/work/revise") {
          revise.push(params);
          throw Object.assign(new Error("A newer revision already exists."), { code: ErrorCodes.ProjectWorkConflict, data: { current: current.ref } });
        }
        throw new Error(method);
      }) as never,
    });
    selectWork({ entityId: "e1", kind: variant.kind });
    const render = async (seq: number) => {
      await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq }} /></TooltipProvider>));
      await settle(20);
    };

    await render(1);
    await click(button(variant.edit));
    await editCode(variant.field, variant.draft);

    current = answer(variant.kind, variant.serverBody, "r2", `${variant.kind} server title`);
    await render(2);

    const content = document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${variant.field}"]`);
    expect(content).not.toBeNull();
    expect(EditorView.findFromDOM(content!).state.doc.toString()).toBe(variant.draft);
    expect(document.body.textContent).toContain("newer revision");

    await click(button(variant.save));
    await settle(10);
    expect(revise).toHaveLength(1);
    expect(revise[0]?.expectedRevisionId).toBe("r1");
    expect(document.body.textContent?.toLocaleLowerCase()).toContain("still here");
    expect(EditorView.findFromDOM(document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${variant.field}"]`)!).state.doc.toString()).toBe(variant.draft);
  });
});

it("keeps a dirty editor mounted beside a same-entity refresh error", async () => {
  const first = answer("spec", { kind: "spec", spec: specFixture() }, "r1", "First spec");
  let failRefresh = false;
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod) => {
      if (method === "project/work/get") {
        if (failRefresh) throw new Error("Refresh failed while offline.");
        return first;
      }
      throw new Error(method);
    }) as never,
  });
  selectWork({ entityId: "e1", kind: "spec" });
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  await settle(20);
  await click(button("Edit"));
  await editCode("Brief", "Unsaved **offline** draft.");
  failRefresh = true;
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 2 }} /></TooltipProvider>));
  await settle(20);
  expect(document.body.querySelector('[data-slot="spec-editor"]')).not.toBeNull();
  expect(document.body.textContent).toContain("Refresh failed while offline.");
  expect(EditorView.findFromDOM(document.body.querySelector<HTMLElement>('.cm-content[aria-label="Brief"]')!).state.doc.toString()).toBe("Unsaved **offline** draft.");
});

it("ignores out-of-order detail success and failure settlements from an earlier selection", async () => {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
      if (method !== "project/work/get") throw new Error(method);
      return await new Promise((resolve, reject) => pending.set(String(params.entityId), { resolve, reject }));
    }) as never,
  });
  selectWork({ entityId: "e1", kind: "spec" });
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  await settle();
  await act(async () => selectWork({ entityId: "e2", kind: "spec" }));
  await settle();
  await act(async () => pending.get("e2")!.resolve({ ...answer("spec", { kind: "spec", spec: specFixture({ brief: "Second body." }) }, "r2", "Second spec"), ref: { ...answer("spec", { kind: "spec", spec: specFixture() }).ref, entityId: "e2" }, entity: { ...answer("spec", { kind: "spec", spec: specFixture() }).entity, entityId: "e2", title: "Second spec" } }));
  await settle();
  expect(document.body.textContent).toContain("Second spec");
  await act(async () => pending.get("e1")!.reject(new Error("Old read failed.")));
  await settle();
  expect(document.body.textContent).toContain("Second spec");
  expect(document.body.textContent).not.toContain("Old read failed.");
});

it("invalidates an edit on historical navigation and on a different store/project owner", async () => {
  const current = answer("spec", { kind: "spec", spec: specFixture() }, "r1", "Current spec");
  const historical = answer("spec", { kind: "spec", spec: specFixture({ brief: "Historical body." }) }, "r0", "Historical spec");
  const firstStore = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
      if (method === "project/work/get") return params.revisionId === "r0" ? historical : current;
      throw new Error(method);
    }) as never,
  });
  selectWork({ entityId: "e1", kind: "spec" });
  await act(async () => root.render(<TooltipProvider><WorkDetail store={firstStore} work={{ ...firstStore.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  await settle(20);
  await click(button("Edit"));
  await editCode("Brief", "Owner-specific draft.");

  await act(async () => selectWork({ entityId: "e1", kind: "spec", revisionId: "r0" }));
  await settle(20);
  expect(document.body.textContent).toContain("Historical spec");
  expect(document.body.querySelector('[data-slot="spec-editor"]')).toBeNull();

  const other = answer("spec", { kind: "spec", spec: specFixture({ brief: "Other project body." }) }, "r5", "Other project spec");
  other.ref.projectId = "p2";
  const secondStore = new ProjectWorkStore({
    projectId: "p2",
    request: (async (method: ProjectWorkMethod) => {
      if (method === "project/work/get") return other;
      throw new Error(method);
    }) as never,
  });
  await act(async () => selectWork({ entityId: "e1", kind: "spec" }));
  await act(async () => root.render(<TooltipProvider><WorkDetail store={secondStore} work={{ ...secondStore.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  await settle(20);
  expect(document.body.textContent).toContain("Other project spec");
  expect(document.body.textContent).not.toContain("Owner-specific draft");
});

it("admits one frozen save and ignores its completion after selection ownership moves", async () => {
  const first = answer("spec", { kind: "spec", spec: specFixture() }, "r1", "First spec");
  const second = answer("spec", { kind: "spec", spec: specFixture({ brief: "Second body." }) }, "r9", "Second spec");
  let resolveRevise!: (value: unknown) => void;
  const deferred = new Promise((resolve) => { resolveRevise = resolve; });
  const revise: Array<Record<string, unknown>> = [];
  const gets: string[] = [];
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
      if (method === "project/work/get") {
        gets.push(String(params.entityId));
        return params.entityId === "e2" ? { ...second, ref: { ...second.ref, entityId: "e2" }, entity: { ...second.entity, entityId: "e2" }, revision: { ...second.revision, entityId: "e2" }, fence: { ...second.fence, entityId: "e2" } } : first;
      }
      if (method === "project/work/revise") {
        revise.push(params);
        return deferred;
      }
      throw new Error(method);
    }) as never,
  });
  selectWork({ entityId: "e1", kind: "spec" });
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  await settle(20);
  await click(button("Edit"));
  await editCode("Brief", "Pending **draft**.");

  reviseCapability = false;
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  expect(document.body.querySelector<HTMLElement>('.cm-content[aria-label="Brief"]')?.getAttribute("contenteditable")).toBe("false");
  expect(button("Save as a new revision")?.disabled).toBe(true);

  reviseCapability = true;
  await act(async () => root.render(<TooltipProvider><WorkDetail store={store} work={{ ...store.getSnapshot(), seq: 1 }} /></TooltipProvider>));
  const save = button("Save as a new revision")!;
  await act(async () => { save.click(); save.click(); });
  await settle();
  expect(revise).toHaveLength(1);
  expect(document.body.querySelector<HTMLElement>('.cm-content[aria-label="Brief"]')?.getAttribute("contenteditable")).toBe("false");
  expect(document.body.querySelector<HTMLInputElement>("#spec-title")?.closest("fieldset")?.disabled).toBe(true);

  await act(async () => selectWork({ entityId: "e2", kind: "spec" }));
  await settle(20);
  expect(document.body.textContent).toContain("Second spec");
  resolveRevise({ ref: first.ref, entity: first.entity, revision: { ...first.revision, index: 2 }, seq: 3 });
  await settle(20);
  expect(document.body.textContent).toContain("Second spec");
  expect(document.body.textContent).not.toContain("First spec");
  expect(gets.at(-1)).toBe("e2");
});

type EditSession = ReturnType<typeof useWorkEditSession<SpecBody>>;
let editSession!: EditSession;

function EditSessionHarness({ context }: { context: WorkBodyContext }) {
  editSession = useWorkEditSession<SpecBody>(context);
  return <p data-slot="edit-session-state">{editSession.pending ? "pending" : "idle"}</p>;
}

function ownedContext(entityId: string, store: ProjectWorkStore): WorkBodyContext {
  const value = answer("spec", { kind: "spec", spec: specFixture() }, `r-${entityId}`, `${entityId} spec`);
  value.ref.entityId = entityId;
  value.entity.entityId = entityId;
  value.revision.entityId = entityId;
  value.fence.entityId = entityId;
  return { store, detail: value, editable: true, onChanged: () => {}, items: [] };
}

function deferredValue<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settlePromise) => { resolve = settlePromise; });
  return { promise, resolve };
}

it("does not let owner A's late settlement clear owner B's pending submit lock", async () => {
  const store = new ProjectWorkStore({ projectId: "p1", request: (async () => { throw new Error("not called"); }) as never });
  const contextA = ownedContext("a", store);
  const contextB = ownedContext("b", store);
  const pendingA = deferredValue<string>();
  const pendingB = deferredValue<string>();

  await act(async () => root.render(<EditSessionHarness context={contextA} />));
  await act(async () => { editSession.begin(specFixture()); });
  let submitA!: Promise<unknown>;
  await act(async () => { submitA = editSession.submit(() => pendingA.promise); await Promise.resolve(); });
  await settle();
  expect(editSession.pending).toBe(true);

  await act(async () => root.render(<EditSessionHarness context={contextB} />));
  await act(async () => { editSession.begin(specFixture({ brief: "Owner B" })); });
  let submitB!: Promise<unknown>;
  await act(async () => { submitB = editSession.submit(() => pendingB.promise); await Promise.resolve(); });
  await settle();
  expect(editSession.pending).toBe(true);

  await act(async () => { pendingA.resolve("A finished"); await submitA; });
  let duplicateRuns = 0;
  let duplicate: unknown;
  let cancelled = true;
  await act(async () => {
    duplicate = await editSession.submit(async () => { duplicateRuns += 1; return "duplicate"; });
    cancelled = editSession.cancel();
  });

  await act(async () => { pendingB.resolve("B finished"); await submitB; });
  expect(duplicate).toEqual({ kind: "blocked" });
  expect(duplicateRuns).toBe(0);
  expect(cancelled).toBe(false);
});

it("keeps a new mount's pending lock isolated from an unmounted owner's completion", async () => {
  const store = new ProjectWorkStore({ projectId: "p1", request: (async () => { throw new Error("not called"); }) as never });
  const contextA = ownedContext("a", store);
  const contextB = ownedContext("b", store);
  const pendingA = deferredValue<string>();
  const pendingB = deferredValue<string>();

  await act(async () => root.render(<EditSessionHarness key="mount-a" context={contextA} />));
  await act(async () => { editSession.begin(specFixture()); });
  let submitA!: Promise<unknown>;
  await act(async () => { submitA = editSession.submit(() => pendingA.promise); await Promise.resolve(); });
  await settle();

  await act(async () => root.render(<EditSessionHarness key="mount-b" context={contextB} />));
  await act(async () => { editSession.begin(specFixture({ brief: "New mount" })); });
  let submitB!: Promise<unknown>;
  await act(async () => { submitB = editSession.submit(() => pendingB.promise); await Promise.resolve(); });
  await settle();

  await act(async () => { pendingA.resolve("old mount finished"); await submitA; });
  let duplicateRuns = 0;
  let duplicate: unknown;
  let cancelled = true;
  await act(async () => {
    duplicate = await editSession.submit(async () => { duplicateRuns += 1; return "duplicate"; });
    cancelled = editSession.cancel();
  });

  await act(async () => { pendingB.resolve("new mount finished"); await submitB; });
  expect(duplicate).toEqual({ kind: "blocked" });
  expect(duplicateRuns).toBe(0);
  expect(cancelled).toBe(false);
});
