"use client";
import { useCallback, useLayoutEffect, useRef } from "react";

/** One MCP dialog opener, valid only while its owning Settings target survives. */
export interface McpDialogFocusTarget {
  readonly element: HTMLElement;
  isCurrent(): boolean;
  invalidate(): void;
}

export function createMcpDialogFocusTarget(element: HTMLElement, targetIsCurrent: () => boolean): McpDialogFocusTarget {
  let active = true;
  return {
    element,
    isCurrent: () => active && targetIsCurrent(),
    invalidate: () => { active = false; },
  };
}

/** Restore only after a successful write replaced the original control. */
export function restoreMcpDialogFocusFallback(target: McpDialogFocusTarget, fallback: HTMLElement | null): boolean {
  if (!target.isCurrent() || target.element.isConnected || !fallback?.isConnected) return false;
  if (fallback.matches(":disabled, [aria-disabled='true']") || fallback.closest("[inert]")) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement && active.isConnected) return false;
  fallback.focus({ preventScroll: true });
  return document.activeElement === fallback;
}

/**
 * Controlled dialogs have no Radix Trigger to restore automatically. Keep the
 * exact opener through the close render, and settle focus in Radix's own close
 * lifecycle. Invalid or departed targets suppress restoration entirely so an
 * old dialog cannot take focus from a successor.
 */
export function useMcpDialogFocusReturn(
  open: boolean,
  target: McpDialogFocusTarget | undefined,
  fallback?: () => HTMLElement | null,
) {
  const closingTarget = useRef<McpDialogFocusTarget | undefined>(undefined);
  useLayoutEffect(() => {
    if (open && target) closingTarget.current = target;
  }, [open, target]);

  return useCallback((event: { preventDefault(): void }) => {
    event.preventDefault();
    const candidate = closingTarget.current;
    closingTarget.current = undefined;
    if (candidate?.isCurrent() && candidate.element.isConnected) {
      candidate.element.focus({ preventScroll: true });
    } else if (candidate) {
      restoreMcpDialogFocusFallback(candidate, fallback?.() ?? null);
    }
  }, [fallback]);
}
