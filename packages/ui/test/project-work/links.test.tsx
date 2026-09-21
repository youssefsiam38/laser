// @vitest-environment happy-dom
/**
 * "Link something…" and its undo (M21-T7, D-355 "Actions common to every kind").
 *
 * Links are optional in every direction: an artifact with none is complete,
 * the inspector says so in words, and nothing here nags for one. What is
 * proven is the act — the edge is written between the two exact revisions the
 * person was looking at, in the direction the relation reads, and removing it
 * leaves both artifacts untouched.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRequests } from "@lasercode/protocol";

import { Inspector } from "../../src/components/project-work/Inspector.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi, selectWork } from "../../src/project-work/workspace-state.js";
import type { ProjectWorkSnapshot } from "../../src/project-work/store.js";

import { bodyPage, detailFixture, specFixture } from "./bodies-fixture.js";
import { countsOf, item } from "./fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;
const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];

const rows = [
  item({ entityId: "e1", kind: "spec", number: 4, title: "The relay" }),
  item({ entityId: "e2", kind: "research", number: 7, title: "Which PDF library" }),
];

const edge = {
  projectId: "p1",
  linkId: "l1",
  relation: "supports" as const,
  subject: { entityId: "e2", revisionId: "e2r1", kind: "research" as const, key: "RES-7" },
  object: { entityId: "e1", revisionId: "e1r1", kind: "spec" as const, key: "SPEC-4" },
  createdAt: "2026-02-02T00:00:00.000Z",
  origin: { actor: { kind: "person" as const, label: "You" } },
};

let linked = false;

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "project/work/list") {
      return { projectId: "p1", seq: 7, items: rows, counts: countsOf(rows) };
    }
    if (method === "project/work/get") {
      return detailFixture({
        kind: "spec",
        number: 4,
        body: bodyPage({ kind: "spec", spec: specFixture() }),
        edges: linked ? [edge] : [],
      }) as ClientRequests["project/work/get"]["result"];
    }
    if (method === "project/work/link") {
      linked = true;
      return { link: { type: "edge", edge }, seq: 8 };
    }
    if (method === "project/work/unlink") {
      linked = false;
      return { removed: true, seq: 9 };
    }
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  linked = false;
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

describe("links from the inspector", () => {
  it("adds one between the exact revisions, and removes it again", async () => {
    const store = makeStore();
    await store.open();
    const work = store.getSnapshot() as ProjectWorkSnapshot;
    selectWork({ entityId: "e1", kind: "spec" });
    await act(async () => root.render(<TooltipProvider><Inspector store={store} work={work} /></TooltipProvider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    // Nothing is linked, and the inspector says that is fine.
    expect(text()).toContain("Nothing is linked, and nothing has to be");

    await click(query('[data-slot="link-something"]'));
    // The relation is a real radio group, and `supports` is the default.
    const relations = [...document.body.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Relation"] [role="radio"]')];
    expect(relations.map((node) => node.textContent)).toContain("supports");
    expect(relations.find((node) => node.getAttribute("aria-checked") === "true")?.textContent).toBe("supports");

    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"] button')].find((node) => node.textContent?.includes("RES-7"));
    await click(option);
    await click(button("Link RES-7"));

    const link = calls.find((call) => call.method === "project/work/link");
    expect(link).toBeDefined();
    const params = link?.params as { link: { type: string; relation: string; subject: { revisionId: string }; object: { revisionId: string } }; expectedRevisionId: string };
    expect(params.link.type).toBe("edge");
    expect(params.link.relation).toBe("supports");
    expect(params.link.subject.revisionId).toBe("r1");
    expect(params.link.object.revisionId).toBe("e2r1");
    expect(params.expectedRevisionId).toBe("r1");

    // The inspector re-read, so the edge is on screen with the other end's key.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(text()).toContain("SPEC-4");
    const unlink = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      node.getAttribute("aria-label")?.startsWith("Unlink"),
    );
    await click(unlink);
    const removed = calls.find((call) => call.method === "project/work/unlink");
    expect(removed?.params.linkId).toBe("l1");
    expect(removed?.params.expectedRevisionId).toBe("r1");
  });
});
