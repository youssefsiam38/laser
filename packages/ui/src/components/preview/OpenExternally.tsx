"use client";
/**
 * The body for a document piorbit will not draw (M8-T3).
 *
 * The panel contract is explicit that `renderable: false` degrades to "open
 * this elsewhere" and never to a broken viewer, so this card is a designed
 * state, not a fallback: it names the format, says plainly that we do not
 * render it, and offers only the things that actually work here.
 *
 * Capability honesty (R2) decides the controls. Opening a file with the
 * operating system's handler is something the desktop shell can do and a phone
 * over the relay cannot, so the button appears only when the caller passes
 * `onOpen`; copying the path appears only when there is a path. Nothing is
 * rendered disabled with a shrug.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { Check, Copy, ExternalLink, FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

import { describeMediaType } from "./media.js";

export interface OpenExternallyProps {
  mediaType: string;
  /** Where the file lives, when it lives somewhere. */
  path?: string | undefined;
  /** Ask the shell to open it with the OS handler. Omitted where that cannot work. */
  onOpen?: (() => void) | undefined;
  className?: string | undefined;
}

export function OpenExternally({ mediaType, path, onOpen, className }: OpenExternallyProps) {
  const { copied, copy } = useCopy();
  const format = describeMediaType(mediaType);

  return (
    <div
      data-slot="open-externally"
      className={cn("flex min-h-0 flex-1 items-center justify-center overflow-auto p-6", className)}
    >
      <div className="flex max-w-[46ch] flex-col items-center gap-3 text-center">
        <FileQuestion aria-hidden="true" className="size-6 text-ink-3" />
        <p className="text-md font-semibold text-ink">
          {PRODUCT_NAME} does not draw {format} files
        </p>
        <p className="text-sm text-ink-2">
          Rather than show you a broken viewer, it stays out of the way. Open the file in the app that handles it.
        </p>

        {path ? (
          <p className="typed w-full truncate text-ink-3" title={path}>
            {path}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onOpen ? (
            <Button variant="secondary" size="sm" onClick={onOpen}>
              <ExternalLink />
              Open
            </Button>
          ) : null}
          {path ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(path)}
              className={cn(copied && "text-ok")}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy path"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
