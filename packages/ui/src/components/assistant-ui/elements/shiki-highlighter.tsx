"use client";
/** Registry highlighter boundary shared by fences, files and diagnostics.
 * Lightweight helpers never import the renderer; its full language catalog and
 * Oniguruma engine load only when actual settled code asks for highlighting.
 */
import { lazy, Suspense, type FC } from "react";
import type { SyntaxHighlighterProps } from "./shiki-highlighter-impl.js";
import { cn } from "@/lib/utils";
import { fenceClassName } from "./fence.js";

export { LASER_SHIKI_THEME, SHIKI_ENGINE } from "./shiki-theme.js";
export { shikiLanguage, shikiLanguageFromPath } from "./shiki-language.js";
export type { SyntaxHighlighterProps } from "./shiki-highlighter-impl.js";

const HighlightedCode = lazy(() => import("./shiki-highlighter-impl.js").then(module => ({ default: module.SyntaxHighlighter })));

export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = (props) => {
  const plain = <div dir="ltr" className={cn(fenceClassName, "aui-shiki-streaming", props.className)} style={props.style}>
    <pre dir="ltr"><code dir="ltr">{props.code.replace(/\n$/, "")}</code></pre>
  </div>;
  if (props.streaming) return plain;
  return <Suspense fallback={plain}><HighlightedCode {...props} /></Suspense>;
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
