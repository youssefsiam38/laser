// @vitest-environment happy-dom
/**
 * Comments in the inspector (M21-T8): threads, semantic anchors, the orphaned
 * ones, the blocking flag and who may resolve.
 *
 * What is proven here is the *act* and the *wire*: which anchor a comment is
 * written against, which revision fences it, what "Mark addressed" and
 * "Resolve" send, and that several unresolved comments become one revision
 * request carrying a before/after. The rules themselves are the host's, and
 * are proven over the wire in `packages/host/test/project-work/gates.test.ts`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommentsPanel } from "../../src/components/project-work/CommentsPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";

import { comment, reviewDetail, reviewSpecBody } from "./gates-fixture.js";

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
    if (method === "project/work/comment") return { comment: comment({ commentId: "c9" }), entity: reviewDetail().entity, seq: 8 };
    if (method === "project/work/resolve-comment") return { comment: comment({ commentId: "c1", state: "resolved" }), entity: reviewDetail().entity, seq: 9 };
    if (method === "project/work/review") return { entity: reviewDetail().entity, seq: 10 };
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

const text = (): string => document.body.textContent ?? "";
const query = <T extends Element = HTMLElement>(selector: string): T | null => document.body.querySelector<T>(selector);
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const type = async (element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> => {
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
        <CommentsPanel store={store} detail={detail} body={detail.body?.body} onChanged={() => {}} />
      </TooltipProvider>,
    ),
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the comments panel", () => {
  it("says what a comment can be pinned to when there are none", async () => {
    await render();
    expect(text()).toContain("No comments on this one");
    expect(text()).toContain("blocking one holds the gate");
  });

  it("writes a comment against the semantic anchor the person picked, fenced by the revision", async () => {
    const store = makeStore();
    await render(reviewDetail(), store);
    await click(query('[data-slot="add-comment"]'));

    // The anchors offered are this body's own: requirement r1 is one of them.
    const options = all('[role="listbox"][aria-label="What this comment is about"] [role="option"] button');
    expect(options.map((node) => node.textContent)).toContain("Requirement · must — The review footer is reachable with one thumb.");
    await click(options.find((node) => node.textContent?.includes("Requirement")));

    const field = query<HTMLTextAreaElement>('textarea[aria-label="Your comment"]');
    await type(field!, "One thumb, not two.");
    await click(query<HTMLInputElement>('[data-slot="comment-draft"] input[type="checkbox"]'));
    await click(button("Comment"));

    const written = calls.find((call) => call.method === "project/work/comment");
    expect(written?.params).toMatchObject({
      entityId: "e1",
      expectedRevisionId: "r1",
      revisionId: "r1",
      anchor: { target: "section", sectionId: "r1" },
      text: "One thumb, not two.",
      blocking: true,
    });
  });

  it("keeps an orphaned comment on screen, labelled, with what it said", async () => {
    await render(
      reviewDetail({
        comments: [comment({ commentId: "c1", anchor: { target: "node", nodeId: "n7" }, orphaned: true, text: "Too small on a phone." })],
      }),
    );
    const thread = query('[data-slot="comment-thread"]');
    expect(thread?.dataset.orphaned).toBe("true");
    expect(text()).toContain("Too small on a phone.");
    expect(text()).toContain("anchor gone");
    expect(text()).toContain("not in this revision any more");
  });

  it("groups a reply under its root and marks a blocking thread", async () => {
    await render(
      reviewDetail({
        comments: [
          comment({ commentId: "c1", text: "Is 320px the floor?" }),
          comment({ commentId: "c2", parentCommentId: "c1", text: "It is.", createdAt: "2026-02-02T09:30:00.000Z" }),
          comment({ commentId: "c3", blocking: true, text: "Say what happens offline.", anchor: { target: "section", sectionId: "a1" } }),
        ],
      }),
    );
    const threads = all('[data-slot="comment-thread"]');
    // Two threads, blocking first: what stops a gate is what a person is here for.
    expect(threads).toHaveLength(2);
    expect(threads[0]?.dataset.blocking).toBe("true");
    expect(threads[0]?.textContent).toContain("Say what happens offline.");
    expect(threads[1]?.textContent).toContain("Is 320px the floor?");
    expect(threads[1]?.textContent).toContain("It is.");
  });

  it("offers addressed and resolved separately, and says whose each one is", async () => {
    const store = makeStore();
    await render(reviewDetail({ comments: [comment({ commentId: "c1", blocking: true })] }), store);
    await click(query('[data-slot="address-comment"]'));
    expect(calls.find((call) => call.method === "project/work/resolve-comment")?.params).toMatchObject({
      commentId: "c1",
      resolution: "addressed",
      expectedRevisionId: "r1",
    });

    calls.length = 0;
    await render(reviewDetail({ comments: [comment({ commentId: "c1", blocking: true, state: "addressed" })] }), store);
    expect(text()).toContain("Only you can resolve it");
    // An addressed comment has no "Mark addressed" left, only Resolve.
    expect(query('[data-slot="address-comment"]')).toBeNull();
    await click(query('[data-slot="resolve-comment"]'));
    expect(calls.find((call) => call.method === "project/work/resolve-comment")?.params).toMatchObject({ commentId: "c1", resolution: "resolved" });
  });

  it("reopens a resolved thread", async () => {
    const store = makeStore();
    await render(reviewDetail({ comments: [comment({ commentId: "c1", state: "resolved" })] }), store);
    await click(query('[data-slot="reopen-comment"]'));
    expect(calls.find((call) => call.method === "project/work/resolve-comment")?.params).toMatchObject({ resolution: "reopened" });
  });

  it("batches several unresolved comments into one revision request with a before and an after", async () => {
    const store = makeStore();
    await render(
      reviewDetail({
        spec: reviewSpecBody(),
        comments: [
          comment({ commentId: "c1", anchor: { target: "section", sectionId: "r1" }, blocking: true, text: "One thumb, not two." }),
          comment({ commentId: "c2", anchor: { target: "section", sectionId: "a1" }, text: "Name the width." }),
          comment({ commentId: "c3", state: "resolved", text: "Already settled." }),
        ],
      }),
      store,
    );
    // The preview says exactly what the one request would carry.
    const preview = query('[data-slot="batch-preview"]');
    expect(preview?.textContent).toContain("The review footer is reachable with one thumb.");
    expect(preview?.textContent).toContain("One thumb, not two.");
    expect(preview?.textContent).toContain("Name the width.");
    expect(preview?.textContent).not.toContain("Already settled.");

    await click(query('[data-slot="batch-revision"]'));
    const request = calls.find((call) => call.method === "project/work/review");
    expect(request?.params).toMatchObject({ action: "return_to_draft", entityId: "e1", expectedRevisionId: "r1" });
    const note = (request?.params as { note: string }).note;
    expect(note).toContain("now: The review footer is reachable with one thumb.");
    expect(note).toContain("asked: One thumb, not two.");
    expect(note).toContain("asked: Name the width.");
    expect(note).not.toContain("Already settled.");
  });

  it("does not offer a batch for a single comment", async () => {
    await render(reviewDetail({ comments: [comment({ commentId: "c1" })] }));
    expect(query('[data-slot="batch-revision"]')).toBeNull();
    expect(query('[data-slot="batch-preview"]')).toBeNull();
  });

  it("shows the host's refusal instead of pretending the write happened", async () => {
    const request = (async (method: ProjectWorkMethod) => {
      if (method === "project/work/resolve-comment") throw new Error("An agent can mark a comment addressed; only you can resolve or reopen it.");
      throw new Error(`the fixture does not answer ${method}`);
    }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
    const store = new ProjectWorkStore({ request, projectId: "p1" });
    await render(reviewDetail({ comments: [comment({ commentId: "c1" })] }), store);
    await click(query('[data-slot="resolve-comment"]'));
    expect(text()).toContain("only you can resolve or reopen it");
  });
});
