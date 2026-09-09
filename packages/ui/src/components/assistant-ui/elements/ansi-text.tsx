"use client";
/**
 * ANSI-coloured text, as one shared component.
 *
 * Agent and process output arrives with SGR escapes in it. Two surfaces
 * render that: a `stream` panel whose declared encoding is `ansi`, and the
 * log detail pane when the row is captured process output. Both used to be
 * the only place that knew how to turn a span into a style; this is that
 * knowledge in one file so the two cannot drift.
 *
 * Colours resolve to `--ansi-0…15` through `cssColor`, so the terminal
 * palette is the theme's, not a literal (docs/ux-theme.md T1). Nothing is
 * ever passed through as markup: `parseAnsi` yields text spans, and the text
 * is rendered as text (AGENTS.md invariant 9).
 */
import { useMemo, type CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { cssColor, parseAnsi, type AnsiSpan } from "@/lib/ansi";

export function ansiSpanStyle(span: AnsiSpan): CSSProperties | undefined {
  const fg = cssColor(span.inverse ? span.bg : span.fg);
  const bg = cssColor(span.inverse ? span.fg : span.bg);
  if (!fg && !bg && !span.inverse) return undefined;
  return {
    ...(fg ? { color: fg } : span.inverse ? { color: "var(--terminal-bg)" } : {}),
    ...(bg ? { backgroundColor: bg } : span.inverse ? { backgroundColor: "var(--terminal-ink)" } : {}),
  };
}

export function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text).spans, [text]);
  return (
    <>
      {spans.map((span, i) => (
        <span
          key={i}
          style={ansiSpanStyle(span)}
          className={cn(
            span.bold && "font-semibold",
            span.dim && "opacity-60",
            span.italic && "italic",
            span.underline && "underline",
            span.strike && "line-through",
          )}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}
