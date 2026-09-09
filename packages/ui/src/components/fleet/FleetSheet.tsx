"use client";
/**
 * The fleet below desktop width, exactly as the monitor falls back: the same
 * panel, in a sheet. Nothing here is a second design — a narrow window has
 * less room, not a different product.
 *
 * It steps aside when the conversation changes, because opening a run's chat
 * from here is a move to another session and the sheet is something you do
 * *instead of* the conversation. Opening it on a session you stay in is not a
 * change, so that is remembered.
 */
import { useEffect, useRef } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { closeFleetSheet, useFleetSheetOpen } from "@/fleet/fleet-state";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useLaserState } from "@/runtime";
import type { AppState } from "@/store";

import { FleetPanel } from "./FleetPanel.js";

export function FleetSheet() {
  const open = useFleetSheetOpen();
  const mobile = useIsMobile();
  const current = useLaserState((s: AppState) => s.current);
  const shownFor = useRef(current);

  useEffect(() => {
    if (!open || shownFor.current === current) {
      shownFor.current = current;
      return;
    }
    shownFor.current = current;
    closeFleetSheet();
  }, [current, open]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && closeFleetSheet()}>
      <SheetContent side={mobile ? "bottom" : "right"} className={cn("flex flex-col gap-0 p-0", mobile ? "h-[85dvh]" : "w-[min(92vw,360px)]")}>
        <SheetTitle className="sr-only">Fleet</SheetTitle>
        <SheetDescription className="sr-only">Every agent and background command, in every project.</SheetDescription>
        <FleetPanel variant="sheet" />
      </SheetContent>
    </Sheet>
  );
}
