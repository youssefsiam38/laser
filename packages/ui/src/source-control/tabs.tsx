import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { fileName, statusLabel, statusMark } from "./classify.js";
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
    <div data-slot="changes-tabs" role="tablist" aria-label="Open files" className="flex shrink-0 gap-0 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const file = files.get(`${tab.repo}:${tab.path}`);
        const selected = active?.repo === tab.repo && active.path === tab.path;
        const mark = file ? statusMark(file.status) : "M";
        const tabId = `changes-tab-${tab.repo}-${tab.path}`;
        return (
          <button
            key={`${tab.repo}:${tab.path}`}
            type="button"
            role="tab"
            id={tabId}
            aria-selected={selected}
            aria-controls={CHANGES_DIFF_PANEL_ID}
            title={tab.path}
            onClick={() => onSelect(tab)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab);
              }
            }}
            className={cn(
              "group flex min-h-8 min-w-0 items-center gap-1.5 border-e border-line px-3 py-1 text-start outline-none",
              "[@media(pointer:coarse)]:min-h-11",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              selected ? "bg-surface-2" : "bg-bg",
            )}
          >
            <span className="typed text-xs text-ink-3" title={file ? statusLabel(file.status) : undefined}>
              {mark}
            </span>
            <span className="typed min-w-0 truncate text-xs text-ink">{fileName(tab.path)}</span>
            <span
              role="presentation"
              aria-label={`Close ${fileName(tab.path)}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose(tab);
              }}
              className={cn(
                "ms-1 flex size-7 items-center justify-center text-ink-3 outline-none",
                "[@media(pointer:coarse)]:size-11",
                "hover:bg-surface-2 hover:text-ink",
              )}
            >
              <X className="size-3.5" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
