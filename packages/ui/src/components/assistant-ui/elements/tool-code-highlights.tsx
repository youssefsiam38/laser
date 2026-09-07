"use client";
/** Lazy syntax-highlighting adapters for source displayed by file tools. */
import { useMemo } from "react";
import { useShikiHighlighter } from "react-shiki";

import {
  PlainCodeDiffRows,
  type CodeDiffRowsProps,
} from "./code-diff.js";
import {
  LASER_SHIKI_THEME,
  SHIKI_ENGINE,
  SyntaxHighlighter,
  shikiLanguageFromPath,
} from "./shiki-highlighter.js";

export function ToolSourceCode({ path, code }: { path?: string | undefined; code: string }) {
  return (
    <SyntaxHighlighter
      code={code}
      language={shikiLanguageFromPath(path)}
      streaming={false}
      className="[&>pre]:mb-0 [&>pre]:max-h-96 [&>pre]:rounded-lg [&>pre]:whitespace-pre"
    />
  );
}

export function HighlightedCodeDiffRows(props: CodeDiffRowsProps) {
  const source = useMemo(
    () => props.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join("\n"),
    [props.hunks],
  );
  const highlighted = useShikiHighlighter(source, shikiLanguageFromPath(props.path), LASER_SHIKI_THEME, {
    engine: SHIKI_ENGINE,
    outputFormat: "tokens",
    delay: 150,
  });
  return <PlainCodeDiffRows {...props} tokens={highlighted?.tokens} />;
}
