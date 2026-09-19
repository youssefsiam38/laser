// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import {
  DIFF_LINE_FIND_POLICY,
  adoptHighlightSheet,
  collectOpenShadowRoots,
  findTextMatchesAcrossRoots,
  findTextMatchesIn,
} from "../../src/components/thread/find-ranges.js";

afterEach(() => {
  document.body.replaceChildren();
});

function line(text: string, extra?: string) {
  const node = document.createElement("span");
  node.setAttribute("data-line", "");
  if (extra) node.setAttribute(extra, "");
  for (const piece of text.split("|")) {
    const span = document.createElement("span");
    span.textContent = piece;
    node.append(span);
  }
  return node;
}

it("collects nested open shadow roots", () => {
  const host = document.createElement("div");
  const first = document.createElement("div");
  host.append(first);
  const root = first.attachShadow({ mode: "open" });
  const innerHost = document.createElement("div");
  root.append(innerHost);
  innerHost.attachShadow({ mode: "open" });
  document.body.append(host);
  expect(collectOpenShadowRoots(host)).toHaveLength(2);
});

it("concatenates per data-line and skips gutter, separator and header", () => {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.append(line("ex|port const"));
  const gutter = line("export");
  gutter.setAttribute("data-gutter", "");
  root.append(gutter);
  const header = document.createElement("div");
  header.setAttribute("data-diffs-header", "");
  header.textContent = "export";
  root.append(header);
  document.body.append(host);
  const matches = findTextMatchesIn(root, "export", DIFF_LINE_FIND_POLICY);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.match.toLowerCase()).toBe("export");
});

it("finds across roots without replacing existing adopted sheets", () => {
  const host = document.createElement("div");
  const a = document.createElement("div");
  const b = document.createElement("div");
  host.append(a, b);
  const rootA = a.attachShadow({ mode: "open" });
  const rootB = b.attachShadow({ mode: "open" });
  rootA.append(line("alpha export"));
  rootB.append(line("export beta"));
  if (typeof CSSStyleSheet !== "undefined") {
    const core = new CSSStyleSheet();
    core.replaceSync(":host{display:block}");
    rootA.adoptedStyleSheets = [core];
  }
  document.body.append(host);
  const matches = findTextMatchesAcrossRoots(host, "export");
  expect(matches.length).toBe(2);
  if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in rootA) {
    expect(rootA.adoptedStyleSheets.length).toBeGreaterThanOrEqual(1);
    const core = rootA.adoptedStyleSheets[0];
    const extra = new CSSStyleSheet();
    extra.replaceSync(":host{color:var(--ink)}");
    expect(adoptHighlightSheet(rootA, extra)).toBe(true);
    expect(rootA.adoptedStyleSheets[0]).toBe(core);
    expect(rootA.adoptedStyleSheets.includes(extra)).toBe(true);
    expect(adoptHighlightSheet(rootA, extra)).toBe(true);
  }
});
