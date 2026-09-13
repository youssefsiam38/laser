// @vitest-environment happy-dom
/**
 * Math is a chunk, not a tax (M16-T31).
 *
 * The renderer used to carry KaTeX and its stylesheet in the first chunk for
 * every conversation. These tests pin the boundary that replaced it: the
 * message decides. A message with no math never asks for the renderer; a
 * message with math asks once, renders typeset, and the next one is typeset on
 * its first paint.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MarkdownText } from "../../src/components/assistant-ui/elements/markdown-text.js";
import { hasMathDelimiters } from "../../src/components/assistant-ui/elements/markdown-math.js";

/** Every evaluation of the math chunk is counted; the plugin itself stays real. */
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/components/assistant-ui/elements/markdown-katex.js", async () => {
  loads.count++;
  const rehypeKatex = (await import("rehype-katex")).default;
  return { default: rehypeKatex };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  loads.count = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (text: string) => {
  await act(async () => root.render(
    <TextMessagePartProvider text={text} isRunning={false}><MarkdownText /></TextMessagePartProvider>,
  ));
  // The chunk resolves off the render pass: give the loader real turns of the
  // event loop (the same bound for a message with math and one without, so the
  // negative case is a decision and not a race), then let the plugin land.
  for (let turn = 0; turn < 10; turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

it("recognizes every delimiter the renderer typesets, and nothing in ordinary prose", () => {
  expect(hasMathDelimiters("$$E = mc^2$$")).toBe(true);
  expect(hasMathDelimiters("the value $x$ is bounded")).toBe(true);
  expect(hasMathDelimiters("inline \\(x + y\\) here")).toBe(true);
  expect(hasMathDelimiters("display \\[x + y\\] here")).toBe(true);
  expect(hasMathDelimiters("```math\nx + y\n```")).toBe(true);
  expect(hasMathDelimiters("~~~math\nx + y\n~~~")).toBe(true);
  expect(hasMathDelimiters("Run the focused tests, then inspect the changes.")).toBe(false);
  expect(hasMathDelimiters("The file costs 5 USD and lives in src/math/index.ts.")).toBe(false);
  expect(hasMathDelimiters("A single price of $5 in a sentence.")).toBe(false);
});

it("never fetches the math renderer for a message without math", async () => {
  await render("Checkpoint 3 is complete.\n\nRun the focused tests, then inspect the changes.");
  expect(loads.count).toBe(0);
  expect(container.querySelector(".katex")).toBeNull();
  expect(container.textContent).toContain("Checkpoint 3 is complete.");
});

it("loads the math renderer once for a message with math and typesets it", async () => {
  await render("The identity $$E = mc^2$$ holds.");
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".katex")).not.toBeNull();
  }, { timeout: 10_000, interval: 10 });
  expect(loads.count).toBe(1);
  // The formula is typeset, not left as source: KaTeX keeps the TeX beside it.
  expect(container.querySelector("annotation")?.textContent).toBe("E = mc^2");
  expect(container.textContent).toContain("holds.");
  // The dollars are gone: the reader sees the formula, not its source.
  expect(container.textContent).not.toContain("$$");

  // A second message with math is typeset on its first paint: one import, kept.
  await act(async () => root.render(
    <TextMessagePartProvider text="And $$a^2 + b^2 = c^2$$ too." isRunning={false}><MarkdownText /></TextMessagePartProvider>,
  ));
  expect(loads.count).toBe(1);
  expect(container.querySelector(".katex")).not.toBeNull();
});
