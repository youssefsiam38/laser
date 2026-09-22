// @vitest-environment happy-dom
/**
 * The Spec: edit → revise, and what happens when somebody else got there first
 * (M21-T7, D-355 "Detail, by kind").
 *
 * The three promises worth proving, and none of them provable by looking:
 *
 * 1. Saving writes a **child revision** fenced by the revision that was read.
 * 2. A refused write shows the difference and offers "keep mine as a new
 *    revision" — nothing is ever written over bytes nobody saw.
 * 3. On an older revision the editor is not offered at all, and the way back
 *    to the current one is on screen.
 *
 * (AGENTS.md, D-342: a unit test over the real components. Nothing here is a
 * browser acceptance run.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type ClientRequests } from "@lasercode/protocol";

import { SpecDocument } from "../../src/components/project-work/bodies/SpecDocument.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";

import { bodyPage, detailFixture, specFixture } from "./bodies-fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => node.textContent?.includes(label));
const query = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);

const editCode = async (label: string, value: string): Promise<EditorView> => {
  let content: HTMLElement | null = null;
  for (let attempt = 0; attempt < 40 && !content; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    content = document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  }
  expect(content).not.toBeNull();
  const view = EditorView.findFromDOM(content!);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
  return view;
};

const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const changeInput = async (selector: string, value: string): Promise<void> => {
  const field = query<HTMLInputElement>(selector);
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

interface Host {
  calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
  /** Refuse the next revise as a conflict, as the host does on a stale fence. */
  conflictOnce: boolean;
  /** What the host says is current now. */
  currentRevisionId: string;
}

