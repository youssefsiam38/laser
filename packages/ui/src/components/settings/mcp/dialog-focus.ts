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

/**
 * Controlled dialogs have no Radix Trigger to restore automatically. Keep the
 * exact opener through the close render, and settle focus in Radix's own close
 * lifecycle. Invalid or departed targets suppress restoration entirely so an
 * old dialog cannot take focus from a successor.
 */
export function useMcpDialogFocusReturn(open: boolean, target: McpDialogFocusTarget | undefined) {
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
    }
  }, []);
}
