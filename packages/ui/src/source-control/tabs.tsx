import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { fileName, statusLabel, statusMark } from "./classify.js";
import type { ChangedFile } from "./contract.js";
import type { OpenFile } from "./store.js";

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
        return (
          <div
            key={`${tab.repo}:${tab.path}`}
            className={cn(
              "group flex min-w-0 items-center border-e border-line",
              selected ? "bg-surface-2" : "bg-bg",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={tab.path}
              onClick={() => onSelect(tab)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab);
                }
              }}
              className={cn(
                "flex min-h-8 min-w-0 items-center gap-1.5 px-3 py-1 text-start outline-none",
                "[@media(pointer:coarse)]:min-h-11",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              )}
            >
              <span className="typed text-xs text-ink-3" title={file ? statusLabel(file.status) : undefined}>
                {mark}
              </span>
              <span className="typed min-w-0 truncate text-xs text-ink">{fileName(tab.path)}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${fileName(tab.path)}`}
              onClick={() => onClose(tab)}
              className={cn(
                "flex size-7 items-center justify-center text-ink-3 outline-none",
                "[@media(pointer:coarse)]:size-11",
                "hover:bg-surface-2 hover:text-ink",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              )}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
