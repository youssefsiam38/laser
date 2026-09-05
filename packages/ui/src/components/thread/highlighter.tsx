/// <reference types="react-syntax-highlighter" />
/**
 * Lazy module: the hljs highlighter. Loaded only after the first closed fence
 * needs coloring (`MarkdownText` wraps it in `lazy` + `Suspense`), so the
 * transcript bundle carries no highlighter until then.
 *
 * Why the SYNC `light` build and an explicit language list, not `light-async`:
 * `light-async` registers each language from a dynamic import and highlights on
 * the render that requested it, so the first paint of a fence runs through an
 * unregistered language and hljs returns the source untokenized. Nothing
 * re-renders once registration lands, so the block stays monochrome — verified
 * in the browser: the highlighter, hljs core, and the `typescript` chunk all
 * fetched 200 and the `<code>` still had zero token spans. It also emitted a
 * chunk for all 195 bundled languages. Registering a curated set up front is
 * deterministic and ships one chunk.
 *
 * Why not `makeLightAsyncSyntaxHighlighter` from
 * `@assistant-ui/react-syntax-highlighter`: that package's index also imports
 * react-syntax-highlighter's Prism entries, and `prism-async.js` in
 * react-syntax-highlighter 16 imports `refractor/lib/all`, a path refractor 5's
 * exports map does not expose — Rollup fails the build.
 *
 * Adding a language: import it below and add it to `LANGUAGES`. Anything not
 * registered renders as plain text in the theme's base color, which is a
 * legible fallback, not a failure.
 */
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import Light from "react-syntax-highlighter/dist/esm/light";
import atomOneDark from "react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark";
import github from "react-syntax-highlighter/dist/esm/styles/hljs/github";

import bash from "react-syntax-highlighter/dist/esm/languages/hljs/bash";
import c from "react-syntax-highlighter/dist/esm/languages/hljs/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/hljs/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/hljs/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/hljs/css";
import diff from "react-syntax-highlighter/dist/esm/languages/hljs/diff";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/hljs/dockerfile";
import go from "react-syntax-highlighter/dist/esm/languages/hljs/go";
import ini from "react-syntax-highlighter/dist/esm/languages/hljs/ini";
import java from "react-syntax-highlighter/dist/esm/languages/hljs/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/hljs/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import kotlin from "react-syntax-highlighter/dist/esm/languages/hljs/kotlin";
import lua from "react-syntax-highlighter/dist/esm/languages/hljs/lua";
import makefile from "react-syntax-highlighter/dist/esm/languages/hljs/makefile";
import markdown from "react-syntax-highlighter/dist/esm/languages/hljs/markdown";
import nginx from "react-syntax-highlighter/dist/esm/languages/hljs/nginx";
import php from "react-syntax-highlighter/dist/esm/languages/hljs/php";
import plaintext from "react-syntax-highlighter/dist/esm/languages/hljs/plaintext";
import python from "react-syntax-highlighter/dist/esm/languages/hljs/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/hljs/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/hljs/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/hljs/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/hljs/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/hljs/swift";
import typescript from "react-syntax-highlighter/dist/esm/languages/hljs/typescript";
import xml from "react-syntax-highlighter/dist/esm/languages/hljs/xml";
import yaml from "react-syntax-highlighter/dist/esm/languages/hljs/yaml";

import { useTheme } from "@/hooks/use-theme";

/** Canonical hljs name → grammar. Registered once, at module load. */
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nginx,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, grammar] of Object.entries(LANGUAGES)) {
  Light.registerLanguage(name, grammar);
}

// `MarkdownText` owns the fence's inset (`[&>code]:p-3.5`); padding here too
// doubled it and made every fence jump when the lazy highlighter resolved.
const customStyle = {
  margin: 0,
  padding: 0,
  background: "transparent",
  fontSize: "12px",
  lineHeight: "18px",
  fontFamily: "var(--font-mono)",
};

const codeTagProps = { style: { fontFamily: "inherit", background: "transparent" } };

/**
 * Fences are usually tagged with a short alias while hljs registers canonical
 * names. Unknown names fall through unchanged and render as plain text.
 */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  py: "python",
  py3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mdx: "markdown",
  html: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  cs: "csharp",
  "c++": "cpp",
  cc: "cpp",
  h: "cpp",
  hpp: "cpp",
  golang: "go",
  docker: "dockerfile",
  jsonc: "json",
  json5: "json",
  toml: "ini",
  conf: "ini",
  patch: "diff",
  make: "makefile",
  sass: "scss",
  text: "plaintext",
  txt: "plaintext",
  "": "plaintext",
};

export function canonicalLanguage(language: string): string {
  const key = language.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

/** Registered languages, for tests and for deciding whether to bother. */
export function isSupportedLanguage(language: string): boolean {
  return canonicalLanguage(language) in LANGUAGES;
}

function makeHighlighter(style: Record<string, React.CSSProperties>) {
  const Highlighter = ({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) => (
    <Light
      PreTag={Pre}
      CodeTag={Code}
      style={style}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
      language={canonicalLanguage(language)}
    >
      {code}
    </Light>
  );
  return Highlighter;
}

const LightHighlighter = makeHighlighter(github);
const DarkHighlighter = makeHighlighter(atomOneDark);

export default function ThemedSyntaxHighlighter(props: SyntaxHighlighterProps) {
  const { theme } = useTheme();
  const Highlighter = theme === "dark" ? DarkHighlighter : LightHighlighter;
  return <Highlighter {...props} />;
}
