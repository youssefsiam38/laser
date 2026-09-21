// @vitest-environment happy-dom
/**
 * The sandboxed Sketch frame (D-354, M21-T11).
 *
 * The one place model-written markup renders, so the attributes are asserted
 * to the letter: `srcdoc` and never `src`, `sandbox` exactly `allow-scripts`
 * (no `allow-same-origin`, no `allow-top-navigation`, nothing else), the CSP
 * meta ahead of anything that could load, a sanitised title outside the frame,
 * and a refusal instead of a frame when the sketch is over its ceiling.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKETCH_MAX_BYTES } from "@lasercode/protocol";

import { SketchFrame } from "../../src/components/design/SketchFrame.js";

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

const sketch = () => designFixture().sketches[0]!;
const HTML = "<!doctype html><html><head><title>demo</title><script>document.body.textContent='hi'</script></head><body></body></html>";

describe("SketchFrame", () => {
  it("renders only through srcdoc with sandbox exactly allow-scripts and a CSP that forbids every external load", async () => {
    await act(async () => root.render(<SketchFrame sketch={sketch()} document={HTML} />));
    const frame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame!.hasAttribute("src")).toBe(false);
    expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = frame!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`);
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<script"));
    expect(srcdoc).toContain("connect-src 'none'");
    // The document's own bytes are inside the frame and nowhere else.
    expect(container.textContent).not.toContain("document.body.textContent");
  });

  it("shows the title sanitised, never as markup", async () => {
    await act(async () => root.render(<SketchFrame sketch={sketch()} document={HTML} />));
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("Filter demo bold");
    expect(container.querySelector("iframe")?.getAttribute("title")).toBe("Filter demo bold");
  });

  it("refuses a sketch over the ceiling instead of drawing a frame", async () => {
    await act(async () => root.render(<SketchFrame sketch={{ ...sketch(), bytes: SKETCH_MAX_BYTES + 1 }} document={HTML} />));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("too large");
  });

  it("has a loading, an error and a not-yet-here state, none of them a frame", async () => {
    await act(async () => root.render(<SketchFrame sketch={sketch()} document={undefined} loading />));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Opening the sketch");
    await act(async () => root.render(<SketchFrame sketch={sketch()} document={undefined} error="The blob was released." />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The blob was released.");
    await act(async () => root.render(<SketchFrame sketch={sketch()} document={undefined} />));
    expect(container.textContent).toContain("Nothing to draw yet");
    expect(container.textContent).toContain("Sandboxed: no network, no storage");
  });
});
