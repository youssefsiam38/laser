/**
 * The one pass over Pierre's shadow roots: our stylesheet in, its expanders
 * equipped, and a keyboard path into a control that has none.
 *
 * The renderer rebuilds its tree on every expansion and on every theme or
 * layout change, and a React remount constructs a fresh `diffs-container`
 * whose constructor assigns `adoptedStyleSheets = [coreSheet]`. So this is not
 * a one-shot effect. Two details matter:
 *
 *  - An expansion mutates the tree **inside** the shadow root, which a
 *    light-DOM `MutationObserver` never sees. Each root is observed in its own
 *    right, and roots discovered later are picked up by the pass that finds
 *    them.
 *  - Every write is compared first, so the observer never re-fires on our own
 *    attributes.
 */
import { useEffect, type RefObject } from "react";

import { collectOpenShadowRoots } from "@/components/thread/find-ranges.js";

import { equipExpanders, expanderFromKeyEvent } from "./diff-expand.js";
import { adoptDiffTypography } from "./diff-typography.js";

/** One frame's grace for the renderer to finish writing its tree. */
const SETTLE_MS = 16;

/**
 * Adopt our type into every root under `host` and equip every expander in it.
 * Pure DOM, no React: a test can call it on a fixture.
 */
export function applyDiffShadowChrome(host: HTMLElement): {
  roots: ShadowRoot[];
  styled: number;
  expanders: number;
} {
  const roots = collectOpenShadowRoots(host);
  let styled = 0;
  let expanders = 0;
  for (const root of roots) {
    if (adoptDiffTypography(root)) styled += 1;
    expanders += equipExpanders(root);
  }
  // A root-less render (an error body, an element the browser has not
  // upgraded yet) still has light DOM; equipping it costs nothing.
  expanders += equipExpanders(host);
  return { roots, styled, expanders };
}

export function useDiffShadowChrome(host: RefObject<HTMLElement | null>, key: string): void {
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observed = new Set<Node>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const observer =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(run, SETTLE_MS);
          })
        : undefined;

    function watch(target: Node): void {
      if (!observer || observed.has(target)) return;
      observed.add(target);
      observer.observe(target, { childList: true, subtree: true });
    }

    function run(): void {
      timer = undefined;
      const current = host.current;
      if (!current) return;
      for (const root of applyDiffShadowChrome(current).roots) watch(root);
    }

    watch(node);
    run();

    const onKeyDown = (event: KeyboardEvent) => {
      const button = expanderFromKeyEvent(event);
      if (!button) return;
      // Space would scroll the diff and Enter would do nothing at all: the
      // control is a `div[role="button"]`, so activation is ours to provide.
      event.preventDefault();
      event.stopPropagation();
      button.click();
    };
    node.addEventListener("keydown", onKeyDown);

    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      node.removeEventListener("keydown", onKeyDown);
    };
    // `key` re-runs the pass when the file or the layout changes: a new
    // `diffs-container` starts with only Pierre's own sheet.
  }, [host, key]);
}
