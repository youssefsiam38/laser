// @vitest-environment happy-dom
/**
 * Create, Archive and Delete.
 *
 * The two things these have to get right, and the two things a screenshot
 * cannot prove: the next key is on screen *before* anything is created, and
 * **Enter confirms neither** destructive act — the typed field swallows it and
 * the cancelling control holds focus when the dialog opens (D-355, AGENTS.md).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRequests } from "@lasercode/protocol";

import { CreateDialog } from "../../src/components/project-work/CreateDialog.js";
import { DeleteDialog } from "../../src/components/project-work/ConfirmDialogs.js";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { openWorkCreate, resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { fakeHost, item, type FakeProject } from "./fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast: () => {} } }),
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
    expect(text()).toContain("Question");
    expect(button("Create research")?.disabled).toBe(true);
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
