/**
 * A Sketch, and the frame it is allowed to exist in (D-354, M21-T11).
 *
 * A Sketch is model-written HTML/JS. It is the one thing in this app that is
 * markup rather than composed data, so the rules around it are absolute and
 * live here, in one place, rather than in a component that could forget one:
 *
 * - it renders **only** inside `<iframe srcdoc sandbox="allow-scripts">` —
 *   `allow-scripts` alone, never `allow-same-origin`, so the document has an
 *   opaque origin with no storage, no cookies, no parent access and no way to
 *   reach back into this app;
 * - a Content-Security-Policy meta is injected as the first thing in its
 *   `<head>`, forbidding every external load; policies combine, so a policy
 *   the document brings can only narrow it further, never widen it;
 * - its title is sanitised before it is shown, because the title is the one
 *   string of a Sketch that appears *outside* the frame;
 * - it is bounded: over the ceiling, the frame refuses to render it and says
 *   so instead of handing a browser something unbounded.
 *
 * Nothing from a Sketch is read back: the only way its content becomes design
 * is `ground_sketch`, which treats it as untrusted text.
 */
import { SKETCH_MAX_BYTES } from "@lasercode/protocol";

/** The sandbox token list, exactly. Anything more is a hole. */
export const SKETCH_SANDBOX = "allow-scripts";

/**
 * The policy the frame injects.
 *
 * `default-src 'none'` is the floor: no network of any kind. Inline style and
 * script are allowed because a Sketch is by definition one self-contained
 * document, and images and fonts only as `data:` for the same reason.
 */
export const SKETCH_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">`;

/**
 * Where a tag really opens, ignoring anything inside a comment.
 *
 * A Sketch is markup somebody else wrote, so the search for the insertion
 * point has to read it the way a parser would rather than the way a regular
 * expression does. `<!-- <head> -->` is text, not a head: inserting the policy
 * there would put it inside the comment, and the document would load with no
 * policy at all (M21-T22, threat model §5).
 *
 * Returns the index just past the opening tag, or `undefined` when the tag
 * does not really open anywhere — including when the document has an
 * unterminated comment, where there is no position that is provably live.
 */
function afterOpenTag(html: string, tag: "head" | "html"): number | undefined {
  const opener = new RegExp(`<${tag}(?=[\\s/>])[^>]*>|<${tag}>`, "i");
  let cursor = 0;
  for (;;) {
    const comment = html.indexOf("<!--", cursor);
    const segment = comment === -1 ? html.slice(cursor) : html.slice(cursor, comment);
    const found = opener.exec(segment);
    if (found?.index !== undefined) return cursor + found.index + found[0].length;
    if (comment === -1) return undefined;
    const end = html.indexOf("-->", comment + 4);
    // An unterminated comment swallows the rest of the document: nothing after
    // it is live markup, so there is no insertion point inside it.
    if (end === -1) return undefined;
    cursor = end + 3;
  }
}

/**
 * The document the frame actually loads: the Sketch, with the policy first.
 *
 * It is inserted after `<head>` when there is one, after `<html>` when there
 * is not, and in front of everything when the document is a fragment or when
 * neither tag opens outside a comment — in every case *before* anything that
 * could load, and always as live markup. A parser that moves it is still
 * fine: a meta CSP applies to the whole document it appears in.
 */
export function sketchSrcDoc(html: string): string {
  const head = afterOpenTag(html, "head");
  if (head !== undefined) {
    return `${html.slice(0, head)}${CSP_META}${html.slice(head)}`;
  }
  const htmlTag = afterOpenTag(html, "html");
  if (htmlTag !== undefined) {
    return `${html.slice(0, htmlTag)}<head>${CSP_META}</head>${html.slice(htmlTag)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
}

/** The title, as it may appear outside the frame: text, bounded, never markup. */
export function sanitiseSketchTitle(title: string, fallback = "Untitled sketch"): string {
  const stripped = title
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return fallback;
  return stripped.length > 120 ? `${stripped.slice(0, 119)}…` : stripped;
}

/** The size ceiling, and the sentence a person gets when it is crossed. */
export function sketchWithinBounds(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= SKETCH_MAX_BYTES;
}

export function sketchTooLargeMessage(bytes: number): string {
  const limit = Math.round(SKETCH_MAX_BYTES / 1024);
  return `This sketch is ${String(Math.round(bytes / 1024))} KB, over the ${String(limit)} KB a sketch may be. It is kept as it was written; ask for a smaller one, or ground it into a design.`;
}

/** The frame size, clamped to what the canvas can hold. */
export function sketchFrameSize(bounds: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(Math.max(bounds.width, 240), 2048),
    height: Math.min(Math.max(bounds.height, 180), 4096),
  };
}

/** Why a Sketch cannot be approved or handed off, in the person's words. */
export const SKETCH_GATE_REFUSAL =
  "A sketch is an exploration, not a design: it is not grounded in this project's design system, nothing in it can be commented on by name, and nothing downstream could be built from it. Ground it into a design first — the sketch stays on the revision as provenance.";
