"use client";
import { SyntaxHighlighter, shikiLanguageFromPath } from "@/components/assistant-ui/elements/shiki-highlighter";
import { boundedPreviewText } from "./display.js";

export function FileSource({ path, text }: { path: string; text: string }) {
  return <SyntaxHighlighter code={boundedPreviewText(text)} language={shikiLanguageFromPath(path)} showLineNumbers delay={0}
    className="[--rs-line-numbers-foreground:var(--ink-3)] [--rs-line-numbers-padding-right:calc(var(--space-unit)*4)] [&>pre]:mb-0 [&>pre]:rounded-none [&>pre]:border-0 [&>pre]:whitespace-pre" />;
}
