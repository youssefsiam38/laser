"use client";
/**
 * `mermaid-diagram` (assistant-ui registry): the runtime-connected Mermaid
 * renderer, registered for the `mermaid` fence in `markdown-text.tsx`. It
 * derives `streaming` from the active part so a half-written diagram is a
 * skeleton, not a parse error that flashes on every delta.
 *
 * The renderer (`beautiful-mermaid`, over a megabyte of layout code) is a
 * lazy chunk: the transcript bundle carries none of it until the first
 * settled `mermaid` fence, and while it loads the same skeleton shows.
 */
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { lazy, memo, Suspense, type FC } from "react";

import { MermaidSkeleton } from "./mermaid-skeleton.js";

const LazyMermaid = lazy(() => import("./mermaid-diagram").then((m) => ({ default: m.MermaidDiagram })));

export type MermaidDiagramProps = SyntaxHighlighterProps & { className?: string | undefined };

const MermaidDiagramImpl: FC<MermaidDiagramProps> = ({ code, className, node: _node, components: _components, language: _language }) => {
  const isStreaming = useAuiState((s) => s.optional.part?.status.type === "running");
  if (isStreaming) return <MermaidSkeleton className={className} />;
  return (
    <Suspense fallback={<MermaidSkeleton className={className} />}>
      <LazyMermaid code={code} {...(className !== undefined ? { className } : {})} streaming={false} />
    </Suspense>
  );
};

const MermaidDiagram = memo(MermaidDiagramImpl);
MermaidDiagram.displayName = "MermaidDiagram";

export { MermaidDiagram };
