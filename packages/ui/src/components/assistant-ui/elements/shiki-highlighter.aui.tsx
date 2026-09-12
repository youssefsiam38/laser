"use client";
/**
 * `shiki-highlighter` (assistant-ui registry): the runtime-connected fence
 * highlighter. It reads the active message part and leaves the code plain
 * while the part streams — tokenizing partial code flickers — then hands the
 * settled code to `shiki-highlighter.tsx`. Registered as `SyntaxHighlighter`
 * in `markdown-text.tsx`. While the part streams, and while the Shiki chunk
 * loads, the plain code sits in the same box, so settling is a colour change.
 */
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps as AUIProps } from "@assistant-ui/react-markdown";
import { lazy, Suspense, type FC } from "react";
import type { ShikiHighlighterProps } from "react-shiki";

import { cn } from "@/lib/utils";

import { fenceClassName } from "./fence.js";

/** Shiki and its engine are a lazy chunk: nothing loads until a fence settles. */
const LazyHighlighter = lazy(() => import("./shiki-highlighter").then((m) => ({ default: m.SyntaxHighlighter })));

export type HighlighterProps = Omit<ShikiHighlighterProps, "children" | "theme" | "language"> &
  Pick<AUIProps, "language" | "code"> &
  Partial<Pick<AUIProps, "node" | "components">>;

export const SyntaxHighlighter: FC<HighlighterProps> = ({ node: _node, components: _components, ...props }) => {
  const isStreaming = useAuiState((s) => s.optional.part?.status.type === "running");
  const plain = <PlainFence code={props.code} className={props.className} />;
  if (isStreaming) return plain;
  return (
    <Suspense fallback={plain}>
      <LazyHighlighter {...props} streaming={false} />
    </Suspense>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";

/** The same box `shiki-highlighter.tsx` draws, with the code untokenized. */
function PlainFence({ code, className }: { code: string; className?: string | undefined }) {
  return (
    <div className={cn(fenceClassName, "aui-shiki-streaming", className)}>
      <pre dir="ltr">
        <code dir="ltr">{code.replace(/\n$/, "")}</code>
      </pre>
    </div>
  );
}
