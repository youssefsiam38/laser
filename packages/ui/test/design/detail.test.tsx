// @vitest-environment happy-dom
/**
 * The Design detail (M21-T11; leap "Detail, by kind → Design").
 *
 * Asserted here: Prototype mode plays the declarative flows end to end from a
 * click inside a shadow root; Full screen opens as a dialog and Esc closes
 * it; a sketch-only design says why it cannot be approved or handed off; what
 * waits on M21-T17 is a designed state with the honest sentence; the phone is
 * read-only with tap-to-inspect; an edit is written through
 * `project/work/revise` fenced by the revision that was read, and a conflict
 * is a banner, never an overwrite.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type DesignBody } from "@lasercode/protocol";

import { DesignDetail, IMPLEMENT_SENTENCE, foundationRequestFor } from "../../src/components/project-work/bodies/DesignDetail.js";
import type { DesignIndexAccess } from "../../src/components/design/DesignIndexPanel.js";
import { onWorkQuote, type WorkQuoteDetail } from "../../src/components/project-work/quote.js";
import type { WorkBodyContext } from "../../src/components/project-work/bodies/context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";

/**
 * The window's state, with no conversation selected: these tests are about the
 * detail itself, and a design surface mounted with nothing selected simply has
 * no conversation that could own an index build.
 */
const designStore = createStateStore(initialState);
import { SKETCH_GATE_REFUSAL } from "../../src/design/sketch.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";

import { designDetail, designFixture, indexFixture, sketchOnlyFixture } from "./fixture.js";

const toast = vi.fn();
const blobRequests: string[] = [];
const SKETCH_HTML = "<!doctype html><html><head></head><body><p>filter demo</p></body></html>";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({
      actions: { toast },
      client: {
        request: async (method: string, params: { blobId: string }) => {
          blobRequests.push(`${method}:${params.blobId}`);
          if (method !== "project/work/blob/read") throw new Error(method);
          if (params.blobId === "blob_sk_1") return { data: btoa(SKETCH_HTML), bytes: SKETCH_HTML.length };
          throw new Error("no such blob");
        },
      },
    }),
    useCapability: () => ({ state: "available" }),
  };
});

