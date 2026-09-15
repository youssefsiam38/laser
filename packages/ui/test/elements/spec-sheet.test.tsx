// @vitest-environment happy-dom
/**
 * The spec sheet's two shapes (M18-T3 browser acceptance).
 *
 * The browser matrix measured the process-detail rows at 390px: a
 * `max-content` label column took the width and every value arrived as
 * `364645…` behind a `title` no touch screen can open, or as a word broken
 * down a sixty-pixel column. Below `@sm` the row stacks instead. happy-dom
 * does not evaluate container queries, so what is asserted here is the
 * contract the stylesheet implements — the rendered result is measured in
 * `scripts/browser-check/test/resource-diagnostics.mjs`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { SpecSheet } from "../../src/components/assistant-ui/elements/spec-sheet.js";

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

const ROWS = [
  { label: "peak resident (not additive)", value: "335.9 MB", typed: true },
  { label: "private commit", value: "Unavailable · Not available on this platform: private commit is a Windows counter", wrap: true },
];

const render = async () => {
  await act(async () => root.render(<SpecSheet bare rows={ROWS} />));
  return container.querySelector<HTMLElement>('[data-slot="spec-sheet"]')!;
};

it("stacks a narrow container and keeps the compact two-column sheet when there is room", async () => {
  const sheet = await render();
  // The width that decides is the sheet's own, not the window's: this element
  // lives in rails and sheets that are narrow on a wide screen.
  expect(sheet.className).toContain("@container");
  const list = sheet.querySelector("dl")!;
  expect(list.className).toContain("grid-cols-[minmax(0,1fr)]");
  expect(list.className).toContain("@sm:grid-cols-[max-content_minmax(0,1fr)]");

  // Still a definition list: one `div` per pair, which is `contents` only once
  // the two-column grid applies.
  const pairs = [...list.children];
  expect(pairs).toHaveLength(ROWS.length);
  for (const pair of pairs) {
    expect(pair.className).toContain("@sm:contents");
    expect(pair.querySelector("dt")).not.toBeNull();
    expect(pair.querySelector("dd")).not.toBeNull();
  }
});

it("never truncates a stacked value, and still truncates a compact one", async () => {
  const sheet = await render();
  const values = [...sheet.querySelectorAll("dd")];
  const [compact, prose] = values;

  // Nothing is cut off while stacked: no `truncate` without its `@sm` guard.
  for (const value of values) {
    expect(value.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(value.className).toContain("whitespace-normal");
  }
  // A compact value goes back to one truncated line when the sheet is wide
  // enough for the tooltip to be reachable with a pointer.
  expect(compact!.className).toContain("@sm:truncate");
  expect(compact!.getAttribute("title")).toBe(ROWS[0]!.value);
  // Prose wraps at every width.
  expect(prose!.className).not.toContain("@sm:truncate");
  expect(prose!.textContent).toBe(ROWS[1]!.value);
});
