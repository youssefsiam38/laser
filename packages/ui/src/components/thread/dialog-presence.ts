"use client";
/**
 * A dialog that actually leaves the document.
 *
 * Radix keeps a closed dialog mounted until its exit animation reports
 * `animationend`, and decides to wait on the computed `animation-name` alone.
 * The two do not always agree: a zero-duration animation — which is what
 * `--motion-instant` compiles to when Motion is reduced — still computes
 * `animation-name: exit`, but the engine creates no animation for it, so no
 * `animationstart`, `animationend` or `animationcancel` is ever delivered.
 * `Presence` parks in `unmountSuspended` and the closed dialog stays in the
 * document, painted over the page, with its buttons still clickable.
 *
 * So presence is ours, not the animation's: the dialog element is rendered
 * only while `mounted`, `open` drives the fade, and one exit window after the
 * close the element comes out whether or not anything ended.
 *
 * The right home for this is the shared dialog; until that surface is free,
 * every dialog in the transcript that survives its own close uses this hook.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Room for the frame the exit is scheduled on, on top of its duration. */
export const DIALOG_EXIT_SLACK_MS = 40;
/** Used when the motion token cannot be read (no document, no value). */
export const DIALOG_EXIT_FALLBACK_MS = 160;

export function dialogExitMs(token: string | undefined): number {
  const raw = (token ?? "").trim();
  const value = raw.endsWith("ms")
    ? Number.parseFloat(raw)
    : raw.endsWith("s")
      ? Number.parseFloat(raw) * 1000
      : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return DIALOG_EXIT_FALLBACK_MS;
  return value + DIALOG_EXIT_SLACK_MS;
}

function exitWindow(): number {
  if (typeof document === "undefined") return DIALOG_EXIT_FALLBACK_MS;
  return dialogExitMs(getComputedStyle(document.documentElement).getPropertyValue("--motion-instant"));
}

export interface DialogPresence {
  /** Render the dialog element only while this is true. */
  mounted: boolean;
  /** What Radix animates. */
  open: boolean;
  show(): void;
  hide(): void;
}

export function useDialogPresence(): DialogPresence {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  useEffect(() => () => clear(), [clear]);

  const show = useCallback(() => {
    clear();
    setMounted(true);
    setOpen(true);
  }, [clear]);

  const hide = useCallback(() => {
    setOpen(false);
    clear();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setMounted(false);
    }, exitWindow());
  }, [clear]);

  return { mounted, open, show, hide };
}
