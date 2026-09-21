// @vitest-environment happy-dom
/**
 * The lifecycle review request above the composer (M21-T8, D-355).
 *
 * The leap allows exactly one thing here: the existing Approval Card, with the
 * key in it, opening the workspace at the exact revision. So what is proven is
 * that it is the same element, that it carries the key and the type badge,
 * that its action is *navigation* and never an approval, and that the control
 * which has focus when it appears is the one that does nothing (Enter never
 * approves).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalRequestCard } from "../../src/components/project-work/ApprovalRequestCard.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { bindProjectWork, resetProjectWork } from "../../src/project-work/registry.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";
import type { ProjectWorkMethod, ProjectWorkRequest } from "../../src/project-work/store.js";

import { countsOf, item } from "./fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;

const gateRow = item({
  entityId: "e1",
  kind: "spec",
  number: 4,
  title: "Phone review",
  state: "needs_review",
  needsAttention: true,
  updatedAt: "2026-02-03T00:00:00.000Z",
  ref: { revisionId: "r7" } as never,
});
const blockedRow = item({
  entityId: "e2",
  kind: "design",
  number: 3,
  title: "Review footer",
  needsAttention: true,
  blockingComments: 2,
});
const quietRow = item({ entityId: "e3", kind: "plan", number: 2, title: "Ship it" });

function bind(rows = [gateRow, blockedRow, quietRow]): void {
  const request = (async (method: ProjectWorkMethod) => {
    if (method !== "project/work/list") throw new Error(`the fixture does not answer ${method}`);
    return { projectId: "p1", seq: 7, items: rows, counts: countsOf(rows) };
  }) as unknown as ProjectWorkRequest;
  bindProjectWork(request);
}

const text = (): string => document.body.textContent ?? "";
const query = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function render(cwd: string | undefined = "/work/alpha"): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ApprovalRequestCard cwd={cwd} />
      </TooltipProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetProjectWork();
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetProjectWork();
  resetWorkspaceUi();
  bindProjectWork(undefined);
});

describe("the lifecycle review request in the transcript", () => {
  it("is the Approval Card, with the key, the type badge and why it is waiting", async () => {
    bind();
    await render();
    expect(query('[data-slot="approval-card"]')).not.toBeNull();
    expect(text()).toContain("SPEC-4");
    expect(text()).toContain("Waiting for your review");
    expect(text()).toContain("The full reading, and the decision, happen in the workspace.");
    // The second waiting item is counted, never stacked.
    expect(text()).toContain("+1 more waiting behind this one");
    expect(query('[data-slot="lifecycle-review-card"]')?.dataset.reason).toBe("gate");
  });

  it("opens the workspace at the exact revision, and approves nothing from here", async () => {
    bind();
    await render();
    expect(button("Yes")).toBeUndefined();
    await click(button("Open SPEC-4 in the workspace"));
    expect(workspaceUi()).toMatchObject({
      open: true,
      projectId: "p1",
      tab: "work",
      selection: { entityId: "e1", kind: "spec", revisionId: "r7" },
    });
  });

  it("gives focus to the control that does nothing, so Enter cannot act", async () => {
    bind();
    await render();
    const focused = query("[data-autofocus]");
    expect(focused?.textContent).toBe("Not now");
  });

  it("steps aside when dismissed, and shows the next one waiting", async () => {
    bind();
    await render();
    await click(button("Not now"));
    expect(text()).toContain("DES-3");
    expect(text()).toContain("Blocking comments");
  });

  it("draws nothing when nothing is waiting, and nothing without a project", async () => {
    bind([quietRow]);
    await render();
    expect(query('[data-slot="lifecycle-review-card"]')).toBeNull();

    resetProjectWork();
    await render(undefined);
    expect(query('[data-slot="lifecycle-review-card"]')).toBeNull();
  });
});
