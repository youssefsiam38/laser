import type * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { useDirection } from "@/hooks/use-direction";
import { logicalSide } from "@/theme/direction";

function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  side = "top",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const direction = useDirection();
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        side={logicalSide(side, direction)}
        dir={direction}
        className={cn(
          "z-50 inline-flex w-fit max-w-64 items-center gap-2 rounded-md px-2 py-1",
          "bg-ink text-bg text-xs font-medium leading-4",
          "shadow-float-sm select-none",
          "animate-in fade-in-0 duration-(--motion-instant) data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          "[&_[data-slot=kbd]]:border-bg/20 [&_[data-slot=kbd]]:bg-bg/15 [&_[data-slot=kbd]]:text-bg",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
