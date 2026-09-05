/**
 * Allow-list sanitizer for renderer-produced SVG.
 *
 * A Mermaid fence is transcript text, and AGENTS.md invariant 9 says nothing
 * from the transcript is rendered as HTML. `beautiful-mermaid` turns that
 * text into an SVG string, but it copies node labels into the markup
 * verbatim — a label of `<img src=x onerror=…>` survives into the output, and
 * the HTML parser's foreign-content rules would break it out of the SVG into
 * a live `<img>`. So the SVG is parsed as XML here, walked, and rebuilt with
 * only drawing elements and inert attributes before it reaches the DOM.
 *
 * Also dropped: `<style>` rules that fetch (`@import`, `url(`) — the renderer
 * embeds a Google Fonts import, and a diagram must not phone home — and any
 * `href` that is not a same-document fragment.
 *
 * Pure apart from `DOMParser`/`XMLSerializer`, which the caller's environment
 * provides (the browser, or happy-dom in tests). Returns `null` when the
 * input does not parse as SVG at all; the caller shows the source instead.
 */

const ALLOWED = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "marker",
  "clippath",
  "mask",
  "pattern",
  "lineargradient",
  "radialgradient",
  "stop",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "title",
  "desc",
  "style",
]);

const URL_ATTRS = new Set(["href", "xlink:href", "src"]);

export function sanitizeSvg(svg: string): string | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length > 0) return null;

  const walk = (el: Element): void => {
    const children = Array.from(el.children);
    for (const child of children) {
      if (!ALLOWED.has(child.localName.toLowerCase())) {
        child.remove();
        continue;
      }
      if (child.localName.toLowerCase() === "style") {
        child.textContent = scrubCss(child.textContent ?? "");
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          child.removeAttribute(attr.name);
        } else if (URL_ATTRS.has(name) && !attr.value.trim().startsWith("#")) {
          child.removeAttribute(attr.name);
        } else if (name === "style" && /url\(|expression\(|@import/i.test(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.toLowerCase().startsWith("on")) root.removeAttribute(attr.name);
  }
  walk(root);
  return new XMLSerializer().serializeToString(root);
}

/** Drops any rule that would fetch: `@import` lines and `url(` values. */
export function scrubCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/[^;{}]*url\([^)]*\)[^;]*;?/gi, "")
    .trim();
}
