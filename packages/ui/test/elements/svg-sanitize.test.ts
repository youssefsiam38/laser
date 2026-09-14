// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { sanitizeSvg, scrubCss } from "../../src/components/assistant-ui/utils/svg-sanitize.js";

describe("sanitizeSvg", () => {
  it("keeps drawing elements and drops everything that could run or fetch", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
        <style>@import url('https://fonts.googleapis.com/x'); text { font-weight: 500; }</style>
        <script>alert(1)</script>
        <foreignObject><div>x</div></foreignObject>
        <g onclick="alert(2)"><rect width="1" height="1"/><text>a <img src="x" onerror="alert(3)"/> b</text></g>
        <use xlink:href="#arrow"/><use xlink:href="https://evil/x.svg#a"/>
        <a href="javascript:alert(4)"><circle r="1"/></a>
      </svg>`,
    );
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/script|foreignObject|onload|onclick|onerror|<img|javascript:|@import|googleapis|<a\b/i);
    expect(out).toMatch(/<rect/);
    expect(out).toMatch(/<text>a\s+b<\/text>/);
    expect(out).toMatch(/font-weight: 500/);
    expect(out).toMatch(/xlink:href="#arrow"/);
    expect(out).not.toMatch(/evil/);
  });

  it("scrubs the root element by the same rules as its children", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
            xlink:href="https://evil/x.svg#a" style="background:url(https://evil/pixel.png)" width="10">
        <rect width="1" height="1"/>
      </svg>`,
    );
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/evil/);
    expect(out).not.toMatch(/xlink:href/);
    expect(out).not.toMatch(/style=/);
    // The root keeps the attributes that only draw.
    expect(out).toMatch(/width="10"/);
    expect(out).toMatch(/<rect/);
  });

  it("keeps a same-document fragment reference on the root", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#self"><rect width="1" height="1"/></svg>`,
    );
    expect(out).toMatch(/xlink:href="#self"/);
  });

  it("returns null for input that is not an SVG document", () => {
    expect(sanitizeSvg("<div>not svg</div>")).toBeNull();
    expect(sanitizeSvg("<svg><unclosed")).toBeNull();
  });
});

describe("scrubCss", () => {
  it("removes imports and url() declarations, keeping the rest", () => {
    expect(scrubCss("@import url('x'); text { fill: red; background: url(a.png); }")).toBe("text { fill: red; }");
  });
});
