/**
 * Ground it (M21-T13, `docs/design-phase.md` "Sketch", D-354).
 *
 * The sketch is untrusted text and the tree is the product of reading it, so
 * what is proven here is the contract's own list: what maps is Mapped and
 * names an index entry, what does not is Proposed and is *listed*, the logic
 * becomes states rather than script, nothing executable survives, and the
 * result is a tree the renderer would accept.
 */
import { describe, expect, it } from "vitest";
import { validateDesignBody, DESIGN_KIT_PRIMITIVES, type DesignIndex } from "@lasercode/protocol";
import { groundSketch } from "../../src/design/sketch/ground.js";

function indexWith(components: Array<{ id: string; name: string; reviewed?: boolean }>): DesignIndex {
  return {
    indexId: "idx_1",
    stack: { frameworks: ["react"], styling: ["tailwind"] },
    eras: [{ id: "era_current", name: "current react", roots: ["src"], useForNewWork: true }],
    entries: components.map((component) => ({
      id: component.id,
      kind: "component" as const,
      name: component.name,
      eraId: "era_current",
      sources: [{ path: `src/${component.name}.tsx` }],
      confidence: "declared" as const,
      review: { state: component.reviewed === false ? ("unreviewed" as const) : ("accepted" as const) },
    })),
    gaps: [],
    builtAt: "2026-01-01T00:00:00.000Z",
  };
}

const SKETCH = `<!doctype html>
<html><head><style>.btn{background:#3355ff}</style></head>
<body>
  <main class="page">
    <h1>Orders</h1>
    <p class="lede">Everything waiting on you.</p>
    <button class="btn">Refresh</button>
    <canvas id="sparkline"></canvas>
  </main>
  <script>
    const rows = data.filter((row) => row.open);
    document.querySelector('.btn').addEventListener('click', () => render(rows.sort()));
  </script>
</body></html>`;

describe("grounding a sketch", () => {
  it("maps what the index knows and proposes what it does not", () => {
    const result = groundSketch({ document: SKETCH, index: indexWith([{ id: "e_button", name: "Button" }]) });
    const nodes = "tree" in result.screen.content ? result.screen.content.tree.nodes : [];
    const mapped = nodes.filter((node) => "indexEntryId" in node.component);
    expect(mapped.map((node) => ("indexEntryId" in node.component ? node.component.indexEntryId : ""))).toContain("e_button");
    expect(mapped.every((node) => node.fidelity === "mapped")).toBe(true);
    expect(result.usedEntryIds).toEqual(["e_button"]);
    // Everything else is drawn with the kit and said to be proposed.
    expect(nodes.filter((node) => "primitive" in node.component).every((node) => node.fidelity === "proposed")).toBe(true);
    expect(result.unmapped.some((part) => part.what === "<canvas>")).toBe(true);
    expect(result.screen.fidelity).toBe("proposed");
  });

  it("marks a node composed from an unreviewed entry as unreviewed", () => {
    const result = groundSketch({ document: "<button class='btn'>Go</button>", index: indexWith([{ id: "e_button", name: "btn", reviewed: false }]) });
    const nodes = "tree" in result.screen.content ? result.screen.content.tree.nodes : [];
    expect(nodes.some((node) => node.unreviewed === true)).toBe(true);
  });

  it("records the sketch's logic as states, and keeps no script", () => {
    const result = groundSketch({ document: SKETCH, index: indexWith([]) });
    const filtered = result.states.find((state) => state.name === "filtered");
    const sorted = result.states.find((state) => state.name === "sorted");
    expect(filtered?.included).toBe(false);
    expect(filtered?.skipReason).toMatch(/filter/i);
    expect(sorted?.included).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("addEventListener");
    expect(serialized).not.toContain("querySelector");
    expect(serialized).not.toContain("<script");
  });

  it("lists a literal colour as unmapped rather than carrying it into the tree", () => {
    const result = groundSketch({ document: SKETCH, index: indexWith([]) });
    expect(result.unmapped.some((part) => part.what === "#3355ff")).toBe(true);
    expect(JSON.stringify("tree" in result.screen.content ? result.screen.content.tree : {})).not.toContain("#3355ff");
  });

  it("keeps text as text and never as markup", () => {
    const result = groundSketch({ document: "<div><p>Hello <b>you</b></p><img src='javascript:alert(1)'></div>", index: indexWith([]) });
    const nodes = "tree" in result.screen.content ? result.screen.content.tree.nodes : [];
    expect(nodes.some((node) => node.text === "Hello")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("javascript:");
  });

  it("produces a tree the validator accepts", () => {
    const result = groundSketch({ document: SKETCH, index: indexWith([{ id: "e_button", name: "Button" }]) });
    const validation = validateDesignBody(
      { brief: "b", screens: [result.screen], flows: [], sketches: [], fidelity: result.screen.fidelity, fixtures: [] },
      { primitives: DESIGN_KIT_PRIMITIVES, entryIds: ["e_button"] },
    );
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("says plainly when a project has no index, instead of claiming Mapped", () => {
    const result = groundSketch({ document: "<main><h1>Hi</h1></main>" });
    const nodes = "tree" in result.screen.content ? result.screen.content.tree.nodes : [];
    expect(nodes.every((node) => node.fidelity === "proposed")).toBe(true);
    expect(result.notes.join(" ")).toMatch(/no design index/i);
  });

  it("stops at its node budget and says the rest is not in the tree", () => {
    const big = `<main>${"<p>row</p>".repeat(600)}</main>`;
    const result = groundSketch({ document: big, index: indexWith([]) });
    const nodes = "tree" in result.screen.content ? result.screen.content.tree.nodes : [];
    expect(nodes.length).toBeLessThanOrEqual(402);
    expect(result.notes.join(" ")).toMatch(/stopped there/i);
  });

  it("is deterministic: the same sketch grounds the same way twice", () => {
    const index = indexWith([{ id: "e_button", name: "Button" }]);
    const first = groundSketch({ document: SKETCH, index, screenId: "gsfixed" });
    const second = groundSketch({ document: SKETCH, index, screenId: "gsfixed" });
    expect(second).toEqual(first);
  });
});
