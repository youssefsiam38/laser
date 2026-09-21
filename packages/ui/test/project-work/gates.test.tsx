// @vitest-environment happy-dom
/**
 * The gate card (M21-T8, D-332).
 *
 * The three things that must be true of it, and are tested here as behaviour
 * rather than as markup:
 *
 * - it says which gate is next and what that gate still needs, in the host's
 *   own sentences;
 * - **Approve is disabled while a blocking comment is open**, and the reason
 *   is on screen beside it;
 * - **Enter never approves**: the key has to be typed, the field swallows
 *   Enter, and until then the decision cannot be recorded. The permission mode
 *   travels with a build approval, and a change request carries its note and
 *   covers only the subject.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_OUTCOMES } from "@lasercode/protocol";

import { GateCard } from "../../src/components/project-work/GateCard.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { approval, blockingRef, gateReport, gateStatus, reviewDetail, reviewSpecBody } from "./gates-fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;
const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "project/work/list") return { projectId: "p1", seq: 7, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
    if (method === "project/work/approve") return { approval: approval({ approvalId: "ap1" }), entity: reviewDetail().entity, seq: 8 };
    if (method === "project/work/review") return { entity: reviewDetail().entity, seq: 9 };
    if (method === "project/work/revise") return { ref: reviewDetail().ref, entity: reviewDetail().entity, revision: reviewDetail().revision, seq: 10 };
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
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
const typeInto = async (element: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

async function render(detail = reviewDetail(), store = makeStore()): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GateCard store={store} detail={detail} onChanged={() => {}} />
      </TooltipProvider>,
    ),
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
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

describe("the gate card", () => {
  it("says which gate is next, what it covers and what the other two still need", async () => {
    await render();
    const card = query('[data-slot="gate-card"]');
    expect(card?.dataset.gate).toBe("brief");
    expect(card?.dataset.state).toBe("ready");
    expect(text()).toContain("Is this the right thing to build?");
    expect(text()).toContain("1 revision, by digest");
    expect(text()).toContain("aaaaaaaaaaaa");

    await click(query('[role="tab"][data-gate="design"]'));
    expect(text()).toContain("has no design linked to it");
  });

  it("is quiet about a spec that never chose the gated path, and offers the way in", async () => {
    const store = makeStore();
    await render(reviewDetail({ spec: reviewSpecBody({ gated: false }), gates: gateReport({ gated: false, next: undefined }) }), store);
    expect(text()).toContain("is not on the gated path");
    expect(query('[data-slot="gate-card"]')).toBeNull();

    await click(query('[data-slot="enter-gated-path"]'));
    const revised = calls.find((call) => call.method === "project/work/revise");
    expect((revised?.params as { body: { spec: { gated: boolean } } }).body.spec.gated).toBe(true);
    expect(revised?.params.expectedRevisionId).toBe("r1");
  });

  it("asks for a decision before one can be taken on a draft", async () => {
    const store = makeStore();
    await render(
      reviewDetail({
        state: "draft",
        gates: gateReport({
          gates: [
            gateStatus("brief", {
              state: "waiting",
              subject: { entityId: "e1", kind: "spec", key: "SPEC-4", title: "Phone review", revisionId: "r1", digest: "a".repeat(64), state: "draft" },
              requirements: [
                { role: "spec_brief", satisfied: true, detail: "SPEC-4's brief, at the revision on screen." },
                { role: "spec_brief", satisfied: false, problem: "draft", detail: "SPEC-4 has not been sent for review yet. Ask for a decision when it is ready." },
              ],
              refusal: "SPEC-4 has not been sent for review yet. Ask for a decision when it is ready.",
            }),
          ],
        }),
      }),
      store,
    );
    expect(text()).toContain("has not been sent for review yet");
    await click(query('[data-slot="ask-for-decision"]'));
    expect(calls.find((call) => call.method === "project/work/review")?.params).toMatchObject({ action: "request_review", entityId: "e1" });
  });

  it("disables Approve while a blocking comment is open, and says which one", async () => {
    await render(
      reviewDetail({
        gates: gateReport({
          gates: [
            gateStatus("brief", {
              state: "waiting",
              blockingComments: [blockingRef({ commentId: "cm_1" })],
              refusal: "1 blocking comment must be resolved before this can be approved: SPEC-4 cm_1.",
            }),
          ],
        }),
      }),
    );
    expect(text()).toContain("1 blocking comment");
    expect(text()).toContain("One thumb, not two.");
    expect(query('[data-slot="gate-refusal"]')?.textContent).toContain("must be resolved before this can be approved");
    const approve = query<HTMLButtonElement>('[data-outcome="approve"]');
    expect(approve?.disabled).toBe(true);
    // A change request is still available: a blocked gate is not a dead end.
    expect(query<HTMLButtonElement>('[data-outcome="request_changes"]')?.disabled).toBe(false);
  });

  it("never approves on Enter: the key is typed, and the field swallows the key press", async () => {
    const store = makeStore();
    await render(reviewDetail(), store);
    await click(query('[data-outcome="approve"]'));

    const record = query<HTMLButtonElement>('[data-slot="record-decision"]');
    expect(record?.disabled).toBe(true);
    expect(text()).toContain("Enter never approves");

    const field = query<HTMLInputElement>('input[aria-label="Type SPEC-4 to approve"]');
    // Enter inside the field is swallowed and nothing is written.
    let prevented = false;
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      field!.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    expect(prevented).toBe(true);
    expect(calls.some((call) => call.method === "project/work/approve")).toBe(false);

    // A near-miss is not the key.
    await typeInto(field!, "SPEC-5");
    expect(query<HTMLButtonElement>('[data-slot="record-decision"]')?.disabled).toBe(true);

    await typeInto(field!, "SPEC-4");
    expect(query<HTMLButtonElement>('[data-slot="record-decision"]')?.disabled).toBe(false);
    await click(query('[data-slot="record-decision"]'));
    const recorded = calls.find((call) => call.method === "project/work/approve");
    expect(recorded?.params).toMatchObject({
      entityId: "e1",
      expectedRevisionId: "r1",
      gate: "brief",
      decision: "approved",
      covers: [{ entityId: "e1", key: "SPEC-4", revisionId: "r1" }],
    });
    expect(recorded?.params.mode).toBeUndefined();
  });

  it("points at the gate's own subject when the card is open somewhere else", async () => {
    const store = makeStore();
    const covers = [
      { entityId: "e1", kind: "spec" as const, key: "SPEC-4", revisionId: "r1", digest: "a".repeat(64) },
      { entityId: "e3", kind: "plan" as const, key: "PLAN-2", revisionId: "r3", digest: "b".repeat(64) },
    ];
    await render(
      reviewDetail({
        gates: gateReport({
          next: "build",
          gates: [
            gateStatus("build", {
              state: "ready",
              subject: { entityId: "e3", kind: "plan", key: "PLAN-2", title: "Phone review plan", revisionId: "r3", digest: "b".repeat(64), state: "needs_review" },
              covers,
              requirements: [{ role: "task_graph", satisfied: true, detail: "3 tasks in PLAN-2, in a graph that orders." }],
            }),
          ],
        }),
      }),
      store,
    );
    // The card is on the spec, but the build gate is decided on the plan.
    expect(text()).toContain("This gate is decided on PLAN-2");
  });

  it("records a build approval with its mode when the person is on the gate's own subject", async () => {
    const store = makeStore();
    const covers = [
      { entityId: "e1", kind: "spec" as const, key: "SPEC-4", revisionId: "r1", digest: "a".repeat(64) },
      { entityId: "e1", kind: "plan" as const, key: "PLAN-2", revisionId: "r1", digest: "a".repeat(64) },
    ];
    await render(
      reviewDetail({
        gates: gateReport({
          next: "build",
          gates: [
            gateStatus("build", {
              state: "ready",
              subject: { entityId: "e1", kind: "plan", key: "PLAN-2", title: "Phone review plan", revisionId: "r1", digest: "a".repeat(64), state: "needs_review" },
              covers,
              requirements: [{ role: "task_graph", satisfied: true, detail: "3 tasks in PLAN-2, in a graph that orders." }],
            }),
          ],
        }),
      }),
      store,
    );
    expect(text()).toContain(GATE_OUTCOMES.build[1]!.label);
    expect(text()).toContain("Every tool the session wants to run is shown to you first.");

    await click(query('[data-outcome="build_with_manual_tool_review"]'));
    await typeInto(query<HTMLInputElement>('input[aria-label="Type PLAN-2 to approve"]')!, "PLAN-2");
    await click(query('[data-slot="record-decision"]'));
    const recorded = calls.find((call) => call.method === "project/work/approve");
    expect(recorded?.params).toMatchObject({ gate: "build", decision: "approved", mode: "manual_tool_review", covers });
  });

  it("sends a change request with its note, covering only the subject, and needs nothing typed", async () => {
    const store = makeStore();
    await render(reviewDetail(), store);
    await click(query('[data-outcome="request_changes"]'));
    const note = query<HTMLTextAreaElement>('textarea[aria-label="What should change"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(note, "Say what happens offline.");
      note!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(query('[data-slot="record-decision"]'));
    const recorded = calls.find((call) => call.method === "project/work/approve");
    expect(recorded?.params).toMatchObject({
      gate: "brief",
      decision: "changes_requested",
      note: "Say what happens offline.",
      covers: [{ entityId: "e1", revisionId: "r1" }],
    });
  });

  it("says when a settled gate was invalidated by a later change, and shows the host's refusal", async () => {
    await render(
      reviewDetail({
        gates: gateReport({
          gates: [
            gateStatus("brief", {
              state: "invalidated",
              approval: approval({ approvalId: "ap1", invalidatedAt: "2026-02-03T10:00:00.000Z" }),
            }),
          ],
        }),
      }),
    );
    expect(text()).toContain("Needs deciding again");
    expect(text()).toContain("something it covered has changed since");
  });

  it("shows a refusal from the host instead of claiming the decision landed", async () => {
    const request = (async (method: ProjectWorkMethod) => {
      if (method === "project/work/approve") throw new Error("SPEC-4 changed since this was prepared. Open it again before approving.");
      throw new Error(`the fixture does not answer ${method}`);
    }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
    await render(reviewDetail(), new ProjectWorkStore({ request, projectId: "p1" }));
    await click(query('[data-outcome="approve"]'));
    await typeInto(query<HTMLInputElement>('input[aria-label="Type SPEC-4 to approve"]')!, "SPEC-4");
    await click(query('[data-slot="record-decision"]'));
    expect(text()).toContain("changed since this was prepared");
  });
});
