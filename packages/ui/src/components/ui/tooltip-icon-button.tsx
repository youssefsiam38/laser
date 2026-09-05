import type * as React from "react";
import { Slot } from "radix-ui";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type TooltipIconButtonProps = Omit<ButtonProps, "size"> & {
  /** Visible tooltip text; also used as the accessible name. */
  tooltip: string;
  /** Optional keyboard shortcut rendered inside the tooltip, e.g. "⌘N". */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  size?: "icon" | "icon-sm" | "icon-xs" | "icon-lg";
  ref?: React.Ref<HTMLButtonElement>;
};

/**
 * Icon-only button with a tooltip and an aria-label. Requires a
 * <TooltipProvider> above it (mount one at the app root).
 */
function TooltipIconButton({
  children,
  tooltip,
  shortcut,
  side = "bottom",
  size = "icon-sm",
  variant = "ghost",
  className,
  ...rest
}: TooltipIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size={size}
          aria-label={tooltip}
          {...rest}
          className={cn("shrink-0", className)}
        >
          <Slot.Slottable>{children}</Slot.Slottable>
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {tooltip}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export { TooltipIconButton };
