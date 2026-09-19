/**
 * Opening the code around a change.
 *
 * What was wrong: the body carried a row reading "More unchanged context may
 * be available" and nothing happened. That sentence is Pierre's, and it is
 * emitted in exactly one situation — the file diff is `isPartial` (parsed from
 * a patch, so the renderer holds only the lines the patch carried) *and* a
 * `loadDiffFiles` loader was supplied, so the library knows more text exists
 * somewhere but not how much or what. It is a promise the renderer cannot
 * keep on its own.
 *
 * What we do instead: we fetch both sides of the file ourselves (the adapter
 * already has `pi/project/file_source`) and hand the renderer a **hydrated**,
 * non-partial diff (`hydratePartialDiff`, a documented export). Then every gap
 * has a real size — "247 unmodified lines" — the expanders are live, and the
 * "may be available" row is unreachable by construction: partial input never
 * gets a loader, hydrated input is never partial. When the sides genuinely
 * cannot be read, the body says so in a sentence instead of dangling
 * ({@link expansionNotice}).
 *
 * What is ours on top: Pierre draws its expanders as `div[role="button"]` with
 * no tab stop, no name and no keyboard path (spike criterion 4: "hunk
 * expanders are not keyboard-operable"). This module equips them in place —
 * a tab stop, an accessible name that says how many lines the press reveals,
 * and Enter/Space — without wrapping, re-parenting or re-texting anything the
 * renderer owns, so a re-render costs us one idempotent pass.
 */

/**
 * Everything here touches the rendered tree, so it is imported only from the
 * lazy renderer chunk. The *policy* half — which files can be expanded at all,
 * and what to say when one cannot — lives in `diff-files.ts`, which the
 * overlay shell imports eagerly.
 */

/**
 * Lines revealed per press, and the size above which Pierre splits one
 * expander into separate up and down controls. A screenful-ish step keeps
 * expansion bounded: no press can mount a whole large file.
 */
export const EXPANSION_LINE_COUNT = 24;

export type ExpandDirection = "up" | "down" | "both";

/** Marks a control this module has already equipped, and which way it opens. */
export const EXPANDER_READY_ATTR = "data-expand-ready";

/** Every selector this module touches, in one place. */
export const EXPANDER_SELECTORS = {
  separator: "[data-separator][data-expand-index]",
  button: "[data-expand-button]",
  gapText: "[data-unmodified-lines]",
} as const;

/**
 * The size of the gap a separator spans, out of the words Pierre writes into
 * it ("247 unmodified lines"). Returns undefined when the row says something
 * else, which is then treated as "size unknown", never as zero.
 */
export function gapLineCount(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = /(\d[\d\u00a0\u202f\u2009,.\s]*)\s*unmodified/i.exec(text);
  if (!match) return undefined;
  const digits = (match[1] ?? "").replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Which way a control reveals, read from the attributes Pierre sets. */
export function expandDirection(element: Element): ExpandDirection {
  if (element.hasAttribute("data-expand-up")) return "up";
  if (element.hasAttribute("data-expand-down")) return "down";
  return "both";
}

/**
 * What the control promises: the number of lines this press actually reveals,
 * never more than the gap holds. "Show 24 unchanged lines above".
 */
export function expandLabel(
  direction: ExpandDirection,
  gapLines?: number,
  step: number = EXPANSION_LINE_COUNT,
): string {
  const reach = direction === "both" ? step * 2 : step;
  const reveal = gapLines === undefined ? step : Math.max(1, Math.min(gapLines, reach));
  const where = direction === "up" ? " above" : direction === "down" ? " below" : "";
  return `Show ${reveal} unchanged ${reveal === 1 ? "line" : "lines"}${where}`;
}

/**
 * Give one expander a name and a tab stop. Writes only what differs: a
 * `setAttribute` to an identical value still queues a mutation record, and
 * this pass runs *from* a `MutationObserver`, so an unconditional write would
 * observe itself forever.
 */
export function equipExpander(button: HTMLElement, gapLines?: number): void {
  const direction = expandDirection(button);
  const label = expandLabel(direction, gapLines);
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.getAttribute(EXPANDER_READY_ATTR) !== direction) {
    button.setAttribute(EXPANDER_READY_ATTR, direction);
  }
  if (button.getAttribute("tabindex") !== "0") button.setAttribute("tabindex", "0");
}

/**
 * Equip every expander under a root. Returns how many it touched, so a caller
 * can tell "no expanders yet" from "expansion is off for this file".
 */
export function equipExpanders(root: ParentNode): number {
  let count = 0;
  for (const separator of root.querySelectorAll(EXPANDER_SELECTORS.separator)) {
    const gap = gapLineCount(separator.querySelector(EXPANDER_SELECTORS.gapText)?.textContent);
    for (const button of separator.querySelectorAll(EXPANDER_SELECTORS.button)) {
      if (!(button instanceof HTMLElement)) continue;
      equipExpander(button, gap);
      count += 1;
    }
  }
  return count;
}

/**
 * The expander a key press is aimed at, or undefined. `composedPath` is how a
 * light-DOM listener reaches into an open shadow root; `event.target` has
 * already been retargeted to the custom element by the time it gets here.
 */
export function expanderFromKeyEvent(event: KeyboardEvent): HTMLElement | undefined {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return undefined;
  const first = event.composedPath()[0];
  if (!(first instanceof Element)) return undefined;
  const button = first.closest(EXPANDER_SELECTORS.button);
  return button instanceof HTMLElement ? button : undefined;
}

