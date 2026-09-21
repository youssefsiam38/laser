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
 * The document the frame actually loads: the Sketch, with the policy first.
 *
 * It is inserted after `<head>` when there is one, after `<html>` when there
 * is not, and in front of everything when the document is a fragment — in
 * every case *before* anything that could load. A parser that moves it is
 * still fine: a meta CSP applies to the whole document it appears in.
 */
export function sketchSrcDoc(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag?.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
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
