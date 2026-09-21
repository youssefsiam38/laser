/**
 * The design surface's pure model (M21-T11): the canvas maths, the prototype
 * machine, the tree edits, the token refusal, the sketch document rules and
 * the fixture generator. Everything a browser is *not* needed for.
 */
import { describe, expect, it } from "vitest";
import { SKETCH_MAX_BYTES } from "@lasercode/protocol";

import {
  applyCanvasKey,
  canvasKeyAction,
  edgeGeometry,
  fitViewport,
  frameLayout,
  layerTransform,
  pinchToViewport,
  wheelToViewport,
  zoomAt,
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_PAN_STEP,
  DEFAULT_VIEWPORT,
} from "../../src/design/canvas.js";
import { fixtureTable, generateFixture } from "../../src/design/fixtures.js";
import { KIT, kitNameForEntry } from "../../src/design/kit.js";
import { kitStyleSheet } from "../../src/design/kit-css.js";
import { applyPrototypeAction, prototypeBack, startPrototype, triggerPrototype } from "../../src/design/prototype.js";
import { sanitiseSketchTitle, sketchSrcDoc, sketchTooLargeMessage, sketchWithinBounds, SKETCH_CSP, SKETCH_SANDBOX } from "../../src/design/sketch.js";
import { frameTokens, refuseFreeValue, tokenFamilies } from "../../src/design/tokens.js";
import { counterpartScreen, nudgeNode, recomputeFidelity, reorderChild, screenOf, setNodeText, treeOf, walkTree } from "../../src/design/tree-model.js";

import { designFixture, tokensDocument } from "./fixture.js";

describe("canvas maths", () => {
  it("zooms about the point under the pointer", () => {
    const zoomed = zoomAt(DEFAULT_VIEWPORT, 2, { x: 100, y: 50 });
    expect(zoomed.scale).toBe(2);
    // The canvas point under (100, 50) was (100, 50); after the zoom it must still be there.
    expect(100 * zoomed.scale + zoomed.x).toBe(100);
    expect(50 * zoomed.scale + zoomed.y).toBe(50);
  });

  it("clamps the scale at both ends", () => {
    expect(zoomAt(DEFAULT_VIEWPORT, 100, { x: 0, y: 0 }).scale).toBe(CANVAS_MAX_SCALE);
    expect(zoomAt(DEFAULT_VIEWPORT, 0.0001, { x: 0, y: 0 }).scale).toBe(CANVAS_MIN_SCALE);
  });

  it("pans on a plain wheel and zooms on a pinch or ctrl-wheel", () => {
    const panned = wheelToViewport(DEFAULT_VIEWPORT, { deltaX: 10, deltaY: 20, ctrlKey: false }, { x: 0, y: 0 });
    expect(panned).toEqual({ x: -10, y: -20, scale: 1 });
    const pinched = wheelToViewport(DEFAULT_VIEWPORT, { deltaX: 0, deltaY: -100, ctrlKey: true }, { x: 0, y: 0 });
    expect(pinched.scale).toBeGreaterThan(1);
    expect(pinchToViewport(DEFAULT_VIEWPORT, 100, 200, { x: 0, y: 0 }).scale).toBe(2);
  });

  it("maps the keyboard: arrows pan, plus and minus zoom, 0 fits, 1 resets, and rtl swaps the arrows", () => {
    expect(canvasKeyAction({ key: "ArrowLeft" })).toEqual({ type: "pan", dx: CANVAS_PAN_STEP, dy: 0 });
    expect(canvasKeyAction({ key: "ArrowLeft" }, "rtl")).toEqual({ type: "pan", dx: -CANVAS_PAN_STEP, dy: 0 });
    expect(canvasKeyAction({ key: "ArrowRight" }, "rtl")).toEqual({ type: "pan", dx: CANVAS_PAN_STEP, dy: 0 });
    expect(canvasKeyAction({ key: "ArrowUp", shiftKey: true })).toEqual({ type: "pan", dx: 0, dy: CANVAS_PAN_STEP * 3 });
    expect(canvasKeyAction({ key: "+" })?.type).toBe("zoom");
    expect(canvasKeyAction({ key: "-" })?.type).toBe("zoom");
    expect(canvasKeyAction({ key: "0" })).toEqual({ type: "fit" });
    expect(canvasKeyAction({ key: "1" })).toEqual({ type: "reset" });
    expect(canvasKeyAction({ key: "a" })).toBeUndefined();
    // A modifier the app owns (Alt+Arrow reorders a node) is not a pan.
    expect(canvasKeyAction({ key: "ArrowLeft", altKey: true })).toBeUndefined();
    const reset = applyCanvasKey({ x: 5, y: 5, scale: 2 }, { type: "reset" }, { x: 0, y: 0 });
    expect(reset.scale).toBe(1);
  });

  it("lays frames out in reading order and fits them all into a container", () => {
    const body = designFixture();
    const boxes = frameLayout(body.screens, 3);
    expect(boxes.map((box) => box.screenId)).toEqual(body.screens.map((screen) => screen.id));
    expect(boxes[1]?.x).toBeGreaterThan(boxes[0]?.x ?? 0);
    expect(boxes[3]?.y).toBeGreaterThan(boxes[0]?.y ?? 0); // the fourth wraps to a second row.
    const fit = fitViewport(boxes, { width: 800, height: 600 });
    expect(fit.scale).toBeLessThan(1);
    expect(fit.scale).toBeGreaterThanOrEqual(CANVAS_MIN_SCALE);
    expect(layerTransform(fit)).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+\)$/);
  });

  it("draws an edge between two frames and a loop back to the same frame", () => {
    const body = designFixture();
    const boxes = frameLayout(body.screens);
    const edge = edgeGeometry(body.flows[0]!, boxes);
    expect(edge).toMatchObject({ from: "scr_list", to: "scr_pay", kind: "navigate", trigger: "click" });
    expect(edge?.path.startsWith("M ")).toBe(true);
    const loop = edgeGeometry({ id: "f_self", fromScreenId: "scr_list", trigger: "click", action: { type: "navigate", screenId: "scr_list" } }, boxes);
    expect(loop?.path).toContain("C ");
    expect(edgeGeometry(body.flows[2]!, boxes)).toBeUndefined(); // `close` draws no edge.
  });
});

