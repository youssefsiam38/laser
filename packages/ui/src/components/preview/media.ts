/**
 * Which body draws a `document` panel — the table that keeps `renderable`
 * honest (M8-T3).
 *
 * The panel contract says content is a media type plus a ref, and that
 * `renderable: false` must degrade to "open this elsewhere" rather than to a
 * broken viewer. This file is the laser end of that promise: we render
 * markdown, unified diffs, images and plain text, and we say so out loud for
 * everything else instead of guessing. A PDF, a protein structure or a
 * spreadsheet is not a viewer we have; pretending otherwise produces garbage.
 *
 * Pure, and deliberately small: it is a lookup table, which is exactly the kind
 * of logic a test is the cheapest proof for (test/preview/media.test.ts).
 *
 * pi-markdown-preview and @xynogen/pix-display are terminal-only packages
 * (docs/research/findings.md), so these bodies are the native replacement for
 * both rather than a bridge to either.
 */

/** The body that draws the content, or `none` when we will not guess. */
export type PreviewKind = "markdown" | "diff" | "image" | "text" | "none";

/** `text/markdown; charset=utf-8` → `text/markdown`. */
export function baseMediaType(mediaType: string): string {
  return mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Exact media types we draw. Ordered by how a producer is likely to spell it. */
const EXACT: ReadonlyMap<string, PreviewKind> = new Map([
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["text/md", "markdown"],
  ["text/x-diff", "diff"],
  ["text/x-patch", "diff"],
  ["application/x-patch", "diff"],
  ["image/png", "image"],
  ["image/jpeg", "image"],
  ["image/gif", "image"],
  ["image/webp", "image"],
  ["image/avif", "image"],
  ["image/svg+xml", "image"],
  ["image/bmp", "image"],
  ["text/plain", "text"],
  ["application/json", "text"],
  ["application/xml", "text"],
  ["application/yaml", "text"],
  ["application/toml", "text"],
]);

/**
 * Types that *look* renderable and are not. Named so the "open externally" card
 * can be specific, and so nobody is tempted to add `image/*` as a catch-all:
 * a TIFF or a RAW file has an `image/` type and no browser will draw it.
 */
const NOT_RENDERABLE: ReadonlyMap<string, string> = new Map([
  ["application/pdf", "PDF"],
  ["image/tiff", "TIFF image"],
  ["image/heic", "HEIC image"],
  ["image/heif", "HEIF image"],
  ["image/x-icon", "icon"],
  ["application/zip", "archive"],
  ["application/octet-stream", "binary file"],
]);

/** Path suffixes that decide when the media type is a generic one. */
const BY_SUFFIX: ReadonlyArray<readonly [string, PreviewKind]> = [
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".mdx", "markdown"],
  [".diff", "diff"],
  [".patch", "diff"],
];

/**
 * The body for a document.
 *
 * `path` only breaks ties the media type left open: a producer that hands us
 * `text/plain` for a file called `README.md` meant markdown, and a producer
 * that says `text/markdown` means markdown whatever the file is called. The
 * declared type always wins where it is specific.
 */
export function previewKindFor(mediaType: string, path?: string): PreviewKind {
  const base = baseMediaType(mediaType);
  const exact = EXACT.get(base);
  if (exact && exact !== "text") return exact;
  if (NOT_RENDERABLE.has(base)) return "none";

  const name = (path ?? "").toLowerCase();
  for (const [suffix, kind] of BY_SUFFIX) if (name.endsWith(suffix)) return kind;

  if (exact) return exact;
  // A type we have never seen, but that says it is text, is safe to show as
  // text: worst case a person reads the source, which is what they asked for.
  if (base.startsWith("text/")) return "text";
  if (base.endsWith("+json") || base.endsWith("+xml") || base.endsWith("+yaml")) return "text";
  return "none";
}

/** True when a body exists for this document. */
export function isPreviewable(mediaType: string, path?: string): boolean {
  return previewKindFor(mediaType, path) !== "none";
}

/** Image bodies need the bytes as a data URL; everything else reads as UTF-8. */
export function needsBinaryRead(mediaType: string, path?: string): boolean {
  return previewKindFor(mediaType, path) === "image";
}

const NAMES: ReadonlyMap<string, string> = new Map([
  ["text/markdown", "Markdown"],
  ["text/x-markdown", "Markdown"],
  ["text/md", "Markdown"],
  ["text/x-diff", "Unified diff"],
  ["text/x-patch", "Unified diff"],
  ["application/x-patch", "Unified diff"],
  ["text/plain", "Plain text"],
  ["application/json", "JSON"],
  ["application/xml", "XML"],
  ["application/yaml", "YAML"],
  ["application/toml", "TOML"],
  ["image/svg+xml", "SVG image"],
]);

/**
 * A name for the format, for the eyebrow and for the "open externally" card.
 * Never the raw media type when a person-readable name exists — "PDF" reads,
 * "application/pdf" is a value.
 */
export function describeMediaType(mediaType: string): string {
  const base = baseMediaType(mediaType);
  const known = NAMES.get(base) ?? NOT_RENDERABLE.get(base);
  if (known) return known;
  if (base.startsWith("image/")) {
    const subtype = base.slice("image/".length).split("+")[0] ?? "";
    return subtype ? `${subtype.toUpperCase()} image` : "Image";
  }
  const subtype = base.split("/")[1];
  return subtype ? subtype.toUpperCase() : base || "Unknown format";
}
