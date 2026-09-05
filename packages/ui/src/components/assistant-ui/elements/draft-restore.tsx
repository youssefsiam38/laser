"use client";
/**
 * Draft restore — an unsent composer draft, per session, across reloads
 * (docs/ux-elements.md "Composer"). Installed from `elements-draft-restore`
 * and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - `useComposerDraft` and `ComposerDraftRestore` bind it to the runtime:
 *     the composer's text is saved per session path in `localStorage` while
 *     it is non-empty, dropped when it is sent or cleared, and offered back
 *     when the same session opens with an empty composer.
 *   - `savedAt` is a real time, formatted relatively, not a string prop.
 */
import { storageKey } from "@piorbit/protocol";
import { useAui, useAuiState } from "@assistant-ui/react";
import { PencilLineIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitView } from "@/runtime";

import { mono, paper } from "./surfaces.js";

export interface DraftRestoreProps extends Omit<ComponentProps<"div">, "children"> {
  draft: string;
  /** ISO time the draft was last saved. */
  savedAt: string;
  onRestore?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
}

export function DraftRestore({ draft, savedAt, onRestore, onDiscard, className, ...props }: DraftRestoreProps) {
  return (
    <div
      data-slot="draft-restore"
      role="status"
      className={cn(
        paper,
        "flex w-full items-center gap-2.5 rounded-xl py-2 pe-2 ps-3.5",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-(--motion-slow)",
        className,
      )}
      {...props}
    >
      <PencilLineIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-ink-2">{draft}</span>
        <span className={cn(mono, "text-ink-3")}>unsent draft · {relativeTime(savedAt)}</span>
      </div>
      <Button variant="outline" size="xs" onClick={onRestore} className="shrink-0">
        Restore
      </Button>
      <TooltipIconButton tooltip="Discard the draft" size="icon-xs" side="top" onClick={onDiscard} className="text-ink-3">
        <XIcon />
      </TooltipIconButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runtime binding
// ---------------------------------------------------------------------------

export const DRAFT_STORAGE_PREFIX = storageKey("draft:");
const SAVE_DEBOUNCE_MS = 300;

interface SavedDraft {
  text: string;
  at: string;
}

const draftKey = (path: string): string => `${DRAFT_STORAGE_PREFIX}${path}`;

export function readDraft(path: string): SavedDraft | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(draftKey(path));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { text, at } = parsed as Partial<SavedDraft>;
    return typeof text === "string" && text.trim() && typeof at === "string" ? { text, at } : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraft(path: string, text: string | undefined): void {
  try {
    if (text === undefined) globalThis.localStorage?.removeItem(draftKey(path));
    else globalThis.localStorage?.setItem(draftKey(path), JSON.stringify({ text, at: new Date().toISOString() }));
  } catch {
    /* private mode / quota: the draft lives for this tab */
  }
}

/**
 * Keeps the composer's text in storage while it is non-empty and offers a
 * saved one back when the session opens with an empty composer.
 */
export function useComposerDraft(path: string | undefined): {
  saved: SavedDraft | undefined;
  restore(): void;
  discard(): void;
} {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const [saved, setSaved] = useState<SavedDraft | undefined>(() => (path ? readDraft(path) : undefined));
  const lastText = useRef(text);

  // A new session: read its draft, and forget the previous one's offer.
  useEffect(() => {
    setSaved(path ? readDraft(path) : undefined);
  }, [path]);

  useEffect(() => {
    if (!path) return;
    const was = lastText.current;
    lastText.current = text;
    if (text.trim()) {
      // Typing dismisses the offer; the text now on screen is the draft.
      setSaved(undefined);
      const timer = setTimeout(() => writeDraft(path, text), SAVE_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }
    // Non-empty → empty is a send or a deliberate clear: the draft is spent.
    if (was.trim()) writeDraft(path, undefined);
    return undefined;
  }, [path, text]);

  return {
    saved,
    restore: () => {
      if (!saved) return;
      const current = aui.composer.getState().text;
      aui.composer.setText(current ? `${current}\n${saved.text}` : saved.text);
      setSaved(undefined);
    },
    discard: () => {
      if (path) writeDraft(path, undefined);
      setSaved(undefined);
    },
  };
}

/** The offer above the composer, when the open session has an unsent draft. */
export function ComposerDraftRestore({ className }: { className?: string | undefined }) {
  const view = usePiorbitView();
  const { saved, restore, discard } = useComposerDraft(view?.path);
  if (!saved) return null;
  return <DraftRestore draft={saved.text} savedAt={saved.at} onRestore={restore} onDiscard={discard} className={className} />;
}
