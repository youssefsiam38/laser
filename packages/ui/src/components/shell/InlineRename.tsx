import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface InlineRenameProps {
  initial: string;
  /** Called with the trimmed, changed name. Not called when unchanged or empty. */
  onCommit(name: string): void;
  onCancel(): void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * The in-place text field used by the session title (top bar) and session
 * rows. Enter commits, Escape cancels, blur commits; a settled field never
 * fires twice.
 */
export function InlineRename({ initial, onCommit, onCancel, className, placeholder, ariaLabel }: InlineRenameProps) {
  const [draft, setDraft] = useState(initial);
  const settled = useRef(false);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (commit && next && next !== initial) onCommit(next);
    else onCancel();
  };

  return (
    <form
      className={cn("flex min-w-0 flex-1", className)}
      onSubmit={(e) => {
        e.preventDefault();
        finish(true);
      }}
    >
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={ariaLabel ?? "Session name"}
        placeholder={placeholder ?? "Session name"}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "h-7 w-full min-w-0 rounded-md border border-live bg-surface px-2 text-sm font-medium text-ink",
          "outline-none ring-2 ring-live/25 placeholder:font-normal",
        )}
      />
    </form>
  );
}
