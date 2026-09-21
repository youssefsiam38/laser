// @vitest-environment happy-dom
/**
 * The DOM infinite canvas (M21-T11, `docs/design-phase.md`).
 *
 * One transformed layer, frames laid out on it, SVG edges under them, and a
 * keyboard that can move it: what is asserted here is the accessible half
 * — the canvas is a focusable, labelled group whose help text names the
 * keys, arrows pan the layer, plus and minus zoom it — plus the edges the
 * flows draw and the frames each screen gets.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesignCanvas } from "../../src/components/design/DesignCanvas.js";
import type { KitRenderContext } from "../../src/components/design/kit/KitNode.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { screenOf } from "../../src/design/tree-model.js";

import { designFixture } from "./fixture.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const body = designFixture();
const contextFor = (screenId: string): KitRenderContext => ({ body, screen: screenOf(body, screenId)!, mode: "edit", nodeStates: {}, nodeVariants: {} });

const canvas = (): HTMLElement => container.querySelector<HTMLElement>('[aria-label="Design canvas"]')!;
const layer = (): HTMLElement => container.querySelector<HTMLElement>('[data-slot="design-canvas-layer"]')!;
const transform = (): string => layer().dataset["transform"] ?? "";

const key = async (name: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => canvas().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init })));
};

describe("DesignCanvas", () => {
  it("is a focusable, labelled group with its keys written down, one frame per screen and one edge per navigable flow", async () => {
    await act(async () => root.render(<TooltipProvider><DesignCanvas body={body} tokenProperties={{}} contextFor={contextFor} /></TooltipProvider>));
    const group = canvas();
    expect(group.getAttribute("role")).toBe("group");
    expect(group.tabIndex).toBe(0);
    const help = document.getElementById(group.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toContain("arrows pan");
    expect(container.querySelectorAll('[data-slot="design-screen-frame"]')).toHaveLength(4);
    // navigate + overlay draw edges; `close` and `setState` do not.
    const edges = [...container.querySelectorAll<SVGGElement>('[data-slot="design-flow-edge"]')];
    expect(edges.map((edge) => edge.dataset["kind"])).toEqual(["navigate", "overlay"]);
    expect(edges[1]?.querySelector("path")?.getAttribute("stroke-dasharray")).toBe("6 6");
    expect(container.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
  });

  it("pans with the arrows and zooms with plus and minus, from the keyboard alone", async () => {
    await act(async () => root.render(<TooltipProvider><DesignCanvas body={body} tokenProperties={{}} contextFor={contextFor} /></TooltipProvider>));
    const before = transform();
    await key("ArrowRight");
    const panned = transform();
    expect(panned).not.toBe(before);
    expect(panned).toMatch(/translate\(-80px, 0px\)/);
    await key("ArrowDown");
    expect(transform()).toMatch(/translate\(-80px, -80px\)/);
    await key("+");
    expect(transform()).toMatch(/scale\(1\.2\)/);
    await key("-");
    expect(transform()).toMatch(/scale\(1\)/);
    await key("1");
    expect(transform()).toMatch(/scale\(1\)/);
    // A key the canvas does not own is left alone.
    await key("a");
    expect(transform()).toMatch(/scale\(1\)/);
  });

  it("marks the selected frame, reports a screen click and offers Full screen when asked", async () => {
    const onSelectScreen = vi.fn();
    const onOpenFullScreen = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <DesignCanvas body={body} tokenProperties={{}} contextFor={contextFor} selectedScreenId="scr_pay" onSelectScreen={onSelectScreen} onOpenFullScreen={onOpenFullScreen} />
        </TooltipProvider>,
      ),
    );
    const frames = [...container.querySelectorAll<HTMLElement>('[data-slot="design-screen-frame"]')];
    expect(frames.find((frame) => frame.dataset["screenId"] === "scr_pay")?.dataset["selected"]).toBe("true");
    expect(frames.find((frame) => frame.dataset["screenId"] === "scr_list")?.dataset["selected"]).toBeUndefined();
    const name = [...container.querySelectorAll("button")].find((button) => button.textContent === "Invoices");
    await act(async () => name!.click());
    expect(onSelectScreen).toHaveBeenCalledWith("scr_list");
    const full = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Full screen"));
    await act(async () => full!.click());
    expect(onOpenFullScreen).toHaveBeenCalled();
  });

  it("shows each frame's fidelity, its unreviewed count and the Sketch chip", async () => {
    await act(async () => root.render(<TooltipProvider><DesignCanvas body={body} tokenProperties={{}} contextFor={contextFor} /></TooltipProvider>));
    const frames = [...container.querySelectorAll<HTMLElement>('[data-slot="design-screen-frame"]')];
    const list = frames.find((frame) => frame.dataset["screenId"] === "scr_list")!;
    expect(list.dataset["fidelity"]).toBe("mapped");
    expect(list.textContent).toContain("1 unreviewed");
    expect(frames.find((frame) => frame.dataset["screenId"] === "scr_pay")?.dataset["fidelity"]).toBe("proposed");
    const sketch = frames.find((frame) => frame.dataset["screenId"] === "scr_sketch")!;
    expect(sketch.dataset["fidelity"]).toBe("sketch");
    expect(sketch.querySelector('[data-slot="design-sketch-frame"]')).not.toBeNull();
    expect(sketch.querySelector("iframe")).toBeNull(); // no bytes yet: no frame, and it says so.
    expect(sketch.textContent).toContain("Nothing to draw yet");
  });
});
