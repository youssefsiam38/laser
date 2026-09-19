// @vitest-environment happy-dom
/**
 * Opening the code around a change is a control, not a sentence.
 *
 * What the person saw before this landed: a row reading "More unchanged
 * context may be available", no clickable expander anywhere in the dialog or
 * its shadow root, and nine `[data-line]` nodes before and after. Pierre emits
 * that exact copy in one situation only — a patch-parsed (`isPartial`) diff
 * plus a `loadDiffFiles` promise — and the expanders it draws for it are
 * `div[role="button"]` with no tab stop, no accessible name and no keyboard
 * path (spike criterion 4).
 *
 * The fixture below is Pierre's separator markup verbatim
 * (`dist/utils/createSeparator.js`), inside a real open shadow root, so the
 * selectors under test are the ones the library actually writes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  EXPANSION_LINE_COUNT,
  equipExpanders,
  expandLabel,
  expanderFromKeyEvent,
  gapLineCount,
} from "../../src/source-control/diff-expand.js";
import { expansionApplies, expansionNotice } from "../../src/source-control/diff-files.js";
import { useDiffShadowChrome } from "../../src/source-control/diff-shadow.js";
import { diffTypographySheet, resetDiffTypographySheet } from "../../src/source-control/diff-typography.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetDiffTypographySheet();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** One `line-info` separator, exactly as `createSeparator` builds it. */
function separatorHTML({ gap, chunked }: { gap: string; chunked: boolean }): string {
  const button = (kind: "up" | "down" | "both") =>
    `<div role="button" data-expand-button="" data-expand-${kind}=""><svg data-icon=""></svg></div>`;
  const buttons = chunked ? `${button("up")}${button("down")}` : button("both");
  return `
    <div data-separator="line-info" data-expand-index="1">
      <div data-separator-wrapper="" ${chunked ? 'data-separator-multi-button=""' : ""}>
        ${buttons}
        <div data-separator-content=""><span data-unmodified-lines="">${gap}</span></div>
      </div>
    </div>`;
}

/** A `diffs-container`-shaped host with an open root, under `host`. */
function mountPierreShadow(host: HTMLElement, html: string): ShadowRoot {
  const element = document.createElement("diffs-container");
  host.append(element);
  const shadow = element.attachShadow({ mode: "open" });
  const core = new CSSStyleSheet();
  core.replaceSync("@layer base { :host { display: block } }");
  shadow.adoptedStyleSheets = [core];
  shadow.innerHTML = `<pre data-code="">${html}</pre>`;
  return shadow;
}

it("reads the size of a gap out of the words Pierre writes into it", () => {
  expect(gapLineCount("247 unmodified lines")).toBe(247);
  expect(gapLineCount("1 unmodified line")).toBe(1);
  expect(gapLineCount("1,204 unmodified lines")).toBe(1204);
  expect(gapLineCount("1\u00a0204 unmodified lines")).toBe(1204);
  // Never invent a size: "unknown" must not become "0".
  expect(gapLineCount("More unchanged context may be available")).toBeUndefined();
  expect(gapLineCount("")).toBeUndefined();
  expect(gapLineCount(null)).toBeUndefined();
});

it("says how many lines the press reveals, and never promises more than the gap holds", () => {
  expect(expandLabel("up", 240)).toBe(`Show ${EXPANSION_LINE_COUNT} unchanged lines above`);
  expect(expandLabel("down", 240)).toBe(`Show ${EXPANSION_LINE_COUNT} unchanged lines below`);
  // One control that opens both ways reaches a step in each direction.
  expect(expandLabel("both", 240)).toBe(`Show ${EXPANSION_LINE_COUNT * 2} unchanged lines`);
  expect(expandLabel("up", 6)).toBe("Show 6 unchanged lines above");
  expect(expandLabel("up", 1)).toBe("Show 1 unchanged line above");
  // A gap whose size the renderer never stated still gets an honest promise.
  expect(expandLabel("down")).toBe(`Show ${EXPANSION_LINE_COUNT} unchanged lines below`);
});