describe("the prototype machine", () => {
  const body = designFixture();

  it("plays navigate, overlay, close, setState, setVariant, switchTheme and switchViewport", () => {
    let state = startPrototype(body);
    expect(state.screenId).toBe("scr_list");
    state = applyPrototypeAction(state, { type: "navigate", screenId: "scr_pay" }, body);
    expect(state.screenId).toBe("scr_pay");
    expect(state.history).toEqual(["scr_list"]);
    expect(state.last?.said).toBe("Went to Pay an invoice.");
    state = applyPrototypeAction(state, { type: "overlay", screenId: "scr_done" }, body);
    expect(state.overlayScreenId).toBe("scr_done");
    state = applyPrototypeAction(state, { type: "close" }, body);
    expect(state.overlayScreenId).toBeUndefined();
    expect(state.screenId).toBe("scr_pay");
    state = applyPrototypeAction(state, { type: "close" }, body);
    expect(state.screenId).toBe("scr_list");
    expect(state.history).toEqual([]);
    state = applyPrototypeAction(state, { type: "setState", nodeId: "n_table", state: "loading" }, body);
    expect(state.nodeStates["n_table"]).toBe("loading");
    state = applyPrototypeAction(state, { type: "setVariant", nodeId: "n_pay", variant: "ghost" }, body);
    expect(state.nodeVariants["n_pay"]).toBe("ghost");
    state = applyPrototypeAction(state, { type: "switchTheme", theme: "dark" }, body);
    expect(state.theme).toBe("dark");
    state = applyPrototypeAction(state, { type: "switchViewport", viewport: "phone" }, body);
    expect(state.viewport).toBe("phone");
  });

  it("ignores an action that names a screen the design does not have", () => {
    const state = startPrototype(body);
    expect(applyPrototypeAction(state, { type: "navigate", screenId: "scr_missing" }, body)).toBe(state);
  });

  it("fires the flows wired to a node, and only on the screen it is on", () => {
    const start = startPrototype(body);
    const after = triggerPrototype(start, body, { nodeId: "n_pay", trigger: "click" });
    expect(after.screenId).toBe("scr_pay");
    // On the pay screen, n_pay no longer exists: the same tap does nothing.
    expect(triggerPrototype(after, body, { nodeId: "n_pay", trigger: "click" })).toBe(after);
    // Back is `close` without an overlay.
    expect(prototypeBack(after).screenId).toBe("scr_list");
  });
});

