// @vitest-environment happy-dom
/**
 * Foundation mode in the window (M21-T14).
 *
 * What is asserted here is what a person would check:
 *
 * - the ten steps are on screen in the contract's order, with what each one
 *   proposed and where it came from — including the neutral note;
 * - a step is editable and the edit lands in the draft the detail saves;
 * - the samples really are drawn by the kit, skinned with the foundation's
 *   own tokens (`--design-*` on the frame's shadow root), not this app's;
 * - Approve records the Design Profile digest and then takes the decision on
 *   the design gate with the covers the host answered with — and refuses to
 *   do either while the draft is unsaved. Enter never approves;
 * - the Plan created from an approved foundation lists the foundation task
 *   first and makes everything else depend on it;
 * - once the index holds tokens, the foundation says it is superseded and
 *   shows which token names moved;
 * - a source whose licence could not be read is shown as unusable.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOUNDATION_STEPS,
  foundationCanonicalJson,
  type ClientRequests,
  type DesignBody,
  type DesignFoundation,
} from "@lasercode/protocol";

import { DesignDetail } from "../../src/components/project-work/bodies/DesignDetail.js";
import type { WorkBodyContext } from "../../src/components/project-work/bodies/context.js";
import { FOUNDATION_UNSAVED_SENTENCE } from "../../src/components/design/FoundationWizard.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { foundationProfileDigest, foundationSampleScreens, setFoundationToken, foundationTokenRows } from "../../src/design/foundation.js";

import { designDetail, indexFixture } from "./fixture.js";

const toast = vi.fn();

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({ actions: { toast }, client: undefined }),
    useCapability: () => ({ state: "available" }),
  };
});

let root: Root;
let container: HTMLDivElement;
const calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }> = [];
let nextKey = 1;

/** A foundation with every step accepted, small enough to read in a failure. */
function foundationFixture(over: Partial<DesignFoundation> = {}): DesignFoundation {
  return {
    principles: ["One colour carries meaning.", "Nothing below 12px."],
    status: "proposed",
    steps: FOUNDATION_STEPS.map((step) => ({
      id: step.id,
      state: "accepted" as const,
      source: step.id === "principles" ? ("fallback" as const) : ("model" as const),
      summary: `${step.label} summary`,
      ...(step.id === "principles" ? { note: "No model profile is connected for design work, so this is the neutral starting point." } : {}),
    })),
    tokens: {
      color: {
        bg: { $value: "#ffffff", $type: "color" },
        ink: { $value: "#111111", $type: "color" },
        accent: { $value: "#3b62d6", $type: "color" },
      },
      space: { "4": { $value: "16px", $type: "dimension" } },
    },
    modes: [{ name: "dark", tokens: { color: { bg: { $value: "#101014", $type: "color" }, ink: { $value: "#f4f4f5", $type: "color" } } } }],
    typeScale: [
      { name: "body", size: "16px", lineHeight: "24px", usage: "Everything read at length." },
      { name: "caption", size: "12px", lineHeight: "16px" },
    ],
    scales: { spacing: [{ name: "4", value: "16px" }], radius: [{ name: "md", value: "8px" }] },
    motion: { durations: [{ name: "fast", value: "140ms" }], easings: [{ name: "standard", value: "linear" }], reducedMotion: "Opacity only." },
    sources: [
      { id: "lucide", kind: "icons", name: "Lucide", version: "0.544.0", licence: { classification: "permissive", spdx: "ISC" }, recommended: true, reason: "ISC: permissive." },
      { id: "mystery", kind: "illustrations", name: "Mystery art", licence: { classification: "unknown" }, recommended: false, reason: "Mystery art declares no licence anywhere this check can read." },
    ],
    layoutRules: ["One page frame."],
    accessibility: { contrastMin: 4.5, minFontPx: 12, focusVisible: "A two-pixel ring.", rules: ["Keyboard first."] },
    components: [
      { name: "Button", purpose: "The one thing this screen wants.", variants: ["primary", "secondary"], states: ["default", "disabled"] },
      { name: "Empty", purpose: "Nothing here yet.", variants: ["first-run"] },
    ],
    ...over,
  };
}

function bodyFixture(foundation: DesignFoundation): DesignBody {
  return { brief: "A greenfield foundation for a reading app.", foundation, screens: [], flows: [], sketches: [], fidelity: "proposed", fixtures: [] };
}

type Detail = ClientRequests["project/work/get"]["result"];

/** The detail, with the design gate the host would answer with. */
function detailWithGate(body: DesignBody): Detail {
  const detail = designDetail(body);
  return {
    ...detail,
    gates: {
      specEntityId: "e_spec",
      specKey: "SPEC-1",
      gated: true,
      next: "design",
      gates: [
        {
          gate: "design",
          state: "ready",
          subject: { entityId: "e1", kind: "design", key: "DES-3", title: "Billing", revisionId: "r2", digest: "b".repeat(64), state: "draft" },
          requirements: [],
          covers: [{ entityId: "e1", kind: "design", key: "DES-3", revisionId: "r2", digest: "b".repeat(64) }],
          outcomes: [{ id: "approve", label: "Approve", decision: "approved", approves: true }],
          blockingComments: [],
        },
      ],
    },
  } as unknown as Detail;
}

