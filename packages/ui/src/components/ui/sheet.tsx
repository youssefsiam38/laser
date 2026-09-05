import type * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--ink)_28%,transparent)]",
        "animate-in fade-in-0 duration-(--motion-slow) data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Side panel. Slides 200ms ease-out (DESIGN.md motion). Safe-area padding is
 * applied on the axis that touches the screen edge.
 */
function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col bg-surface text-sm text-ink shadow-float outline-none",
          "duration-(--motion-slow) ease-out animate-in data-[state=closed]:animate-out",
          side === "right" &&
            "inset-y-0 end-0 h-full w-[min(88vw,320px)] border-s border-line pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] slide-in-from-right data-[state=closed]:slide-out-to-right",
          side === "left" &&
            "inset-y-0 start-0 h-full w-[min(88vw,320px)] border-e border-line pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] slide-in-from-left data-[state=closed]:slide-out-to-left",
          side === "top" &&
            "inset-x-0 top-0 h-auto max-h-[min(85dvh,calc(var(--vvh,100dvh)-24px))] rounded-b-2xl border-b border-line pt-[env(safe-area-inset-top)] slide-in-from-top data-[state=closed]:slide-out-to-top",
          side === "bottom" &&
            "inset-x-0 bottom-0 h-auto max-h-[min(85dvh,calc(var(--vvh,100dvh)-24px))] rounded-t-2xl border-t border-line pb-[max(env(safe-area-inset-bottom),var(--kb))] slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
          className,
        )}
        {...props}
      >
        {side === "bottom" && (
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line" />
        )}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="absolute end-3 top-[calc(env(safe-area-inset-top)+12px)] text-ink-3"
            >
              <XIcon />
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex min-h-12 flex-col justify-center gap-0.5 px-4 py-3 pe-12", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 border-t border-line p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base leading-5 font-semibold tracking-title text-ink", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-xs text-ink-2", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