describe("tree edits", () => {
  const body = designFixture();

  it("reorders a child inside its container and nudges by one", () => {
    const moved = reorderChild(body, "scr_list", "n_root", 0, 2);
    expect(treeOf(screenOf(moved, "scr_list"))?.nodes[0]?.children).toEqual(["n_table", "n_actions", "n_title"]);
    const nudged = nudgeNode(body, "scr_list", "n_pay", 1);
    expect(treeOf(screenOf(nudged, "scr_list"))?.nodes.find((n) => n.id === "n_actions")?.children).toEqual(["n_help", "n_pay"]);
    // Out of range is a no-op, never a throw.
    expect(nudgeNode(body, "scr_list", "n_title", -1)).toEqual(body);
    // Ids never move.
    expect(treeOf(screenOf(moved, "scr_list"))?.nodes.map((n) => n.id)).toEqual(treeOf(screenOf(body, "scr_list"))?.nodes.map((n) => n.id));
  });

  it("edits text and re-derives fidelity from the nodes underneath", () => {
    const edited = setNodeText(body, "scr_list", "n_title", "Your invoices");
    expect(treeOf(screenOf(edited, "scr_list"))?.nodes.find((n) => n.id === "n_title")?.text).toBe("Your invoices");
    const fixed = recomputeFidelity({ ...body, screens: body.screens.map((screen) => (screen.id === "scr_pay" ? { ...screen, fidelity: "mapped" } : screen)) });
    expect(screenOf(fixed, "scr_pay")?.fidelity).toBe("proposed");
    expect(fixed.fidelity).toBe("sketch"); // the sketch screen is the least grounded.
  });

  it("walks depth-first and finds the sketch a grounded tree came from", () => {
    expect(walkTree(treeOf(screenOf(body, "scr_list"))!).map((n) => n.id)).toEqual(["n_root", "n_title", "n_table", "n_actions", "n_pay", "n_help"]);
    expect(counterpartScreen(body, screenOf(body, "scr_sketch"))).toBeUndefined();
    const grounded = { ...body, sketches: body.sketches.map((sketch) => ({ ...sketch, groundedIntoScreenId: "scr_list" })) };
    expect(counterpartScreen(grounded, screenOf(grounded, "scr_sketch"))?.id).toBe("scr_list");
    expect(counterpartScreen(grounded, screenOf(grounded, "scr_list"))?.id).toBe("scr_sketch");
  });
});

describe("tokens", () => {
  const tokens = frameTokens(tokensDocument());

  it("flattens the index document to --design-* properties and groups by family", () => {
    expect(tokens.properties["--design-color-brand-500"]).toBe("#1f2937");
    expect(tokens.properties["--design-color-action-base"]).toBe("var(--design-color-brand-500)");
    expect(tokenFamilies(tokens.tokens).map((group) => group.family)).toEqual(["color", "radius", "space"]);
  });

  it("refuses a free value with the nearest token, and takes a token id", () => {
    const refused = refuseFreeValue("#1f2938", tokens.tokens);
    expect(refused?.suggestion?.path).toBe("color.brand.500");
    expect(refused?.message).toContain("design system");
    expect(refuseFreeValue("10px", tokens.tokens)?.suggestion?.path).toBe("space.sm");
    expect(refuseFreeValue("color.brand.500", tokens.tokens)).toBeUndefined();
    expect(refuseFreeValue("", tokens.tokens)).toBeUndefined();
    expect(refuseFreeValue("#123456", [])?.message).toContain("no reviewed token document");
  });
});

