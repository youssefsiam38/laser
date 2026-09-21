/**
 * A tool row's **preview**: what the next call would do, shown before it does
 * it (`docs/agent-tool-contract.md` §2, M26-T4).
 *
 * It draws through `source-control/change-preview.tsx` — the same card the
 * person reads in the commit, push and pull-request dialogs (M20-T6) — so a
 * write an agent is about to make looks like a write the person is about to
 * make, rather than like a second invention.
 *
 * There is no button here, on purpose. The confirmation is not the person's to
 * give in the transcript: the contract's handshake is a second tool call
 * carrying `confirmed: true` and this exact digest, so the row says that in
 * words and shows the digest. A control that pretended to confirm would either
 * do nothing or claim an authority this surface does not have.
 *
 * It sits outside the fold, beside an approval and a question, because a write
 * that has not happened yet is not a detail.
 */
import type { ToolPreview } from "./tool-preview.js";

import { ChangePreview, type ChangePreviewFact } from "@/source-control/change-preview";
import { cn } from "@/lib/utils";
import { mono } from "@/components/assistant-ui/elements/surfaces";

export interface ToolPreviewRowProps {
  preview: ToolPreview;
  /** The tool that answered, so the sentence can name what confirms it. */
  toolName?: string | undefined;
  className?: string | undefined;
}

export function ToolPreviewRow({ preview, toolName, className }: ToolPreviewRowProps) {
  const facts: ChangePreviewFact[] = [
    ...(preview.target ? [{ label: "Where", value: preview.target }] : []),
    ...(preview.branch ? [{ label: "Branch", value: preview.branch }] : []),
    ...(preview.remote ? [{ label: "Remote", value: preview.remote }] : []),
  ];
  const confirming = preview.confirmWith ?? toolName;
  return (
    <div
      data-slot="tool-preview"
      role="group"
      aria-label="Preview of what this would do"
      className={cn("mb-2 ms-6 flex flex-col gap-2 border-s-2 border-attention py-1 ps-3", className)}
    >
      <p className="eyebrow">Nothing has happened yet</p>
      <ChangePreview
        summary={preview.summary}
        {...(facts.length ? { facts } : {})}
        {...(preview.items.length ? { items: preview.items, itemsLabel: "Would change" } : {})}
      >
        <p data-slot="tool-preview-confirm" className="text-xs leading-sm text-ink-3">
          It goes ahead only when the agent asks again with this exact preview
          {confirming ? <> through <span className={mono}>{confirming}</span></> : null}.
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="eyebrow shrink-0">Preview id</span>
          <code data-slot="tool-preview-digest" dir="ltr" className={cn(mono, "min-w-0 truncate rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-2")}>
            {preview.digest}
          </code>
        </p>
      </ChangePreview>
    </div>
  );
}
