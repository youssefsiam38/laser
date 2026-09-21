// @vitest-environment happy-dom
/**
 * The design workspace, wired (M21-T13).
 *
 * Everything here goes through a mocked `HostClient` answering the six
 * `design/*` methods, because that is the seam the window really has: the
 * index it reads, the review it writes, the Command it starts and stops, the
 * page it grounds and the sketch it rebuilds. What is asserted is what a
 * person would see — the entries and their chips, the progress *by files*, the
 * outline and the region, both strategies and the one that was recorded, the
 * unmapped list after "Ground it", the pins with their orphans, and the
 * before/after of two revisions.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientRequests, DesignBody, ProjectWorkComment } from "@lasercode/protocol";

import { DesignDetail } from "../../src/components/project-work/bodies/DesignDetail.js";
import type { WorkBodyContext } from "../../src/components/project-work/bodies/context.js";
import { bindProjectWork, resetProjectWork } from "../../src/project-work/registry.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { WORK_QUOTE_EVENT, type WorkQuoteDetail } from "../../src/components/project-work/quote.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";

import { designDetail, designFixture, indexFixture } from "./fixture.js";

const toast = vi.fn();
const SKETCH_HTML = '<!doctype html><html><body><main><h1>Filters</h1><canvas id="c"></canvas></main><script>rows.filter(Boolean)</script></body></html>';

/** Everything the window asked the host, in order. */
const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
let answers: Partial<Record<string, (params: Record<string, unknown>) => unknown>> = {};

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({
      actions: { toast },
      client: {
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === "project/work/blob/read") return { data: btoa(SKETCH_HTML), bytes: SKETCH_HTML.length };
          const answer = answers[method];
          if (!answer) throw new Error(`the fixture does not answer ${method}`);
          return answer(params);
        },
      },
    }),
    useCapability: () => ({ state: "available" }),
  };
});

const HOST_PAGE: NonNullable<ClientRequests["design/host/ground"]["result"]["hostPage"]> = {
  routeOrPath: "/orders",
  templatePath: "app/views/orders/index.html.erb",
  outline: [
    { id: "o1", role: "template", label: "orders/index", depth: 0, structuralPath: "/", textHash: "a".repeat(64) },
    { id: "o2", role: "header", label: "Orders", depth: 1, structuralPath: "/header[0]", textHash: "b".repeat(64) },
    { id: "o3", role: "region", label: "Filters", depth: 1, structuralPath: "/section[1]", textHash: "c".repeat(64) },
  ],
  files: ["app/views/orders/index.html.erb", "app/controllers/orders_controller.rb"],
  stack: "rails",
  fidelity: "mapped",
};

const STRATEGY: NonNullable<ClientRequests["design/host/ground"]["result"]["strategy"]> = {
  recommended: "island",
  conform: { kind: "conform", reasons: ["The team works in ERB day to day."], tradeoffs: ["The new work ages with the old page."], eraId: "era_legacy" },
  island: { kind: "island", reasons: ["New work belongs in the React era."], tradeoffs: ["The island has to be built into the existing build."], eraId: "era_1" },
  summary: "Island — new work belongs in the React era.",
  proposalOnly: true,
  newWorkEra: { id: "era_1", name: "current react" },
};

let root: Root;
let container: HTMLDivElement;
let store: StateStore;

/** The conversation this window is on, and the project it belongs to. */
const SESSION = "/p/one.jsonl";
const SESSION_CWD = "/p";

/**
 * The window's state: one conversation in this project, selected.
 *
 * An index build is a Command, and a Command belongs to a session — so the
 * Design tab can only start one when this window is on a conversation of the
 * project being indexed. That is what this seeds.
 */
