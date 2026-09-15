// @vitest-environment happy-dom
/**
 * A ticker's value reads the way it was formatted (M18-T3 browser acceptance).
 *
 * Every character is its own inline-flex item, so the one holding the space in
 * "259.9 MB" collapsed and the resource cards read "259.9MB" beside an
 * untickered "356.0 MB" in the row below.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { NumberTicker } from "../../src/components/assistant-ui/elements/number-ticker.js";

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

it("keeps the spaces the caller formatted, in the name and in the characters", async () => {
  await act(async () => root.render(<NumberTicker value="259.9 MB" label="Whole application current physical memory" />));
  const ticker = container.querySelector<HTMLElement>('[data-slot="number-ticker"]')!;

  expect(ticker.getAttribute("aria-label")).toBe("Whole application current physical memory 259.9 MB");
  const space = [...ticker.querySelectorAll("span")].find((node) => node.textContent === " ");
  expect(space, "the space is a character of its own").toBeDefined();
  expect(space!.className).toContain("whitespace-pre");
  // Digits still roll; only the characters between them hold their whitespace.
  expect(ticker.textContent).toContain(" MB");
});