it("equips Pierre's expanders with a tab stop and a name, idempotently", () => {
  const host = document.createElement("div");
  document.body.append(host);
  host.innerHTML = separatorHTML({ gap: "247 unmodified lines", chunked: true });

  expect(equipExpanders(host)).toBe(2);
  const buttons = [...host.querySelectorAll<HTMLElement>("[data-expand-button]")];
  expect(buttons.map((node) => node.getAttribute("tabindex"))).toEqual(["0", "0"]);
  expect(buttons.map((node) => node.getAttribute("aria-label"))).toEqual([
    `Show ${EXPANSION_LINE_COUNT} unchanged lines above`,
    `Show ${EXPANSION_LINE_COUNT} unchanged lines below`,
  ]);

  // The pass runs from a MutationObserver, so a second pass must write
  // nothing at all or it observes itself forever.
  const writes: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) writes.push(record.attributeName ?? "?");
  });
  observer.observe(host, { attributes: true, subtree: true });
  equipExpanders(host);
  observer.disconnect();
  expect(writes).toEqual([]);
  host.remove();
});

it("reaches an expander inside an open shadow root, from a key press in the light DOM", async () => {
  const clicks: string[] = [];
  function Fixture() {
    const ref = useRef<HTMLDivElement>(null);
    useDiffShadowChrome(ref, "fixture");
    return <div ref={ref} data-slot="changes-diff" />;
  }
  await act(async () => root.render(<Fixture />));
  const host = container.querySelector<HTMLElement>('[data-slot="changes-diff"]')!;
  const shadow = mountPierreShadow(host, separatorHTML({ gap: "48 unmodified lines", chunked: true }));

  // No explicit pass here: the renderer builds its root after mount, and the
  // hook has to notice on its own. This is the failure the person hit — a
  // one-shot effect sees an empty box and never runs again.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  const up = shadow.querySelector<HTMLElement>("[data-expand-up]")!;
  up.addEventListener("click", () => clicks.push("up"));
  expect(up.getAttribute("tabindex")).toBe("0");
  expect(up.getAttribute("aria-label")).toBe(`Show ${EXPANSION_LINE_COUNT} unchanged lines above`);

  for (const key of ["Enter", " "]) {
    await act(async () => {
      up.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
    });
  }
  expect(clicks).toEqual(["up", "up"]);

  // Our own stylesheet went in beside Pierre's, not over it.
  expect(shadow.adoptedStyleSheets).toHaveLength(2);
  expect(shadow.adoptedStyleSheets[1]).toBe(diffTypographySheet());

  // An expansion rebuilds the tree *inside* the root, which a light-DOM
  // observer never sees. The gap is smaller now and the control must say so.
  await act(async () => {
    shadow.querySelector("pre")!.innerHTML = separatorHTML({ gap: "5 unmodified lines", chunked: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(shadow.querySelector("[data-expand-up]")?.getAttribute("aria-label")).toBe("Show 5 unchanged lines above");
  expect(shadow.querySelector("[data-expand-down]")?.getAttribute("tabindex")).toBe("0");
});

it("ignores a key press that is not an activation, and one aimed at code", () => {
  const host = document.createElement("div");
  document.body.append(host);
  host.innerHTML = `${separatorHTML({ gap: "9 unmodified lines", chunked: false })}<div data-line="1"><span>code</span></div>`;
  const button = host.querySelector<HTMLElement>("[data-expand-button]")!;
  const line = host.querySelector<HTMLElement>("[data-line] span")!;

  const press = (target: Element, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
    Object.defineProperty(event, "composedPath", { value: () => [target] });
    return expanderFromKeyEvent(event);
  };
  expect(press(button, "Enter")).toBe(button);
  expect(press(button, " ")).toBe(button);
  expect(press(button, "ArrowDown")).toBeUndefined();
  expect(press(button, "a")).toBeUndefined();
  expect(press(line, "Enter")).toBeUndefined();
  host.remove();
});

it("only offers expansion where there are two sides to open", () => {
  expect(expansionApplies("change")).toBe(true);
  expect(expansionApplies("rename-changed")).toBe(true);
  expect(expansionApplies("new")).toBe(false);
  expect(expansionApplies("deleted")).toBe(false);
  expect(expansionApplies("rename-pure")).toBe(false);
  expect(expansionApplies(undefined)).toBe(false);
});

it("says plainly when the surrounding lines cannot be opened, and nothing when they can", () => {
  expect(expansionNotice("ready")).toBeNull();
  expect(expansionNotice("loading")).toBeNull();
  expect(expansionNotice("unsupported")).toBeNull();
  // Never "may be available": either the control is there, or the reason is.
  expect(expansionNotice("unavailable")).toMatch(/could not be read/);
  expect(expansionNotice("unavailable")).not.toMatch(/may be available/);
  expect(expansionNotice("too-large")).toMatch(/too large to read whole/);
});
