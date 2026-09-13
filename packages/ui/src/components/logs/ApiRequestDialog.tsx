"use client";
/**
 * The API request inspector's dialog frame (M16-T31).
 *
 * The inspector is the heaviest reading surface in the app: the request model,
 * the provenance marker with the instruction-template vocabulary it names
 * fields from (and, through it, the template engine), the JSON viewer, the
 * request find bar. A conversation opens without any of it, and most
 * conversations never open it at all — so the frame is all that ships in the
 * first chunk, and the body arrives when a person asks for a request.
 *
 * The frame is not a placeholder: it is the dialog, with its title, its capture
 * picker and the same loader the inspector shows while it fetches a capture.
 * The body replaces the loader inside a dialog that is already open, so the
 * person sees one surface filling in, never a screen swapped for a screen.
 */
import { lazy, Suspense } from "react";
import { Braces } from "lucide-react";
import type { LogEntry } from "@lasercode/protocol";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ApiRequestCaptureBar, ApiRequestLoading, NO_CAPTURES } from "./api-request-frame.js";

/** A capture reached from the Logs page, or the requests behind one message. */
export type ApiRequestTarget = { kind: "log"; entry: LogEntry } | {
  kind: "message"; path: string; entryId?: string; at?: string; beforeAt?: string;
};

const ApiRequestDialogBody = lazy(() =>
  import("./ApiRequestDialogBody.js").then((module) => ({ default: module.ApiRequestDialogBody })),
);

/** Both entry points mount this same inspector; nothing sends a model request. */
export function ApiRequestDialog({ target, onClose }: { target: ApiRequestTarget; onClose: () => void }) {
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent dir="ltr" onEscapeKeyDown={e=>{
      const modal=e.target instanceof Element?e.target.closest('[role="dialog"]'):null;
      const closeSources=modal?.querySelector<HTMLButtonElement>('[data-close-source-panel]');
      if(closeSources){e.preventDefault();closeSources.click();return;}
      const closeFind=modal?.querySelector<HTMLButtonElement>('[data-request-find] [aria-label="Close search"]');
      if(closeFind){e.preventDefault();closeFind.click();}
    }} className="flex h-[85dvh] w-[96vw] max-w-none min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[80dvh] sm:w-[80vw] sm:max-w-none">
      <DialogHeader className="shrink-0 border-b border-line p-5 pe-14">
        <DialogTitle className="flex items-center gap-2"><Braces className="size-5 text-live" />API request</DialogTitle>
        <DialogDescription>Inspect what the engine prepared for the provider: instructions, context, tools and settings.</DialogDescription>
      </DialogHeader>
      <Suspense fallback={<>
        <ApiRequestCaptureBar captures={NO_CAPTURES} loading />
        <ApiRequestLoading label="Loading captured requests" />
      </>}>
        <ApiRequestDialogBody target={target} />
      </Suspense>
    </DialogContent>
  </Dialog>;
}
