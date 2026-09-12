"use client";
/**
 * `elements-shiki-highlighter` (assistant-ui registry): code highlighting
 * through react-shiki, for code that comes from application state. The
 * runtime-aware wrapper in `shiki-highlighter.aui.tsx` feeds it from a
 * message part.
 *
 * Why Shiki won the evaluation against the hljs highlighter this replaced
 * (docs/ux-elements.md "Shiki highlighter"): TextMate grammars tokenize
 * real-world TypeScript, JSX, YAML, shell and the rest of Shiki's full catalog.
 * Every grammar is a lazy chunk, so the transcript bundle carries no language
 * until a fence asks for one. The Oniguruma engine is required for full
 * TextMate regex compatibility and is lazy with the highlighter. Streaming
 * remains plain, and settling is a colour change in the same box.
 *
 * The theme is laser's own, not `github-*`: every colour is a `--syntax-*`
 * token (docs/ux-theme.md T1), so one theme serves both bases and a person
 * who edits the tokens in Settings changes the code too. Shiki accepts
 * `var()` strings as theme colours and writes them into inline styles.
 */
import type { FC } from "react";
import { useShikiHighlighter, type ShikiHighlighterProps } from "react-shiki";

import { cn } from "@/lib/utils";

import { fenceClassName } from "./fence.js";
import { LASER_SHIKI_THEME, SHIKI_ENGINE } from "./shiki-theme.js";
import { shikiLanguage } from "./shiki-language.js";

export type SyntaxHighlighterProps = Omit<ShikiHighlighterProps, "children" | "theme" | "language"> & {
  code: string;
  language?: string | undefined;
  /** Skips tokenization and renders the plain code while `true`. */
  streaming?: boolean | undefined;
};

const PlainCode: FC<{ code: string }> = ({ code }) => (
  <pre dir="ltr">
    <code dir="ltr">{code}</code>
  </pre>
);

const HighlightedCode: FC<{
  code: string;
  language: string;
  options: Omit<ShikiHighlighterProps, "children" | "language" | "theme">;
}> = ({ code, language, options }) => {
  const highlighted = useShikiHighlighter(code, language, LASER_SHIKI_THEME, {
    ...options,
    engine: SHIKI_ENGINE,
  });
  return <>{highlighted ?? <PlainCode code={code} />}</>;
};

/**
 * Skips tokenization while `streaming` and renders the plain code in the same
 * container, so streaming costs no Shiki work and settling is a colour change
 * rather than a layout shift.
 */
export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  code,
  language,
  className,
  style,
  // Inert: useShikiHighlighter output has no default styles or language label.
  addDefaultStyles: _addDefaultStyles,
  showLanguage: _showLanguage,
  // The part settles before smooth streaming finishes draining, so the code keeps changing for a few frames.
  delay = 150,
  streaming = false,
  ...options
}) => {
  const trimmed = code.replace(/\n$/, "");
  return (
    <div dir="ltr" className={cn(fenceClassName, streaming && "aui-shiki-streaming", className)} style={style}>
      {streaming ? (
        <PlainCode code={trimmed} />
      ) : (
        <HighlightedCode code={trimmed} language={shikiLanguage(language)} options={{ ...options, delay }} />
      )}
    </div>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
