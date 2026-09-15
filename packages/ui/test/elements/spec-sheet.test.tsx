// @vitest-environment happy-dom
/**
 * What the spec sheet renders (M18-T3 browser acceptance).
 *
 * The browser matrix measured the process-detail rows at 390px: a
 * `max-content` label column took the width and every value arrived truncated
 * behind a `title` no touch screen can open, or as a word broken down a
 * sixty-pixel column. The layout that fixes it is a container query, and
 * whether it *works* is measured where CSS is real —
 * `scripts/browser-check/test/resource-diagnostics.mjs` asserts stacked on a
 * phone, two columns on the desktop, nothing clipped, in both themes. What is
 * asserted here is the markup that layout needs and the content it carries:
 * a definition list, one pair per row, every value present in full.
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

const render = async (rows: typeof ROWS = ROWS) => {
  await act(async () => root.render(<SpecSheet bare rows={rows} />));
  return container.querySelector<HTMLElement>('[data-slot="spec-sheet"]');
};

it("is a definition list: one labelled pair per row, each pair its own group", async () => {
  const sheet = (await render())!;
  const list = sheet.querySelector("dl")!;
  const pairs = [...list.children];

  expect(pairs).toHaveLength(ROWS.length);
  for (const [index, pair] of pairs.entries()) {
    expect(pair.querySelector("dt")!.textContent).toBe(ROWS[index]!.label);
    expect(pair.querySelector("dd")!.textContent).toBe(ROWS[index]!.value);
  }
});

it("carries every value in full, with the whole of it in the tooltip", async () => {
  const sheet = (await render())!;
  const values = [...sheet.querySelectorAll("dd")];

  for (const [index, value] of values.entries()) {
    // Nothing is shortened in the markup: a layout may fold it, but the text
    // and the tooltip always hold the whole value.
    expect(value.textContent).toBe(ROWS[index]!.value);
    expect(value.getAttribute("title")).toBe(ROWS[index]!.value);
  }
});

it("draws nothing at all rather than an empty sheet", async () => {
  expect(await render([])).toBeNull();
});