describe("the kit", () => {
  it("names every primitive the contract lists, each with its label and purpose", () => {
    const names = KIT.map((primitive) => primitive.name);
    for (const required of ["button", "input", "select", "checkbox", "card", "dialog", "toast", "nav", "table", "empty", "error", "loading", "text", "image", "stack", "grid"]) {
      expect(names, required).toContain(required);
    }
    for (const primitive of KIT) {
      expect(primitive.label.length).toBeGreaterThan(0);
      expect(primitive.purpose.length).toBeGreaterThan(0);
    }
  });

  it("is skinned only by custom properties: no hex, no raw font size, no raw duration", () => {
    const css = kitStyleSheet();
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/font-size:\s*\d/);
    expect(css).not.toMatch(/transition:[^;]*\d+ms/);
    // Every `var(--design-…)` carries a fallback, so an unskinned frame is still designed.
    for (const match of css.matchAll(/var\(--design-[a-z0-9-]+\)/g)) {
      expect.fail(`${match[0]} has no fallback`);
    }
    expect(css).toContain("var(--text-xs)");
    expect(css).not.toContain("11px");
  });

  it("maps an index entry to the closest kit primitive by name", () => {
    expect(kitNameForEntry("PrimaryButton")).toBe("button");
    expect(kitNameForEntry("SearchField")).toBe("input");
    expect(kitNameForEntry("DataTable")).toBe("table");
    expect(kitNameForEntry("Whatever")).toBe("card");
    expect(kitNameForEntry("Whatever", { primitive: "nav" })).toBe("nav");
  });
});

describe("the sketch document", () => {
  it("names the sandbox exactly and a policy with no external loads", () => {
    expect(SKETCH_SANDBOX).toBe("allow-scripts");
    expect(SKETCH_SANDBOX).not.toContain("allow-same-origin");
    expect(SKETCH_CSP).toContain("default-src 'none'");
    expect(SKETCH_CSP).toContain("connect-src 'none'");
    expect(SKETCH_CSP).not.toMatch(/https?:/);
  });

  it("injects the policy first in the head, whatever shape the document has", () => {
    const meta = `<meta http-equiv="Content-Security-Policy"`;
    const full = sketchSrcDoc("<!doctype html><html><head><title>x</title><script src=\"https://evil\"></script></head><body></body></html>");
    expect(full.indexOf(meta)).toBeLessThan(full.indexOf("<title>"));
    expect(full.indexOf(meta)).toBeLessThan(full.indexOf("<script"));
    const noHead = sketchSrcDoc("<html><body>hi</body></html>");
    expect(noHead.indexOf(meta)).toBeLessThan(noHead.indexOf("<body>"));
    const fragment = sketchSrcDoc("<div>hi</div>");
    expect(fragment.startsWith("<head>")).toBe(true);
    expect(fragment).toContain("<div>hi</div>");
  });

  it("sanitises the title and bounds the size", () => {
    expect(sanitiseSketchTitle("Filter <b>demo</b>\u0000")).toBe("Filter demo");
    expect(sanitiseSketchTitle("   ")).toBe("Untitled sketch");
    expect(sanitiseSketchTitle("x".repeat(300)).length).toBe(120);
    expect(sketchWithinBounds(SKETCH_MAX_BYTES)).toBe(true);
    expect(sketchWithinBounds(SKETCH_MAX_BYTES + 1)).toBe(false);
    expect(sketchTooLargeMessage(SKETCH_MAX_BYTES * 2)).toContain("over the");
  });
});

describe("fixtures", () => {
  it("generates the same rows for the same fixture, labelled as generated", () => {
    const one = generateFixture("fx_1", "Invoices", 4);
    const two = generateFixture("fx_1", "Invoices", 4);
    expect(one).toEqual(two);
    expect(one.generated).toBe(true);
    expect(one.rows).toHaveLength(4);
    expect(generateFixture("fx_2", "Members", 4)).not.toEqual(one);
  });

  it("prefers rows that were read over rows that were generated", () => {
    const body = designFixture();
    const supplied = { fx_invoices: { columns: ["Number"], rows: [["INV-1"]], generated: false } };
    expect(fixtureTable(body, "fx_invoices", supplied)?.rows).toEqual([["INV-1"]]);
    expect(fixtureTable(body, "fx_invoices", undefined)?.generated).toBe(true);
    expect(fixtureTable(body, "fx_missing", undefined)).toBeUndefined();
  });
});