function makeStore(): ProjectWorkStore {
  const request = (async (method: ProjectWorkMethod, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "project/work/revise") {
      return { ref: {}, entity: { entityId: params["entityId"], key: "DES-3" }, revision: { index: 2, revisionId: "r2", digest: "b".repeat(64) }, seq: 8 };
    }
    if (method === "project/work/create") {
      const kind = String(params["kind"]);
      const key = `${kind === "task" ? "TASK" : "PLAN"}-${String(nextKey++)}`;
      return { ref: {}, entity: { entityId: `e_${key}`, key, kind }, revision: { index: 1, revisionId: `r_${key}`, digest: "c".repeat(64) }, seq: 9 };
    }
    if (method === "project/work/approve") {
      return { approval: { gate: "design", decision: "approved" }, entity: {}, seq: 10 };
    }
    if (method === "project/work/get") {
      return detailWithGate(bodyFixture(foundationFixture()));
    }
    throw new Error(`the fixture does not answer ${method}`);
  }) as unknown as ConstructorParameters<typeof ProjectWorkStore>[0]["request"];
  return new ProjectWorkStore({ request, projectId: "p1" });
}

function contextFor(body: DesignBody, over: Partial<WorkBodyContext> = {}): WorkBodyContext {
  return { store: makeStore(), detail: detailWithGate(body), editable: true, onChanged: vi.fn(), items: [], compact: false, ...over };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  nextKey = 1;
  toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const button = (label: string): HTMLButtonElement | undefined => [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const type = async (element: Element | null | undefined, value: string): Promise<void> => {
  expect(element ?? null).not.toBeNull();
  const input = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function render(body: DesignBody, context: WorkBodyContext, index?: ReturnType<typeof indexFixture>): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <DesignDetail body={body} context={context} {...(index ? { index } : {})} />
      </TooltipProvider>,
    ),
  );
  await settle();
}

describe("the wizard", () => {
  it("shows the ten steps in the contract's order, with the state and the neutral note", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    const steps = [...container.querySelectorAll('[data-slot="foundation-step"]')].map((node) => node.getAttribute("data-step"));
    expect(steps).toEqual(FOUNDATION_STEPS.map((step) => step.id));
    expect(container.textContent).toContain("10 of 10 steps accepted");
    // The honest note is on the step it belongs to, not a footnote.
    await click(container.querySelector('[data-step="principles"]'));
    expect(container.querySelector('[data-slot="foundation-step-note"]')?.textContent).toContain("neutral starting point");
  });

  it("says the repository is untouched, on the surface", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    expect(container.querySelector('[data-slot="foundation-repository-note"]')?.textContent).toContain("until you approve it and a build implements it");
  });

  it("names a source whose licence could not be read, and refuses to recommend it", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    const blocked = container.querySelector('[data-slot="foundation-blocked-sources"]');
    expect(blocked?.textContent).toContain("Mystery art");
    expect(blocked?.textContent).toContain("declares no licence");
  });

  it("edits a step and keeps the edit in the draft the detail saves", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    await click(container.querySelector('[data-step="principles"]'));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Principle 1"]');
    await type(field, "Quiet by default.");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Principle 1"]')?.value).toBe("Quiet by default.");
    await click(button("Save revision"));
    const revise = calls.find((call) => call.method === "project/work/revise");
    const stored = (revise?.params["body"] as { design: DesignBody }).design;
    expect(stored.foundation?.principles[0]).toBe("Quiet by default.");
    // The person's edit is recorded as theirs, on that step.
    expect(stored.foundation?.steps?.find((step) => step.id === "principles")?.edited).toBe(true);
  });

  it("edits a token in the same editor Settings uses, with the contrast of the value typed", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    await click(container.querySelector('[data-step="semantic_tokens"]'));
    const editor = container.querySelector('[data-slot="foundation-token-editor"]');
    expect(editor).not.toBeNull();
    expect(editor!.textContent).toContain("color.ink");
    // #111111 on #ffffff is about 18.9:1 — the readout measures the value in
    // the field, the way Appearance does.
    expect(editor!.textContent).toMatch(/1[0-9]\.\d{2}:1/);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="color.ink value"]');
    await type(field, "#eeeeee");
    expect(container.querySelector('[data-slot="foundation-token-editor"]')?.textContent).toContain("unreadable on");
  });

  it("draws the samples with the kit, skinned by the foundation's own tokens", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    const frames = [...container.querySelectorAll<HTMLElement>('[data-slot="design-tree-frame"]')];
    expect(frames.length).toBe(3);
    expect(frames[0]!.shadowRoot).not.toBeNull();
    const kitRoot = frames[0]!.shadowRoot!.querySelector<HTMLElement>('[data-design-root="true"]');
    expect(kitRoot?.style.getPropertyValue("--design-color-accent")).toBe("#3b62d6");
    expect(kitRoot?.style.getPropertyValue("--design-color-bg")).toBe("#ffffff");
    expect(frames[0]!.shadowRoot!.textContent).toContain("Type scale");
  });
});