let root: Root;
let container: HTMLDivElement;
const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];
let reviseAnswer: "ok" | "conflict" = "ok";

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "project/work/revise") {
      if (reviseAnswer === "conflict") {
        const error = Object.assign(new Error("DES-3 changed while you were editing."), { code: ErrorCodes.ProjectWorkConflict, data: { current: undefined } });
        throw error;
      }
      return { ref: { projectId: "p1", kind: "design", entityId: "e1", revisionId: "r2", digest: "c".repeat(64), label: "DES-3", key: "DES-3" }, entity: {}, revision: { index: 2, revisionId: "r2" }, seq: 8 };
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

function contextFor(body: DesignBody, over: Partial<WorkBodyContext> = {}): WorkBodyContext {
  return { store: makeStore(), detail: designDetail(body), editable: true, onChanged: vi.fn(), items: [], compact: false, ...over };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  blobRequests.length = 0;
  toast.mockReset();
  reviseAnswer = "ok";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const shadowOf = (screenId: string): ShadowRoot => {
  const host = container.querySelector<HTMLElement>(`[data-slot="design-tree-frame"][data-screen-id="${screenId}"]`);
  expect(host?.shadowRoot ?? null, screenId).not.toBeNull();
  return host!.shadowRoot!;
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/**
 * Case A's entry (M21-T14 follow-up): a design with nothing on it, in a
 * project that may or may not have an index. What is asserted is that the
 * offer is honest about this project's own state and that taking it writes
 * nothing — the steps are the model's to propose.
 */
describe("starting a foundation", () => {
  const emptyDesign = (): DesignBody => ({
    brief: "A greenfield foundation for a reading app.",
    screens: [],
    flows: [],
    sketches: [],
    fidelity: "proposed",
    fixtures: [],
  });

  const accessWith = (state: DesignIndexAccess["state"]): DesignIndexAccess => ({ state });

  async function renderEmpty(state: DesignIndexAccess["state"], over: Partial<WorkBodyContext> = {}): Promise<void> {
    const body = emptyDesign();
    await act(async () =>
      root.render(
        <LaserStoreProvider store={designStore}><TooltipProvider>
          <DesignDetail body={body} context={contextFor(body, over)} indexAccess={accessWith(state)} />
        </TooltipProvider></LaserStoreProvider>,
      ),
    );
    await settle();
  }

  it("offers it, and says this project has no index, once the index has answered", async () => {
    await renderEmpty({ kind: "absent", detail: "This project has not been indexed yet." });
    const offer = container.querySelector('[data-slot="foundation-start"]');
    expect(offer).not.toBeNull();
    expect(offer!.textContent).toContain("no design index yet");
    expect(button("Start a foundation")).toBeDefined();
  });

  /**
   * A **copy proxy**, named as one: this asserts the sentences the offer
   * shows, not what the worker discovered. "No index" is the absence of a
   * build in this project, and nothing else — only an index build reads the
   * source, so the surface must not turn an unindexed project into a claim
   * that it has no interface code.
   */
  it("never reads an absent index as an absence of interface code (copy proxy)", async () => {
    await renderEmpty({ kind: "absent", detail: "This project has not been indexed yet." });
    const said = container.querySelector('[data-slot="foundation-start"]')!.textContent ?? "";
    expect(said).toContain("no design index yet");
    for (const claim of ["no interface code", "no UI code", "no source", "greenfield", "empty project"]) {
      expect(said.toLowerCase(), `the offer must not claim “${claim}” from a missing index`).not.toContain(claim);
    }
    // It says what would answer the question instead of answering it here.
    expect(said).toContain("building the index is what answers that");
    // And the override is offered either way.
    expect(button("Start a foundation")).toBeDefined();
  });

  it("claims nothing about the project while the index is still being read", async () => {
    await renderEmpty({ kind: "loading" });
    const offer = container.querySelector('[data-slot="foundation-start"]')!;
    expect(offer.textContent).toContain("Reading this project's design system");
    expect(offer.textContent).not.toContain("no design index");
    // The action is still there: a person may start one without waiting.
    expect(button("Start a foundation")).toBeDefined();
  });

  it("says what went wrong rather than reading a failure as an empty project", async () => {
    await renderEmpty({ kind: "error", message: "The project folder is not trusted." });
    const offer = container.querySelector('[data-slot="foundation-start"]')!;
    expect(offer.textContent).toContain("The project folder is not trusted.");
    expect(offer.textContent).not.toContain("no design index");
  });

  it("keeps the override in a project that already has an index", async () => {
    await renderEmpty({ kind: "ready", index: indexFixture() });
    const offer = container.querySelector('[data-slot="foundation-start"]')!;
    expect(offer.textContent).toContain("already has a design index");
    expect(button("Start a foundation")).toBeDefined();
  });

  it("puts the request in the composer, naming this design, and writes nothing", async () => {
    const quotes: WorkQuoteDetail[] = [];
    const stop = onWorkQuote((detail) => quotes.push(detail));
    try {
      await renderEmpty({ kind: "absent", detail: "" });
      await click(button("Start a foundation"));
      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.workKey).toBe("DES-3");
      expect(quotes[0]?.text).toBe(foundationRequestFor("DES-3"));
      expect(quotes[0]?.text).toContain("@DES-3");
      expect(quotes[0]?.text).toContain("propose_foundation");
      // Nothing was sent and nothing was written: no revision, no empty
      // foundation invented to make a wizard appear.
      expect(calls).toEqual([]);
      expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("in the composer"));
    } finally {
      stop();
    }
  });

  it("does not offer it on a revision this window may not edit", async () => {
    await renderEmpty({ kind: "absent", detail: "" }, { editable: false, readOnlyReason: "This revision is read-only." });
    expect(container.querySelector('[data-slot="foundation-start"]')).not.toBeNull();
    expect(button("Start a foundation")).toBeUndefined();
  });
});

describe("DesignDetail", () => {
  it("plays the prototype: a click inside the shadow root navigates, an overlay opens, Back closes it, and it is all said aloud", async () => {
    const body = designFixture();
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={contextFor(body)} index={indexFixture()} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    await click(button("Prototype"));
    const stage = container.querySelector('[data-slot="design-prototype"]');
    expect(stage).not.toBeNull();
    expect(stage!.textContent).toContain("Invoices");

    await click(shadowOf("scr_list").querySelector('[data-node-id="n_pay"]'));
    expect(container.querySelector('[data-slot="design-prototype"] [role="status"]')?.textContent).toBe("Went to Pay an invoice.");
    expect(container.querySelector('[data-slot="design-tree-frame"][data-screen-id="scr_pay"]')).not.toBeNull();

    await click(shadowOf("scr_pay").querySelector('[data-node-id="p_confirm"]'));
    expect(container.querySelector('[data-slot="design-prototype-overlay"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="design-prototype"] [role="status"]')?.textContent).toBe("Opened Paid on top.");

    await click(shadowOf("scr_done").querySelector('[data-node-id="d_close"]'));
    expect(container.querySelector('[data-slot="design-prototype-overlay"]')).toBeNull();
    await click(button("Back"));
    expect(container.querySelector('[data-slot="design-tree-frame"][data-screen-id="scr_list"]')).not.toBeNull();

    // setState on the table: a declarative state, not a script.
    await click(shadowOf("scr_list").querySelector('[data-node-id="n_title"]'));
    expect(shadowOf("scr_list").querySelector<HTMLElement>('[data-node-id="n_table"]')?.dataset["state"]).toBe("loading");

    await click(button("Exit prototype"));
    expect(container.querySelector('[data-slot="design-prototype"]')).toBeNull();
    expect(container.querySelector('[data-slot="design-canvas"]')).not.toBeNull();
  });

  it("opens full screen as a dialog, and Esc closes it", async () => {
    const body = designFixture();
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={contextFor(body)} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    await click(button("Full screen"));
    const dialog = container.querySelector<HTMLElement>('[data-slot="design-full-screen"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.querySelector('[data-slot="design-canvas"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector('[data-slot="design-full-screen"]')).toBeNull();
    expect(container.querySelector('[data-slot="design-canvas"]')).not.toBeNull();
  });

  it("says a sketch-only design cannot be approved or handed off, and reads the sketch into its sandboxed frame", async () => {
    const body = sketchOnlyFixture();
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={contextFor(body)} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    expect(container.querySelector('[data-slot="sketch-only-notice"]')?.textContent).toBe(SKETCH_GATE_REFUSAL);
    expect(container.querySelector('[data-slot="sketch-gate-refusal"]')?.textContent).toBe(SKETCH_GATE_REFUSAL);
    await click(button("Implement"));
    expect(document.body.querySelector('[data-slot="implement-refusal"]')?.textContent).toBe(SKETCH_GATE_REFUSAL);
    expect(document.body.textContent).not.toContain(IMPLEMENT_SENTENCE);
    // The bytes were read through the blob route and rendered only in the frame.
    expect(blobRequests).toContain("project/work/blob/read:blob_sk_1");
    const frame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.getAttribute("srcdoc")).toContain("filter demo");
    expect(container.textContent).not.toContain("filter demo");
  });

  it("says why the index could not be read, and offers the hand-off rather than a dead button", async () => {
    const body = designFixture();
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={contextFor(body)} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    // This window's fixture client answers nothing but blob reads, so the
    // index read fails — and the panel says so in the host's own words rather
    // than showing an empty index.
    const panel = container.querySelector('[data-slot="design-index-panel"]');
    expect(panel?.textContent).toContain("The design index could not be read");
    // Ground it is a button now the wire exists, and the hand-off is real.
    const sketchName = [...container.querySelectorAll("button")].find((node) => node.textContent === "Filter demo");
    await click(sketchName);
    expect(container.querySelector('[data-slot="ground-pending"]')).toBeNull();
    await click(button("Implement"));
    expect(document.body.textContent).toContain(IMPLEMENT_SENTENCE);
    expect(document.body.textContent).toContain("/design implement @DES-3");
    expect(document.body.querySelector('[data-slot="implement-refusal"]')).toBeNull();
    // Without a token document, the frame says it is drawn in this app's tokens.
    expect(container.textContent).toContain("Drawn in this app's own tokens");
  });

  it("offers Ground it and the review verbs when an access is wired", async () => {
    const body = designFixture();
    const groundSketch = vi.fn(async () => ({ ok: true as const }));
    const review = vi.fn(async () => ({ ok: true as const }));
    const reindex = vi.fn(async () => ({ ok: true as const, commandId: "cmd_1" }));
    const onChanged = vi.fn();
    await act(async () =>
      root.render(
        <LaserStoreProvider store={designStore}><TooltipProvider>
          <DesignDetail
            body={body}
            context={contextFor(body, { onChanged })}
            index={indexFixture()}
            indexAccess={{ state: { kind: "ready", index: indexFixture() }, review, reindex }}
            groundSketch={groundSketch}
          />
        </TooltipProvider></LaserStoreProvider>,
      ),
    );
    await settle();
    const panel = container.querySelector('[data-slot="design-index-panel"]')!;
    expect(panel.querySelectorAll('[data-slot="design-index-entry"]')).toHaveLength(3);
    expect(panel.textContent).toContain("in this design");
    const accept = [...panel.querySelectorAll("button")].find((node) => node.textContent?.includes("Accept") && !node.disabled);
    await click(accept);
    expect(review).toHaveBeenCalledWith({ action: "accept", entryId: "e_help" });
    await click([...panel.querySelectorAll("button")].find((node) => node.textContent?.includes("Re-index")));
    expect(reindex).toHaveBeenCalled();

    await click([...container.querySelectorAll("button")].find((node) => node.textContent === "Filter demo"));
    await click(button("Ground it"));
    expect(groundSketch).toHaveBeenCalledWith("sk_1");
    expect(onChanged).toHaveBeenCalled();
  });

  /**
   * The save gate checks what this window can actually check (review F4).
   *
   * With the project's index read, a node pointing at an entry that is not in
   * it — a review merged it away, a re-index dropped it — is a problem the
   * save must see, the same vocabulary the worker validates a grounded tree
   * with. Without an index read, the kit names are all there is to check
   * against, and the window does not invent a refusal it cannot justify.
   */
  it("refuses to save a node whose index entry the index no longer has", async () => {
    const body = designFixture();
    const index = indexFixture();
    // The entry `n_help` points at was merged away by a review.
    const merged = { ...index, entries: index.entries.filter((entry) => entry.id !== "e_help") };
    const context = contextFor(body);
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={context} index={merged} /></TooltipProvider></LaserStoreProvider>));
    await settle();

    const alert = [...container.querySelectorAll('[role="alert"]')].find((node) => node.textContent?.includes("cannot be saved"));
    expect(alert?.textContent).toContain("One node has a problem");

    // Make the draft dirty, then take the save: it is refused, in a sentence,
    // and nothing is written.
    await click(shadowOf("scr_list").querySelector('[data-node-id="n_pay"]'));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="design-detail"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })),
    );
    await click(button("Save revision"));
    expect(calls.find((call) => call.method === "project/work/revise")).toBeUndefined();
    expect(toast).toHaveBeenCalledWith("error", expect.stringContaining("index entry the index no longer has"));
  });

  it("checks the same design against the index that still has the entry, and saves it", async () => {
    const body = designFixture();
    const context = contextFor(body);
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={context} index={indexFixture()} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    expect([...container.querySelectorAll('[role="alert"]')].some((node) => node.textContent?.includes("cannot be saved"))).toBe(false);
    await click(shadowOf("scr_list").querySelector('[data-node-id="n_pay"]'));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="design-detail"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })),
    );
    await click(button("Save revision"));
    expect(calls.find((call) => call.method === "project/work/revise")).toBeDefined();
  });

  it("is read-only on the phone with tap-to-inspect, and plays the prototype full screen", async () => {
    const body = designFixture();
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={contextFor(body, { compact: true })} index={indexFixture()} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    expect(container.textContent).toContain("Editing a design needs a wider window");
    expect(button("Save revision")).toBeUndefined();
    await click(shadowOf("scr_list").querySelector('[data-node-id="n_pay"]'));
    const inspector = container.querySelector('[data-slot="design-node-inspector"]');
    expect(inspector).not.toBeNull();
    expect(inspector!.textContent).toContain("Button");
    expect(inspector!.querySelector<HTMLTextAreaElement>('[aria-label="Text"]')?.disabled).toBe(true);
    await click(button("Prototype"));
    expect(container.querySelector('[data-slot="design-full-screen"] [data-slot="design-prototype"]')).not.toBeNull();
  });

  it("writes an edit through revise fenced by the revision read, and shows a conflict as a banner", async () => {
    const body = designFixture();
    const context = contextFor(body);
    await act(async () => root.render(<LaserStoreProvider store={designStore}><TooltipProvider><DesignDetail body={body} context={context} index={indexFixture()} /></TooltipProvider></LaserStoreProvider>));
    await settle();
    expect(button("Save revision")?.disabled).toBe(true);
    await click(shadowOf("scr_list").querySelector('[data-node-id="n_pay"]'));
    // Alt+ArrowRight: the keyboard form of drag-reorder.
    await act(async () => container.querySelector<HTMLElement>('[data-slot="design-detail"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })));
    expect(button("Save revision")?.disabled).toBe(false);
    await click(button("Save revision"));
    const revise = calls.find((call) => call.method === "project/work/revise");
    expect(revise?.params["expectedRevisionId"]).toBe("r1");
    const written = revise?.params["body"] as { kind: string; design: DesignBody };
    expect(written.kind).toBe("design");
    const actions = written.design.screens[0] && "tree" in written.design.screens[0].content ? written.design.screens[0].content.tree.nodes.find((n) => n.id === "n_actions") : undefined;
    expect(actions?.children).toEqual(["n_help", "n_pay"]);
    expect(context.onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("revision 2 saved"));

    reviseAnswer = "conflict";
    await act(async () => container.querySelector<HTMLElement>('[data-slot="design-detail"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    await click(button("Save revision"));
    expect(container.querySelector('[data-slot="revision-conflict"]')?.textContent).toContain("changed while you were editing");
    expect(button("Read the latest")).toBeDefined();
  });
});
