// @vitest-environment happy-dom
/**
 * Research: the question tree, the findings beside it, and the two things a
 * person can do with one finding (M21-T7, `docs/research-phase.md`).
 *
 * What is asserted is what the contract promises a reader: every finding says
 * how confident it is *and why that word was chosen*, under which licence,
 * from which kind of source and how trusted; the excerpt is verbatim with the
 * cited span marked; `[from …]` rides with it; Quote carries all of that into
 * the composer; Open source goes to the canonical address and nowhere else.
 * Findings themselves are read-only here — they are written by the research
 * loop (M21-T17/T26) — and the empty state says so instead of pretending.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResearchDetail } from "../../src/components/project-work/bodies/ResearchDetail.js";
import { WORK_QUOTE_EVENT, type WorkQuoteDetail } from "../../src/components/project-work/quote.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import type { ResearchBody } from "@lasercode/protocol";

import { bodyPage, detailFixture, researchFixture } from "./bodies-fixture.js";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

let root: Root;
let container: HTMLDivElement;

const text = (): string => document.body.textContent ?? "";
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];
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

const editCode = async (label: string, value: string): Promise<void> => {
  let editor: HTMLElement | null = null;
  for (let attempt = 0; attempt < 40 && !editor; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    editor = document.body.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  }
  expect(editor).not.toBeNull();
  await act(async () => {
    const view = EditorView.findFromDOM(editor!);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
};

const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "project/work/list") {
      return { projectId: "p1", seq: 7, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
    }
    if (method === "project/work/revise") {
      return {
        ref: { projectId: "p1", kind: "research", entityId: "e1", revisionId: "r2", digest: "c".repeat(64), label: "RES-7", key: "RES-7" },
        entity: {},
        revision: { index: 2, revisionId: "r2" },
        seq: 8,
      };
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

const detail = () =>
  detailFixture({ kind: "research", number: 7, body: bodyPage({ kind: "research", research: researchFixture() }) });

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

async function mount(body: ResearchBody = researchFixture(), editable = true): Promise<ProjectWorkStore> {
  const store = makeStore();
  await store.open();
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ResearchDetail body={body} context={{ store, detail: detail(), editable, onChanged: () => {}, items: [] }} />
      </TooltipProvider>,
    ),
  );
  await act(async () => {});
  return store;
}

describe("the research detail", () => {
  it("shows the question tree with each state, and the findings for the one that is open", async () => {
    await mount();

    const tree = query('[data-slot="research-report"]');
    expect(tree).not.toBeNull();
    const rows = all('[data-slot="research-report"] [role="list"] > li');
    expect(rows).toHaveLength(3);
    expect(tree?.textContent).toContain("Does the loader wait for the frame?");
    expect(tree?.textContent).toContain("Answered");
    expect(tree?.textContent).toContain("Handed to you");
    // The first question is selected, so its one finding is beside the tree —
    // and the finding no question cites yet is shown separately, never hidden.
    expect(all('[data-slot="question-findings"] [data-slot="research-finding"]')).toHaveLength(1);
    expect(text()).toContain("Findings no question cites yet");
    // Standalone: no `supports` edge, and that is complete, not pending.
    expect(text()).toContain("Standalone");
    expect(text()).toContain("2 sources · 2 findings · 1/3 questions settled");
  });

  it("carries each finding's confidence, licence, source kind and trust", async () => {
    await mount();
    const finding = query('[data-slot="question-findings"] [data-slot="research-finding"]');
    expect(query('[data-slot="finding-confidence"]')?.textContent).toBe("declared");
    expect(query('[data-slot="finding-licence"]')?.textContent).toBe("permissive");
    expect(finding?.textContent).toContain("web");
    expect(finding?.textContent).toContain("official");
    expect(query('[data-slot="finding-provenance"]')?.textContent).toBe("[from https://example.org/docs/loader]");
  });

  it("marks the span of the excerpt the claim actually quotes", async () => {
    await mount();
    const excerpt = query('[data-slot="finding-excerpt"]');
    expect(excerpt?.textContent).toBe("The loader waits for the frame to settle before it paints, and only then reports readiness.");
    const mark = query('[data-slot="cited-span"]');
    expect(mark?.tagName).toBe("MARK");
    expect(mark?.textContent).toBe("waits for the frame to settle");
    // The excerpt is text, never markup: nothing from a source is rendered as HTML.
    expect(excerpt?.querySelector("script, iframe, a")).toBeNull();
  });

  it("says plainly that findings are recorded by the research loop when there are none", async () => {
    await mount();
    const handed = [...document.body.querySelectorAll<HTMLElement>('[data-slot="research-report"] button')].find((node) =>
      node.textContent?.includes("What does the licence allow?"),
    );
    await click(handed);
    expect(all('[data-slot="question-findings"] [data-slot="research-finding"]')).toHaveLength(0);
    expect(text()).toContain("No findings yet — the research loop records them");
  });

  it("quotes a finding into the composer with its provenance, and opens its source", async () => {
    await mount();
    const quotes: WorkQuoteDetail[] = [];
    const listener = (event: Event): void => void quotes.push((event as CustomEvent<WorkQuoteDetail>).detail);
    window.addEventListener(WORK_QUOTE_EVENT, listener);
    await click(button("Quote"));
    window.removeEventListener(WORK_QUOTE_EVENT, listener);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.workKey).toBe("RES-7");
    expect(quotes[0]?.text).toContain("> The loader waits for the frame to settle");
    expect(quotes[0]?.text).toContain("[from https://example.org/docs/loader]");
    expect(quotes[0]?.text).toContain("declared");

    const open = [...document.body.querySelectorAll<HTMLAnchorElement>("a")].find((node) => node.textContent?.includes("Open source"));
    expect(open?.getAttribute("href")).toBe("https://example.org/docs/loader");
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders the option matrix and what is still unresolved", async () => {
    await mount();
    expect(text()).toContain("widget");
    expect(text()).toContain("recommended");
    expect(text()).toContain("a proposal until a spec or a design revision adopts it");
    expect(text()).toContain("Whether it renders CJK");
    expect(text()).toContain("Would settle it: Rendering one CJK document");
  });

  it("lets a person hand a question over, as a new revision", async () => {
    await mount();
    await click(button("Hand it to me"));
    const field = query<HTMLTextAreaElement>("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "I decide the licence policy.");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save as a new revision"));

    const revise = calls.find((call) => call.method === "project/work/revise");
    expect(revise?.params.expectedRevisionId).toBe("r1");
    const body = revise?.params.body as { kind: string; research: ResearchBody };
    expect(body.kind).toBe("research");
    expect(body.research.questions[0]?.state).toBe("handed_to_person");
    expect(body.research.questions[0]?.answer).toBe("I decide the licence policy.");
    // Findings are untouched: this window never writes one.
    expect(body.research.findings).toHaveLength(2);
  });

  it("adds a question to the tree without touching anything else", async () => {
    await mount();
    const field = query<HTMLInputElement>("#add-question");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "Does it stream?");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Add"));
    const body = calls.find((call) => call.method === "project/work/revise")?.params.body as { research: ResearchBody };
    expect(body.research.questions).toHaveLength(4);
    expect(body.research.questions.at(-1)?.text).toBe("Does it stream?");
    expect(body.research.questions.at(-1)?.state).toBe("open");
  });

  it("reframes the stable root without replacing research records", async () => {
    const original = researchFixture();
    await mount(original);
    await click(button("Edit framing"));
    await editCode("Question", "Which **loader** should we adopt?");
    await click(button("Preview"));
    expect(query("[data-slot='markdown-document'] strong")?.textContent).toBe("loader");
    expect(calls.some((call) => call.method === "project/work/revise")).toBe(false);
    await click(button("Cancel"));
    expect(text()).toContain(original.question);
    expect(text()).not.toContain("Which loader should we adopt?");
    await click(button("Edit framing"));
    await editCode("Question", "Which **loader** should we adopt?");
    await click(button("Save as a new revision"));

    const written = calls.find((call) => call.method === "project/work/revise")?.params.body as { research: ResearchBody };
    expect(written.research.question).toBe("Which **loader** should we adopt?");
    expect(written.research.questions[0]).toMatchObject({ id: "q1", text: "Which **loader** should we adopt?" });
    expect(written.research.findings).toEqual(original.findings);
    expect(written.research.sources).toEqual(original.sources);
    expect(written.research.options).toEqual(original.options);
    expect(written.research.unresolved).toEqual(original.unresolved);
  });

  it("offers no writes at all on a revision that is being read, not edited", async () => {
    await mount(researchFixture(), false);
    expect(button("Hand it to me")).toBeUndefined();
    expect(query("#add-question")).toBeNull();
    // The evidence is still all there to read.
    expect(all('[data-slot="research-finding"]').length).toBeGreaterThan(0);
  });
});