describe("approval", () => {
  it("refuses while the draft is unsaved, and never approves on Enter", async () => {
    const body = bodyFixture(foundationFixture());
    await render(body, contextFor(body));
    await click(container.querySelector('[data-step="principles"]'));
    await type(container.querySelector('input[aria-label="Principle 1"]'), "Changed.");
    const key = container.querySelector<HTMLInputElement>("#foundation-approve-key");
    await type(key, "DES-3");
    expect(button("Approve the foundation")?.disabled).toBe(true);
    await act(async () => {
      key!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(calls.some((call) => call.method === "project/work/approve")).toBe(false);
    expect(container.textContent).toContain(FOUNDATION_UNSAVED_SENTENCE);
  });

  it("records the Design Profile digest and takes the decision with the host's own covers", async () => {
    const foundation = foundationFixture();
    const body = bodyFixture(foundation);
    await render(body, contextFor(body));
    await type(container.querySelector("#foundation-approve-key"), "DES-3");
    await click(button("Approve the foundation"));

    const revise = calls.find((call) => call.method === "project/work/revise");
    const stored = (revise?.params["body"] as { design: DesignBody }).design;
    expect(stored.foundation?.status).toBe("approved");
    expect(stored.foundation?.profile?.version).toBe(1);
    // The digest is the protocol's canonical bytes, hashed — the same value
    // the worker would record for the same foundation.
    expect(stored.foundation?.profile?.digest).toBe(await foundationProfileDigest(foundation));

    const approve = calls.find((call) => call.method === "project/work/approve");
    expect(approve?.params["gate"]).toBe("design");
    expect(approve?.params["decision"]).toBe("approved");
    expect(approve?.params["covers"]).toEqual([{ entityId: "e1", kind: "design", key: "DES-3", revisionId: "r2", digest: "b".repeat(64) }]);
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("Foundation approved"));
  });

  it("creates the plan with the foundation task first, and everything else depending on it", async () => {
    const foundation = foundationFixture({ status: "approved", profile: { version: 1, digest: "d".repeat(64) } });
    const body = bodyFixture(foundation);
    await render(body, contextFor(body));
    await click(button("Create the plan, foundation first"));

    const created = calls.filter((call) => call.method === "project/work/create");
    expect(created[0]?.params["kind"]).toBe("task");
    expect(String(created[0]?.params["title"])).toContain("foundation");
    expect(created[1]?.params["kind"]).toBe("plan");
    const planRevise = calls.filter((call) => call.method === "project/work/revise").at(-1);
    const plan = (planRevise?.params["body"] as { plan: { phases: Array<{ id: string; taskKeys: string[] }> } }).plan;
    expect(plan.phases[0]?.id).toBe("foundation");
    expect(plan.phases[0]?.taskKeys).toEqual(["TASK-1"]);
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("TASK-1"));
  });
});

describe("once the built source is indexed", () => {
  it("says it is superseded and shows which token names moved", async () => {
    const foundation = foundationFixture({ status: "approved", profile: { version: 1, digest: "d".repeat(64) } });
    const body = bodyFixture(foundation);
    await render(body, contextFor(body), indexFixture());
    const panel = container.querySelector('[data-slot="foundation-superseded"]');
    expect(panel?.textContent).toContain("design index now reads the real source");
    // The index fixture carries `color.brand.500` and friends, not the
    // foundation's names: the diff says so by name.
    expect(panel?.textContent).toContain("the index has and this did not propose");
    expect(panel?.textContent).toContain("proposed here are not in the built source");
    // Approving something the index has superseded is not offered.
    expect(button("Approve the foundation")).toBeUndefined();
  });
});

describe("the sample screens", () => {
  it("are composed only from the kit, and carry the fidelity they really have", () => {
    const screens = foundationSampleScreens(foundationFixture());
    expect(screens.map((screen) => screen.name)).toEqual(["Type and colour", "Components", "A screen in this language"]);
    for (const screen of screens) {
      expect(screen.fidelity).toBe("proposed");
      const content = screen.content;
      expect("tree" in content).toBe(true);
      if (!("tree" in content)) continue;
      for (const node of content.tree.nodes) {
        expect("primitive" in node.component, `${screen.id}/${node.id}`).toBe(true);
        expect(node.fidelity).toBe("proposed");
      }
    }
  });

  it("writes a token without inventing names", () => {
    const foundation = foundationFixture();
    const rows = foundationTokenRows(foundation);
    const ink = rows.find((row) => row.path === "color.ink" && row.owner.kind === "base")!;
    const next = setFoundationToken(foundation, ink, "#222222");
    expect(foundationTokenRows(next).find((row) => row.path === "color.ink" && row.owner.kind === "base")?.raw).toBe("#222222");
    // A path the document does not hold changes nothing.
    expect(foundationCanonicalJson(setFoundationToken(foundation, { owner: { kind: "base" }, path: "color.invented" }, "#000"))).toBe(foundationCanonicalJson(foundation));
  });
});
