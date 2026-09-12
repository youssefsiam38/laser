"use client";
/** Runtime-connected registry fence; the shared highlighter boundary keeps
 * streaming code plain and lazily loads the engine after settlement.
 */
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps as AUIProps } from "@assistant-ui/react-markdown";
import type { FC } from "react";
import type { ShikiHighlighterProps } from "react-shiki";
import { SyntaxHighlighter as SharedHighlighter } from "./shiki-highlighter.js";

export type HighlighterProps = Omit<ShikiHighlighterProps, "children" | "theme" | "language"> &
  Pick<AUIProps, "language" | "code"> &
  Partial<Pick<AUIProps, "node" | "components">>;

export const SyntaxHighlighter: FC<HighlighterProps> = ({ node: _node, components: _components, ...props }) => {
  const isStreaming = useAuiState((s) => s.optional.part?.status.type === "running");
  return <SharedHighlighter {...props} streaming={isStreaming} />;
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