function makeStore(host: Host): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    host.calls.push({ method, params });
    if (method === "project/work/list") {
      return { projectId: "p1", seq: 7, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
    }
    if (method === "project/work/get") {
      // The revision that landed while the person was writing.
      return detailFixture({
        kind: "spec",
        number: 4,
        revisionId: host.currentRevisionId,
        currentRevisionId: host.currentRevisionId,
        index: 2,
        revisionCount: 2,
        body: bodyPage({ kind: "spec", spec: specFixture({ brief: "Somebody else rewrote the brief." }) }),
      });
    }
    if (method === "project/work/revise") {
      if (host.conflictOnce) {
        host.conflictOnce = false;
        throw Object.assign(new Error("This was revised while you had it open."), {
          code: ErrorCodes.ProjectWorkConflict,
          data: { conflict: "revision", current: { projectId: "p1", kind: "spec", entityId: "e1", revisionId: host.currentRevisionId, digest: "b".repeat(64), label: "SPEC-4", key: "SPEC-4" } },
        });
      }
      return {
        ref: { projectId: "p1", kind: "spec", entityId: "e1", revisionId: "r3", digest: "c".repeat(64), label: "SPEC-4", key: "SPEC-4" },
        entity: {},
        revision: { index: 3, revisionId: "r3" },
        seq: 9,
      };
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

const detail = (over: Parameters<typeof detailFixture>[0] extends infer T ? Partial<T> : never = {}) =>
  detailFixture({
    kind: "spec",
    number: 4,
    revisionId: "r1",
    currentRevisionId: "r1",
    body: bodyPage({ kind: "spec", spec: specFixture() }),
    ...over,
  } as Parameters<typeof detailFixture>[0]);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  await act(async () => {});
}

describe("editing a spec", () => {
  it("names what a sparse Full spec still needs and keeps Edit as the next action", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    const sparse = specFixture({ form: "full", problem: undefined, outcomes: [], requirements: [], acceptance: [] });
    await mount(<SpecDocument body={sparse} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    expect(text()).toContain("Still missing");
    expect(text()).toContain("problem");
    expect(text()).toContain("acceptance criteria");
    expect(query('[data-slot="spec-edit"]')).not.toBeNull();
  });

  it("renders authored prose as safe Markdown before editing", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    await mount(<SpecDocument body={specFixture({ brief: "A **safe** relay <script>bad()</script>." })} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    expect(query("[data-slot='markdown-document'] strong")?.textContent).toBe("safe");
    expect(query("script")).toBeNull();
  });

  it.each([
    ["brief", specFixture({ brief: "b".repeat(4_001) }), "Brief must be 4000 characters or fewer."],
    ["problem", specFixture({ form: "full", problem: "p".repeat(4_001) }), "Problem must be 4000 characters or fewer."],
    ["document", specFixture({ document: "d".repeat(200_001) }), "Document must be 200000 characters or fewer."],
  ])("locates overlong %s prose before asking the host", async (_name, source, message) => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    await mount(<SpecDocument body={source} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    await click(query('[data-slot="spec-edit"]'));
    await changeInput("#spec-title", "Changed title");
    await click(button("Save as a new revision"));
    expect(host.calls.some((call) => call.method === "project/work/revise")).toBe(false);
    expect(text()).toContain(message);
  });

  it("writes a child revision fenced by the revision that was read", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    const changed = vi.fn();
    await mount(<SpecDocument body={specFixture()} context={{ store, detail: detail(), editable: true, onChanged: changed, items: [] }} />);

    // The reading form first, with the form this revision is in.
    expect(text()).toContain("Full spec");
    await click(query('[data-slot="spec-edit"]'));

    // The whole of a brief is its brief; the full form carries the rest.
    await editCode("Brief", "  One relay, and nothing readable passes it.  \n");
    await click(button("Save as a new revision"));

    const revise = host.calls.find((call) => call.method === "project/work/revise");
    expect(revise).toBeDefined();
    expect(revise?.params.expectedRevisionId).toBe("r1");
    expect(revise?.params.idempotencyKey).toEqual(expect.any(String));
    const body = revise?.params.body as { kind: string; spec: { brief: string; form: string } };
    expect(body.kind).toBe("spec");
    expect(body.spec.brief).toBe("  One relay, and nothing readable passes it.  \n");
    expect(body.spec.form).toBe("full");
    expect(changed).toHaveBeenCalled();
  });

  it("previews without writing and Cancel restores the saved revision", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    const source = specFixture();
    await mount(<SpecDocument body={source} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    await click(query('[data-slot="spec-edit"]'));
    await editCode("Brief", "A **different** brief.");
    await click(button("Preview"));
    expect(query("[data-slot='markdown-document'] strong")?.textContent).toBe("different");
    expect(host.calls.some((call) => call.method === "project/work/revise")).toBe(false);
    await click(button("Cancel"));
    expect(text()).toContain(source.brief);
    expect(text()).not.toContain("A different brief.");
  });

  it("switches a brief to a full spec and says what a full spec records", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r1" };
    const store = makeStore(host);
    await store.open();
    const brief = specFixture({ form: "brief", problem: undefined, outcomes: [], requirements: [], acceptance: [], document: undefined });
    await mount(<SpecDocument body={brief} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    await click(query('[data-slot="spec-edit"]'));

    // A brief is deliberately small: nothing beyond the brief is even asked.
    expect(text()).toContain("Deliberately small");
    expect(text()).not.toContain("A full spec usually records");

    const forms = [...document.body.querySelectorAll('[role="radio"]')] as HTMLElement[];
    const full = forms.find((node) => node.textContent === "Full spec");
    await click(full);
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("A full spec usually records");
    expect(text()).toContain("acceptance criteria");
  });

  it("offers the difference and keeps mine as a new revision when it refuses", async () => {
    const host: Host = { calls: [], conflictOnce: true, currentRevisionId: "r2" };
    const store = makeStore(host);
    await store.open();
    await mount(<SpecDocument body={specFixture()} context={{ store, detail: detail(), editable: true, onChanged: () => {}, items: [] }} />);
    await click(query('[data-slot="spec-edit"]'));
    const brief = await editCode("Brief", "Mine, written while somebody else was writing theirs.");
    await click(button("Save as a new revision"));

    // Refused, not overwritten — and the person's words are still on screen.
    const banner = query('[data-slot="revision-conflict"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(brief.state.doc.toString()).toBe("Mine, written while somebody else was writing theirs.");

    await click(button("View the difference"));
    expect(text()).toContain("What changed");
    // The diff is between the two real revisions: theirs on the left.
    expect(text()).toContain("Somebody else rewrote the brief.");
    await click(document.body.querySelector('[data-slot="dialog-content"] [aria-label="Close"]'));

    await click(button("Keep mine as a new revision"));
    const revisions = host.calls.filter((call) => call.method === "project/work/revise");
    expect(revisions).toHaveLength(2);
    // The second write is fenced by what the host said is current, so it is a
    // child of their revision rather than a replacement of it.
    expect(revisions[0]?.params.expectedRevisionId).toBe("r1");
    expect(revisions[1]?.params.expectedRevisionId).toBe("r2");
    expect(revisions[1]?.params.note).toContain("kept over a newer revision");
  });

  it("does not offer editing on an older revision, and says why", async () => {
    const host: Host = { calls: [], conflictOnce: false, currentRevisionId: "r2" };
    const store = makeStore(host);
    await store.open();
    await mount(
      <SpecDocument
        body={specFixture()}
        context={{
          store,
          detail: detail({ revisionId: "r1", currentRevisionId: "r2", index: 1, revisionCount: 2 }),
          editable: false,
          readOnlyReason: "Editing is disabled on an older revision.",
          onChanged: () => {},
          items: [],
        }}
      />,
    );
    const edit = query<HTMLButtonElement>('[data-slot="spec-edit"]');
    expect(edit?.disabled).toBe(true);
    expect(text()).toContain("Editing is disabled on an older revision.");
    expect(host.calls.some((call) => call.method === "project/work/revise")).toBe(false);
  });
});
