// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { clipRangeStartToCode, rangeStartsInHeader } from "../../src/source-control/copy.js";

afterEach(() => {
  document.body.replaceChildren();
});

function tree() {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const header = document.createElement("div");
  header.setAttribute("data-diffs-header", "");
  header.textContent = "file.ts\n-1\n+2";
  const line = document.createElement("div");
  line.setAttribute("data-line", "");
  line.textContent = "export const a = 1;";
  root.append(header, line);
  document.body.append(host);
  return { header, line };
}

it("clips a range that starts in the header so copy begins at the code", () => {
  const { header, line } = tree();
  const range = document.createRange();
  range.setStart(header.firstChild!, 0);
  range.setEnd(line.firstChild!, 6);
  expect(rangeStartsInHeader(range)).toBe(true);
  expect(clipRangeStartToCode(range)).toBe(true);
  expect(rangeStartsInHeader(range)).toBe(false);
  expect(range.startContainer).toBe(line);
});

it("leaves a range that already starts in code", () => {
  const { line } = tree();
  const range = document.createRange();
  range.selectNodeContents(line);
  expect(rangeStartsInHeader(range)).toBe(false);
  expect(clipRangeStartToCode(range)).toBe(false);
});
