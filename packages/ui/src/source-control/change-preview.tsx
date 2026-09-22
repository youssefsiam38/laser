/**
 * The preview a person reads before something is written: one sentence of the
 * exact effect, the named facts it depends on, and the bounded list of what it
 * would touch.
 *
 * This is the card the git dialog has always shown between "Review commit" and
 * "Commit to main" (M20-T6, `git-dialog.tsx` — `GitConfirmation` is now a thin
 * mapping onto it). The agent tool contract asks for exactly the same picture
 * when a Laser tool answers a `preview: true` call
 * (`docs/agent-tool-contract.md` §2, "the person's UI shows the same
 * preview"), so the transcript's preview row (M26-T4,
 * `components/thread/ToolPreviewRow.tsx`) draws through this component rather
 * than a second one that would drift from it.
 *
 * It draws facts only. Confirming belongs to whoever owns the action — a
 * button in the dialog, the model's next call in the transcript — so this
 * component has no control of its own.
 */
import type { GitActionConfirmation } from "@lasercode/protocol";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { repoLeafName } from "./git-model.js";

/** A named fact the effect depends on: the repository, the branch, the remote, the destination. */
export interface ChangePreviewFact {
  label: string;
  value: string;
}

export interface ChangePreviewProps {
  /** One sentence of the exact effect, written for a person. */
  summary: string;
  /** Named facts, rendered as a definition list in the order given. */
  facts?: readonly ChangePreviewFact[] | undefined;
  /** What would be written: paths, keys, ids. Scrolls; never grows the card. */
  items?: readonly string[] | undefined;
  /** Eyebrow over the item list, when there is one. */
  itemsLabel?: string | undefined;
  /** Rendered under the list: the digest chip, a sentence about what happens next. */
  children?: ReactNode;
  className?: string | undefined;
}

/**
 * How many items are painted. A preview of a thousand paths is still a
 * preview: the list stays bounded and says how much of it is not shown, the
 * way every other bounded list in the app does.
 */
export const CHANGE_PREVIEW_MAX_ITEMS = 50;

export function ChangePreview({ summary, facts, items, itemsLabel = "Files", children, className }: ChangePreviewProps) {
  const shown = items ? items.slice(0, CHANGE_PREVIEW_MAX_ITEMS) : [];
  const omitted = items ? items.length - shown.length : 0;
  return (
    <div data-slot="change-preview" className={cn("flex flex-col gap-2", className)}>
      <p data-slot="change-preview-summary" className="text-sm text-ink">
        {summary}
      </p>
      {facts?.length ? (
        <dl data-slot="change-preview-facts" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="eyebrow inline">{fact.label} </dt>
              <dd className="typed inline text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {shown.length ? (
        /* One hairline above the list, not a box around it: whatever this sits
           in — a dialog, a tool row — is already the card. */
        <div className="flex flex-col gap-1 hairline-t pt-2">
          {itemsLabel ? <span className="eyebrow">{itemsLabel}</span> : null}
          <ul data-slot="change-preview-items" className="max-h-32 overflow-y-auto overscroll-contain">
            {shown.map((item) => (
              <li key={item} className="typed truncate text-ink-2" title={item}>
                {item}
              </li>
            ))}
          </ul>
          {omitted > 0 ? (
            <p className="typed text-ink-3">
              and {omitted.toLocaleString("en-US")} more
            </p>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** The git dialog's confirmation, as facts this card can draw. */
export function GitChangePreview({ confirmation }: { confirmation: GitActionConfirmation }) {
  const facts: ChangePreviewFact[] = [
    { label: "Repository", value: repoLeafName(confirmation.repo) },
    { label: "Branch", value: confirmation.branch },
    ...(confirmation.remote ? [{ label: "Remote", value: confirmation.remote }] : []),
  ];
  return (
    <ChangePreview
      summary={confirmation.summary}
      facts={facts}
      {...(confirmation.files?.length ? { items: confirmation.files, itemsLabel: "" } : {})}
    />
  );
}
