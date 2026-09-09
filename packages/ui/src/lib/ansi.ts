/**
 * ANSI interpreter for process output: a background task's log in the fleet,
 * and the log detail pane. SGR (colour, bold, dim, italic, underline, inverse)
 * is interpreted into spans; every other escape — cursor movement, OSC titles
 * and hyperlinks, private modes — is stripped. Nothing is ever passed through
 * as markup (AGENTS.md invariant 9). Pure.
 *
 * Tested in test/lib/ansi.test.ts.
 */

export interface AnsiStyle {
  /** 0–15 for the named palette, or a CSS colour for 256/truecolour. */
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSpan extends AnsiStyle {
  text: string;
}

// ESC [ params letter   |  ESC ] ... BEL|ST   |  other ESC sequences
const ESCAPE = /\x1b\[([0-9;:?]*)([A-Za-z@`])|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b[^[\]]/g;

/** Split text into styled spans. Consecutive text with one style is one span. */
export function parseAnsi(text: string, initial: AnsiStyle = {}): { spans: AnsiSpan[]; style: AnsiStyle } {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = { ...initial };
  let last = 0;
  const push = (chunk: string): void => {
    if (!chunk) return;
    const prev = spans.at(-1);
    if (prev && sameStyle(prev, style)) prev.text += chunk;
    else spans.push({ text: chunk, ...style });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
    // Every other sequence is dropped: cursor moves, clears, OSC, and the odd ESC.
  }
  push(text.slice(last));
  return { spans, style };
}

/** Text with every escape removed; for search, copy and the plain fallback. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(";").map((p) => Number.parseInt(p.split(":")[0] ?? "", 10));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === undefined || Number.isNaN(code)) continue;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      let color: number | string | undefined;
      if (mode === 5 && codes[i + 2] !== undefined) {
        color = color256(codes[i + 2]!);
        i += 2;
      } else if (mode === 2 && codes[i + 4] !== undefined) {
        color = `rgb(${clamp(codes[i + 2]!)} ${clamp(codes[i + 3]!)} ${clamp(codes[i + 4]!)})`;
        i += 4;
      }
      if (color !== undefined) {
        if (code === 38) next.fg = color;
        else next.bg = color;
      }
    }
  }
  return next;
}

const clamp = (n: number): number => Math.min(255, Math.max(0, n | 0));

/** xterm 256: 0–15 named, 16–231 a 6×6×6 cube, 232–255 greys. */
export function color256(n: number): number | string {
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(i / 36)] ?? 0;
  const g = steps[Math.floor((i % 36) / 6)] ?? 0;
  const b = steps[i % 6] ?? 0;
  return `rgb(${r} ${g} ${b})`;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse &&
    !!a.strike === !!b.strike
  );
}

/**
 * The 16 named colours, as references into the design system. The values live
 * in `globals.css` (`--ansi-0` … `--ansi-15`) with the rest of the palette, so
 * no component carries a hex literal and a theme can retune them in one place.
 */
export const ANSI_PALETTE: readonly string[] = Array.from({ length: 16 }, (_, i) => `var(--ansi-${i})`);

export function cssColor(color: number | string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return typeof color === "number" ? ANSI_PALETTE[color] : color;
}
