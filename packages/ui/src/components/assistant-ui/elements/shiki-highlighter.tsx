"use client";
/**
 * `elements-shiki-highlighter` (assistant-ui registry): code highlighting
 * through react-shiki, for code that comes from application state. The
 * runtime-aware wrapper in `shiki-highlighter.aui.tsx` feeds it from a
 * message part.
 *
 * Why Shiki won the evaluation against the hljs highlighter this replaced
 * (docs/ux-elements.md "Shiki highlighter"): TextMate grammars tokenize
 * real-world TypeScript, JSX, YAML and shell far more accurately than hljs's
 * heuristics; every language is a lazy chunk, so the transcript bundle carries
 * no grammar until a fence asks for one; and the JavaScript regex engine
 * needs no WebAssembly fetch, which matters on the relay. Streaming behaviour
 * is equal — both leave a running part plain — and settling is a colour
 * change in the same box, not a layout shift.
 *
 * The theme is laser's own, not `github-*`: every colour is a `--syntax-*`
 * token (docs/ux-theme.md T1), so one theme serves both bases and a person
 * who edits the tokens in Settings changes the code too. Shiki accepts
 * `var()` strings as theme colours and writes them into inline styles.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import type { FC } from "react";
import { bundledLanguages } from "shiki";
import { useShikiHighlighter, type ShikiHighlighterProps } from "react-shiki";

import { cn } from "@/lib/utils";

import { fenceClassName } from "./fence.js";

/** A TextMate theme whose colours are the theme system's tokens. */
export const LASER_SHIKI_THEME = {
  name: PRODUCT_NAME,
  type: "dark" as const,
  fg: "var(--ink)",
  bg: "transparent",
  colors: { "editor.foreground": "var(--ink)", "editor.background": "transparent" },
  settings: [
    { settings: { foreground: "var(--ink)", background: "transparent" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.control"], settings: { foreground: "var(--syntax-keyword)" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "var(--syntax-string)" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "constant.other"], settings: { foreground: "var(--syntax-number)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name", "entity.name.tag"], settings: { foreground: "var(--syntax-function)" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.other.attribute-name"], settings: { foreground: "var(--syntax-type)" } },
    { scope: ["variable", "variable.parameter", "variable.other", "meta.definition.variable"], settings: { foreground: "var(--syntax-variable)" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "var(--syntax-punctuation)" } },
  ],
};

/** Fences are usually tagged with an alias; anything Shiki does not bundle renders as plain text. */
export function shikiLanguage(language: string | undefined): string {
  const key = (language ?? "").trim().toLowerCase();
  if (!key) return "text";
  if (key in bundledLanguages) return key;
  const alias = ALIASES[key];
  return alias && alias in bundledLanguages ? alias : "text";
}

const ALIASES: Record<string, string> = {
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  node: "js",
  py3: "python",
  zsh: "bash",
  golang: "go",
  "c++": "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  docker: "dockerfile",
  conf: "ini",
  patch: "diff",
  make: "makefile",
  txt: "text",
  plaintext: "text",
};

export type SyntaxHighlighterProps = Omit<ShikiHighlighterProps, "children" | "theme" | "language"> & {
  code: string;
  language?: string | undefined;
  /** Skips tokenization and renders the plain code while `true`. */
  streaming?: boolean | undefined;
};

const PlainCode: FC<{ code: string }> = ({ code }) => (
  <pre>
    <code>{code}</code>
  </pre>
);

const HighlightedCode: FC<{
  code: string;
  language: string;
  options: Omit<ShikiHighlighterProps, "children" | "language" | "theme">;
}> = ({ code, language, options }) => {
  const highlighted = useShikiHighlighter(code, language, LASER_SHIKI_THEME, {
    ...options,
    engine: "javascript",
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
    <div className={cn(fenceClassName, streaming && "aui-shiki-streaming", className)} style={style}>
      {streaming ? (
        <PlainCode code={trimmed} />
      ) : (
        <HighlightedCode code={trimmed} language={shikiLanguage(language)} options={{ ...options, delay }} />
      )}
    </div>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