function storeWith(over: Partial<{ current: string | undefined; cwd: string }> = {}): StateStore {
  const current = "current" in over ? over.current : SESSION;
  const cwd = over.cwd ?? SESSION_CWD;
  return createStateStore({
    ...initialState,
    ...(current !== undefined ? { current } : {}),
    sessions: [
      {
        path: current ?? SESSION,
        id: "s1",
        cwd,
        createdAt: "2026-02-03T10:00:00.000Z",
        modifiedAt: "2026-02-03T10:00:00.000Z",
        messageCount: 2,
      },
    ],
  });
}
const workCalls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];
let historyBody: DesignBody | undefined;

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    workCalls.push({ method, params });
    if (method === "project/work/revise") {
      return { ref: { projectId: "p1", kind: "design", entityId: "e1", revisionId: "r2" }, entity: {}, revision: { index: 2, revisionId: "r2" }, seq: 8 };
    }
    if (method === "project/work/get") {
      const body = historyBody ?? designFixture();
      return { ...designDetail(body), body: { body: { kind: "design", design: body } } };
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

function contextFor(body: DesignBody, over: Partial<WorkBodyContext> = {}, comments?: ProjectWorkComment[]): WorkBodyContext {
  const detail = designDetail(body, comments ? { comments } : {});
  return { store: makeStore(), detail, editable: true, onChanged: vi.fn(), items: [], compact: false, ...over };
}

function comment(over: Partial<ProjectWorkComment> & Pick<ProjectWorkComment, "commentId" | "anchor">): ProjectWorkComment {
  return {
    projectId: "p1",
    entityId: "e1",
    revisionId: "r1",
    text: "Quieter, please.",
    state: "open",
    blocking: false,
    createdAt: "2026-02-03T10:00:00.000Z",
    origin: { actor: { kind: "person", label: "Rae" } },
    ...over,
  } as ProjectWorkComment;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  workCalls.length = 0;
  historyBody = undefined;
  toast.mockReset();
  answers = { "design/index/get": () => ({ state: "ready", index: indexFixture(), progress: { total: 3, reviewed: 2, changed: 0 }, commands: [] }) };
  store = storeWith();
  // The registry is how a directory becomes a project id: the conversation's
  // folder resolves to "p1", which is what makes it eligible to own a build.
  resetProjectWork();
  bindProjectWork((async (method: string, params: Record<string, unknown>) => {
    if (method !== "project/work/list") throw new Error(`the fixture does not answer ${method}`);
    // A directory resolves to a project once; every read after that names the
    // id, exactly as the registry does it.
    const cwd = params["cwd"] as string | undefined;
    const projectId = (params["projectId"] as string | undefined) ?? (cwd === SESSION_CWD ? "p1" : "p2");
    return { projectId, items: [], seq: 1, counts: {}, attention: {} };
  }) as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetProjectWork();
  bindProjectWork(undefined);
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(target: Element | null | undefined): Promise<void> {
  if (!target) throw new Error("no such control");
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll("button")];
}

function button(text: string): HTMLButtonElement | undefined {
  return buttons().find((node) => node.textContent?.includes(text));
}

async function render(body: DesignBody, over: Partial<WorkBodyContext> = {}, comments?: ProjectWorkComment[]): Promise<void> {
  await act(async () =>
    root.render(
      <LaserStoreProvider store={store}>
        <TooltipProvider>
          <DesignDetail body={body} context={contextFor(body, over, comments)} />
        </TooltipProvider>
      </LaserStoreProvider>,
    ),
  );
  await settle();
  // The owner is resolved through one bounded `project/work/list`; the effect
  // that reads it lands a tick after the first paint.
  await settle();
}

describe("the design index over the wire", () => {
  it("reads the project's index and shows every entry with its chips", async () => {
    await render(designFixture());
    expect(requests.filter((request) => request.method === "design/index/get")).toHaveLength(1);
    expect(requests[0]?.params).toEqual({ projectId: "p1" });
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    expect(panel.querySelectorAll('[data-slot="design-index-entry"]')).toHaveLength(3);
    expect(panel.textContent).toContain("unreviewed");
    expect(panel.textContent).toContain("in this design");
  });

  it("says a project has never been indexed in the host's own words, and offers to build it", async () => {
    answers["design/index/get"] = () => ({ state: "absent", commands: [], detail: "This project has not been indexed yet." });
    await render(designFixture());
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    expect(panel.textContent).toContain("This project has not been indexed yet.");
    expect(button("Build the index")).toBeDefined();
  });

  it("writes a review through the wire and re-reads the index from the answer", async () => {
    const reviewed = indexFixture();
    reviewed.entries = reviewed.entries.map((entry) => (entry.id === "e_help" ? { ...entry, review: { state: "accepted", reviewer: "You" } } : entry));
    answers["design/index/review"] = () => ({ index: reviewed, progress: { total: 3, reviewed: 3, changed: 0 } });
    await render(designFixture());
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    const accept = [...panel.querySelectorAll("button")].find((node) => node.textContent?.includes("Accept") && !node.disabled);
    await click(accept);
    expect(requests.find((request) => request.method === "design/index/review")?.params).toEqual({ projectId: "p1", entryId: "e_help", action: "accept" });
    expect(container.querySelector('[data-entry-id="e_help"]')?.getAttribute("data-review")).toBe("accepted");
  });

  it("shows a refused review as the sentence the worker wrote", async () => {
    answers["design/index/review"] = () => {
      throw new Error("That entry is not in this index any more. Next: re-index and try again.");
    };
    await render(designFixture());
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    await click([...panel.querySelectorAll("button")].find((node) => node.textContent?.includes("Accept") && !node.disabled));
    expect(container.textContent).toContain("That entry is not in this index any more.");
  });
});

describe("Re-index, as a Command", () => {
  it("starts it, follows it by files, and stops it", async () => {
    let started = false;
    let stopped = false;
    answers["design/index/build"] = (params) => {
      started = true;
      expect(params["projectId"]).toBe("p1");
      // The Command is owned by the conversation this window is on: that is
      // where its row, its progress and its Stop live.
      expect(params["sessionPath"]).toBe(SESSION);
      return { command: { commandId: "dib_1", title: "Indexing the design system", phase: "parsing", filesParsed: 12, filesFound: 240, filesFromCache: 0, elapsedMs: 900, running: true, sessionPath: SESSION } };
    };
    answers["design/index/get"] = () => ({
      state: "ready",
      index: indexFixture(),
      commands: started && !stopped
        ? [{ commandId: "dib_1", title: "Indexing the design system", phase: "parsing", filesParsed: 12, filesFound: 240, filesFromCache: 0, elapsedMs: 900, running: true, sessionPath: SESSION }]
        : started
          ? [{ commandId: "dib_1", title: "Indexing the design system", phase: "stopped", filesParsed: 12, filesFound: 240, filesFromCache: 0, elapsedMs: 900, running: false, sessionPath: SESSION }]
          : [],
    });
    answers["design/index/stop"] = () => {
      stopped = true;
      return { stopped: true };
    };

    await render(designFixture());
    await click(button("Re-index"));
    expect(requests.some((request) => request.method === "design/index/build")).toBe(true);
    // Progress is files, never a percentage.
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    expect(panel.textContent).toContain("12 of 240 files");
    expect(panel.textContent).not.toContain("%");

    await click(button("Stop"));
    expect(requests.find((request) => request.method === "design/index/stop")?.params).toEqual({ projectId: "p1", commandId: "dib_1" });
    await settle();
    expect(container.querySelector('[data-slot="design-index-panel"]')?.textContent).not.toContain("12 of 240 files");
  });

  it("says why a build could not be started rather than spinning", async () => {
    answers["design/index/build"] = () => {
      throw new Error("That project is not one this app knows.");
    };
    await render(designFixture());
    await click(button("Re-index"));
    expect(container.textContent).toContain("That project is not one this app knows.");
  });

  /**
   * A Command lives in a conversation. With none of this project's open, the
   * tab says so where the button was and offers the way back — it never starts
   * a build nobody could watch or stop, and never hides the control silently.
   */
  it("asks for a conversation instead of starting an invisible build", async () => {
    store = storeWith({ current: undefined });
    await render(designFixture());
    expect(button("Re-index")).toBeUndefined();
    const refusal = container.querySelector('[data-slot="design-index-build-refusal"]');
    expect(refusal?.textContent).toContain("runs as a Command in a conversation");
    expect(button("Back to the conversation")).toBeDefined();
    expect(requests.some((request) => request.method === "design/index/build")).toBe(false);
  });

  it("refuses to hand this project's build to a conversation of another project", async () => {
    store = storeWith({ cwd: "/elsewhere" });
    await render(designFixture());
    expect(button("Re-index")).toBeUndefined();
    expect(container.querySelector('[data-slot="design-index-build-refusal"]')).not.toBeNull();
    expect(requests.some((request) => request.method === "design/index/build")).toBe(false);
  });
});

describe("design in context", () => {
  it("grounds the page /design from named, shows the outline, and records the region and the strategy", async () => {
    answers["design/host/ground"] = () => ({ hostPage: HOST_PAGE, strategy: STRATEGY, candidates: [], gaps: [] });
    const body = designFixture({ brief: "from /orders" });
    await render(body);
    // The route the command named is already in the field; grounding is one act.
    await click(button("Ground this page"));
    expect(requests.find((request) => request.method === "design/host/ground")?.params).toEqual({ projectId: "p1", routeOrPath: "/orders" });
    const outline = container.querySelector('[data-slot="host-outline"]')!;
    expect(outline.textContent).toContain("Filters");

    // Pick the region on the outline: the anchor is the structural path.
    await click([...outline.querySelectorAll("button")].find((node) => node.textContent?.includes("Filters")));
    expect(container.querySelector('[data-slot="design-host-context"]')?.textContent).toContain("/section[1]");

    // Both strategies are on the table with their reasons; the choice is recorded.
    await click(button("Why"));
    expect(container.textContent).toContain("The team works in ERB day to day.");
    expect(container.textContent).toContain("New work belongs in the React era.");
    await click(button("Island"));
    await click(button("Save revision"));
    const revise = workCalls.find((call) => call.method === "project/work/revise");
    const saved = (revise?.params["body"] as { design: DesignBody }).design;
    expect(saved.hostPage?.routeOrPath).toBe("/orders");
    expect(saved.insertionRegion).toMatchObject({ templatePath: "app/views/orders/index.html.erb", structuralPath: "/section[1]" });
    expect(saved.strategy).toMatchObject({ kind: "island", eraId: "era_1", proposalOnly: true });
    expect(saved.strategy?.alternative?.kind).toBe("conform");
  });

  it("shows an orphaned region when the template no longer has the path, and never moves it", async () => {
    const body = designFixture({
      brief: "from /orders",
      hostPage: HOST_PAGE,
      insertionRegion: { id: "reg1", templatePath: "app/views/orders/index.html.erb", structuralPath: "/section[9]", textHash: "c".repeat(64) },
    });
    await render(body);
    const orphan = container.querySelector('[data-slot="region-orphaned"]');
    expect(orphan).not.toBeNull();
    expect(orphan?.textContent).toContain("no longer exists");
    // The candidate is an offer, and taking it is the person's act.
    expect(button("Re-anchor it there")).toBeDefined();
  });

  it("names the pages that could have been meant when the route resolves to nothing", async () => {
    answers["design/host/ground"] = () => ({ candidates: ["/orders", "/order/:id"], gaps: [], detail: 'No page in this project answers to "/ordrs".' });
    await render(designFixture({ brief: "from /ordrs" }));
    await click(button("Ground this page"));
    expect(container.textContent).toContain('No page in this project answers to "/ordrs".');
    expect(button("/order/:id")).toBeDefined();
  });
});

describe("Ground it", () => {
  it("rebuilds the sketch as a tree, keeps the sketch as provenance, and lists what did not map", async () => {
    answers["design/sketch/ground"] = (params) => {
      expect(params["document"]).toContain("<canvas");
      return {
        screen: {
          id: "gs_1",
          name: "Filter demo, grounded",
          content: { tree: { rootNodeId: "g1", nodes: [{ id: "g1", component: { primitive: "stack" }, fidelity: "proposed", props: {}, children: [] }] } },
          states: [{ name: "filtered", included: false, skipReason: "the sketch filtered the list live" }],
          fidelity: "proposed",
        },
        unmapped: [{ what: "<canvas>", why: "No component in this project's design index matches this element.", primitive: "stack" }],
        states: [{ name: "filtered", included: false, skipReason: "the sketch filtered the list live" }],
        usedEntryIds: [],
        notes: [],
      };
    };
    await render(designFixture());
    await click([...container.querySelectorAll("button")].find((node) => node.textContent === "Filter demo"));
    await click(button("Ground it"));
    expect(requests.some((request) => request.method === "design/sketch/ground")).toBe(true);

    // The tree is in the draft beside its sketch, and the sketch records where it went.
    await click(button("Save revision"));
    const revise = workCalls.find((call) => call.method === "project/work/revise");
    const saved = (revise?.params["body"] as { design: DesignBody }).design;
    expect(saved.screens.some((screen) => screen.id === "gs_1")).toBe(true);
    expect(saved.sketches.find((sketch) => sketch.id === "sk_1")?.groundedIntoScreenId).toBe("gs_1");

    // What did not map is said in Review, with the reason.
    await click(button("Review"));
    expect(container.querySelector('[data-slot="design-review"]')?.textContent).toContain("No component in this project's design index matches this element.");
  });
});

describe("anchored review", () => {
  it("pins a comment to its node on the canvas and shows an orphan as orphaned", async () => {
    const comments = [
      comment({ commentId: "c1", anchor: { target: "node", nodeId: "n_pay" }, blocking: true }),
      comment({ commentId: "c2", anchor: { target: "node", nodeId: "n_gone" }, text: "This button has to go." }),
    ];
    await render(designFixture(), {}, comments);
    const pins = container.querySelectorAll('[data-slot="screen-pin"]');
    expect(pins).toHaveLength(1);
    expect(pins[0]?.getAttribute("aria-label")).toBe("Comment 1");

    await click(button("Review"));
    const review = container.querySelector('[data-slot="design-review"]')!;
    const rows = review.querySelectorAll('[data-slot="design-pin"]');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.getAttribute("data-orphaned")).toBe("true");
    expect(rows[1]?.textContent).toContain("anchor gone");
    expect(rows[1]?.textContent).toContain("This button has to go.");
    expect(review.textContent).toContain("nothing was re-pinned for you");
  });

  it("compares this revision with an earlier one, node by node", async () => {
    const earlier = designFixture();
    historyBody = {
      ...earlier,
      screens: earlier.screens.map((screen) =>
        screen.id !== "scr_list" || !("tree" in screen.content)
          ? screen
          : {
              ...screen,
              content: { tree: { ...screen.content.tree, nodes: screen.content.tree.nodes.map((node) => (node.id === "n_pay" ? { ...node, text: "Pay" } : node)) } },
            },
      ),
    };
    const detail = designDetail(designFixture());
    const withHistory = {
      ...detail,
      history: [
        detail.revision,
        { ...detail.revision, revisionId: "r0", index: 1, note: "first draft" },
      ],
      entity: { ...detail.entity, revisionCount: 2 },
    } as typeof detail;
    await act(async () =>
      root.render(
        <LaserStoreProvider store={store}>
          <TooltipProvider>
            <DesignDetail body={designFixture()} context={{ store: makeStore(), detail: withHistory, editable: true, onChanged: vi.fn(), items: [], compact: false }} />
          </TooltipProvider>
        </LaserStoreProvider>,
      ),
    );
    await settle();
    await click(button("Review"));
    await settle();
    const review = container.querySelector('[data-slot="design-review"]')!;
    expect(workCalls.some((call) => call.method === "project/work/get" && call.params["revisionId"] === "r0")).toBe(true);
    expect(review.textContent).toContain("1 node changed");
    const row = review.querySelector('[data-slot="design-diff-row"]');
    expect(row?.textContent).toContain("n_pay");
    expect(row?.textContent).toContain("before: ");
    expect(row?.textContent).toContain("Pay now");
  });
});

describe("the hand-off", () => {
  it("puts /design implement @KEY into the composer rather than sending it", async () => {
    const seen: WorkQuoteDetail[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent<WorkQuoteDetail>).detail);
    };
    window.addEventListener(WORK_QUOTE_EVENT, listener);
    try {
      await render(designFixture());
      await click(button("Implement"));
      await click(button("Send /design implement"));
      expect(seen).toEqual([{ text: "/design implement @DES-3", workKey: "DES-3" }]);
      expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("/design implement @DES-3"));
    } finally {
      window.removeEventListener(WORK_QUOTE_EVENT, listener);
    }
  });
});

describe("the sections", () => {
  it("offers Index, Foundation, Screens, Flows and Review, and Foundation says whose it is", async () => {
    await render(designFixture());
    for (const label of ["Index", "Foundation", "Screens", "Flows", "Review"]) expect(button(label), label).toBeDefined();
    await click(button("Foundation"));
    expect(container.querySelector('[data-slot="design-foundation"]')?.textContent).toContain("This design has no foundation");
    await click(button("Flows"));
    const flows = container.querySelector('[data-slot="design-flows"]')!;
    expect(flows.textContent).toContain("Pay an invoice");
    expect(flows.textContent).toContain("open Paid over it");
  });
});
