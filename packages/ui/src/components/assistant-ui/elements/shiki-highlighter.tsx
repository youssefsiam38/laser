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
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "var(--syntax-comment)", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "keyword.control", "keyword.operator.word", "storage", "storage.type", "storage.modifier", "meta.preprocessor", "entity.name.directive"],
      settings: { foreground: "var(--syntax-keyword)" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "string.regexp", "constant.other.symbol", "constant.other.color", "markup.inline.raw"],
      settings: { foreground: "var(--syntax-string)" },
    },
    {
      scope: ["constant", "constant.numeric", "constant.language", "constant.character", "constant.character.escape", "variable.language", "entity.name.label"],
      settings: { foreground: "var(--syntax-number)" },
    },
    {
      scope: ["entity.name.function", "entity.name.method", "support.function", "support.method", "meta.function-call", "entity.name.tag", "markup.heading", "markup.heading entity.name"],
      settings: { foreground: "var(--syntax-function)" },
    },
    {
      scope: ["entity.name.type", "entity.name.class", "entity.name.interface", "entity.name.namespace", "entity.name.module", "support.type", "support.class", "support.constant", "entity.other.inherited-class"],
      settings: { foreground: "var(--syntax-type)" },
    },
    {
      scope: ["variable", "variable.parameter", "variable.other", "meta.definition.variable", "meta.object-literal.key", "variable.other.property", "support.type.property-name", "entity.other.attribute-name", "entity.name.selector"],
      settings: { foreground: "var(--syntax-variable)" },
    },
    { scope: ["markup.bold"], settings: { foreground: "var(--syntax-variable)", fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { foreground: "var(--syntax-variable)", fontStyle: "italic" } },
    { scope: ["markup.underline.link", "string.other.link", "markup.list"], settings: { foreground: "var(--syntax-type)" } },
    { scope: ["markup.inserted", "meta.diff.header.to-file"], settings: { foreground: "var(--ok)" } },
    { scope: ["markup.deleted", "meta.diff.header.from-file", "invalid"], settings: { foreground: "var(--danger)" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator", "meta.separator"], settings: { foreground: "var(--syntax-punctuation)" } },
  ],
};

/** Full TextMate-compatible regex support, lazy-loaded with the first settled fence. */
export const SHIKI_ENGINE = "oniguruma" as const;

/** Fences are often tagged with an alias or model-written wrapper; unknowns stay plain. */
export function shikiLanguage(language: string | undefined): string {
  const raw = (language ?? "").trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  const key = raw.replace(/^\{?\.?lang(?:uage)?-/, "").replace(/^\{\./, "").replace(/^\./, "").replace(/\}$/, "").replace(/:.+$/, "");
  if (!key) return "text";
  if (key in bundledLanguages) return key;
  const alias = ALIASES[key];
  return alias && alias in bundledLanguages ? alias : "text";
}

/** Infer a Shiki grammar from a file tool's target without loading file contents. */
export function shikiLanguageFromPath(path: string | undefined): string {
  const file = (path ?? "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const named = FILE_LANGUAGES[file];
  if (named) return shikiLanguage(named);
  const extension = file.includes(".") ? file.split(".").at(-1) ?? "" : "";
  return shikiLanguage(EXTENSION_LANGUAGES[extension] ?? extension);
}

const ALIASES: Record<string, string> = {
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  node: "js",
  javascriptreact: "jsx",
  typescriptreact: "tsx",
  py3: "python",
  zsh: "bash",
  shellscript: "bash",
  golang: "go",
  "c++": "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  docker: "dockerfile",
  html5: "html",
  conf: "ini",
  patch: "diff",
  make: "makefile",
  txt: "text",
  plaintext: "text",
};

const FILE_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "just",
  "cmakelists.txt": "cmake",
  "meson.build": "meson",
  "package.json": "json",
  "tsconfig.json": "jsonc",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  cjs: "js",
  cts: "ts",
  htm: "html",
  json5: "json5",
  jsonl: "json",
  markdown: "md",
  mjs: "js",
  mts: "ts",
  plist: "xml",
  py: "python",
  pyw: "python",
  sh: "bash",
  shell: "bash",
  toml: "toml",
  yml: "yaml",
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
