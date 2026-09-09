"use client";
/**
 * Markdown as a document-panel body (M8-T3), the native replacement for
 * pi-markdown-preview, which is terminal-only (docs/research/findings.md).
 *
 * It is the transcript's own `markdown-text` element — the same component map, the same
 * type scale, the same code headers and highlighting — put in front of a string
 * instead of a streaming message part. `TextMessagePartProvider` is the seam
 * assistant-ui provides for exactly this: it publishes a completed text part on
 * the `aui` client, so the primitive reads its content from context as usual
 * and nothing has to be forked. That is why a document and an assistant message
 * cannot drift apart visually.
 *
 * The width differs on purpose. Prose in the transcript uses the shared reading measure
 * because it is being read as conversation; a document on its own is the whole
 * pane, and a table or a code block inside it needs the room. `max-w-none`
 * overrides the primitive's cap through tailwind-merge rather than by copying
 * its class list.
 *
 * Never raw HTML (AGENTS.md invariant 9): `MarkdownText` runs remark-gfm with
 * no rehype-raw, so a document written by an agent cannot inject markup.
 *
 * Two ancestors are required, and the shell provides both: the `aui` client
 * (`AssistantRuntimeProvider`, which `TextMessagePartProvider` extends) and a
 * `TooltipProvider`, because a fenced code block carries a copy button.
 */
import { TextMessagePartProvider } from "@assistant-ui/react";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { cn } from "@/lib/utils";

export interface MarkdownPreviewProps {
  text: string;
  /** Cap the column at reading width instead of filling the pane. */
  prose?: boolean;
  className?: string | undefined;
}

export function MarkdownPreview({ text, prose = false, className }: MarkdownPreviewProps) {
  return (
    <div data-slot="markdown-preview" className={cn("min-w-0 px-4 py-3", className)}>
      <TextMessagePartProvider text={text} isRunning={false}>
        <MarkdownText className={prose ? "max-w-(--measure-prose)" : "max-w-none"} />
      </TextMessagePartProvider>
    </div>
  );
}
