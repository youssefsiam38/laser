"use client";
import { SyntaxHighlighter, shikiLanguageFromPath } from "@/components/assistant-ui/elements/shiki-highlighter";
import { formatBytes } from "@/format";
import { describeMediaType } from "./media.js";

export function fileDescription(path: string, info?: { mediaType?: string | undefined; size?: number; content?: string }): string {
  const language = shikiLanguageFromPath(path);
  const names: Record<string, string> = { md: "Markdown document", markdown: "Markdown document", ts: "TypeScript source", typescript: "TypeScript source", tsx: "TypeScript source", js: "JavaScript source", javascript: "JavaScript source", jsx: "JavaScript source", python: "Python source", go: "Go source", rust: "Rust source", diff: "Patch" };
  const format = names[language] ?? (language !== "text" ? `${language.toUpperCase()} source` : info?.mediaType ? describeMediaType(info.mediaType) : "File");
  const content = info?.content;
  const lines = content === undefined || content === "" ? 0 : content.split("\n").length - Number(content.endsWith("\n"));
  const detail = info?.size !== undefined ? formatBytes(info.size) : content !== undefined
    ? format === "Markdown document" ? formatBytes(new TextEncoder().encode(content).length) : `${lines} ${lines === 1 ? "line" : "lines"}`
    : undefined;
  return `${format}${detail ? ` · ${detail}` : ""}`;
}

/** Tool paths are filesystem strings, not URLs: preserve #, %, ? and :digits. */
export function projectFilePath(cwd: string, path: string): string {
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function FileSource({ path, text }: { path: string; text: string }) {
  return <SyntaxHighlighter code={text} language={shikiLanguageFromPath(path)} showLineNumbers delay={0}
    className="[--rs-line-numbers-foreground:var(--ink-3)] [--rs-line-numbers-padding-right:calc(var(--space-unit)*4)] [&>pre]:mb-0 [&>pre]:rounded-none [&>pre]:border-0 [&>pre]:whitespace-pre" />;
}
