/**
 * The open files, as a real tab strip.
 *
 * Three things make it a product rather than a row of buttons: the file name
 * is typed (mono at the 12px floor) and truncates in its *middle* so the
 * extension survives; the selected tab is a ground change onto the body's own
 * ground with the strip's hairline broken under it, never a filled pill; and
 * the close affordance is a real button — it appears on hover and on focus,
 * it is in the tab order, and `w` closes the active tab from the keyboard.
 *
 * The strip scrolls itself on the inline axis, so a long list of open files
 * never pushes the window sideways (DESIGN.md "Legibility floor").
 */
import { X } from "lucide-react";

import { ControlHint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

import { fileName, statusLabel, statusMark, truncatableParts } from "./classify.js";
import type { ChangedFile } from "./contract.js";
import type { OpenFile } from "./store.js";

export const CHANGES_DIFF_PANEL_ID = "changes-diff-panel";

export function ChangesTabStrip({
  tabs,
  active,
  files,
  onSelect,
  onClose,
}: {
  tabs: readonly OpenFile[];
  active: OpenFile | undefined;
  files: ReadonlyMap<string, ChangedFile>;
  onSelect: (tab: OpenFile) => void;
  onClose: (tab: OpenFile) => void;
}) {
  if (!tabs.length) return null;
  return (
    <div
      data-slot="changes-tabs"
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden bg-surface-2 hairline-b scrollbar-none"
    >
      {tabs.map((tab) => {
        const file = files.get(`${tab.repo}:${tab.path}`);
        const selected = active?.repo === tab.repo && active.path === tab.path;
        const mark = file ? statusMark(file.status) : "M";
        const name = fileName(tab.path);
        const parts = truncatableParts(name, "file");
        const tabId = `changes-tab-${tab.repo}-${tab.path}`;
        return (
          <div
            key={`${tab.repo}:${tab.path}`}
            role="presentation"
            data-selected={selected ? "" : undefined}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab);
              }
            }}
            className={cn(
              "group relative flex min-w-0 max-w-56 shrink-0 items-center hairline-e",
              selected ? "bg-bg" : "bg-surface-2",
            )}
          >
            {/* The selected tab's own hairline, on top, so it reads as the
                sheet the body below is drawn on. */}
            {selected ? <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-ink-3" /> : null}
            <ControlHint hint={tab.path}>
              <button
                type="button"
                role="tab"
                id={tabId}
                aria-selected={selected}
                aria-controls={CHANGES_DIFF_PANEL_ID}
                onClick={() => onSelect(tab)}
                className={cn(
                  "flex min-h-8 min-w-0 flex-1 items-center gap-1.5 ps-3 pe-1 py-1 text-start outline-none",
                  "pointer-coarse:min-h-11",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                  selected ? "text-ink" : "text-ink-2 hover:text-ink",
                )}
              >
                <span aria-hidden="true" className="typed shrink-0 text-ink-3">
                  {mark}
                </span>
                <span className="sr-only">{file ? statusLabel(file.status) : "modified"}</span>
                <span className="typed flex min-w-0 items-baseline">
                  <span className="min-w-0 truncate">{parts.head}</span>
                  {parts.tail ? <span className="shrink-0">{parts.tail}</span> : null}
                </span>
              </button>
            </ControlHint>
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose(tab);
              }}
              className={cn(
                "me-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 outline-none",
                "pointer-coarse:size-11 pointer-coarse:opacity-100",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                "transition-opacity duration-(--motion-instant) motion-reduce:transition-none",
                "hover:bg-surface-2 hover:text-ink",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              )}
            >
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
