import { useState, type ComponentProps, type MouseEvent, type ReactElement } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A hint on something that is not a control: a branch name, a count, a path.
 *
 * The native `title` attribute cannot do this job. It never opens for the
 * keyboard, it never opens for touch, it draws the browser's chrome instead of
 * the app's, and a screen reader announces it as a second name for something
 * that already has one. So the text goes in the app's own tooltip
 * (DESIGN.md "Tooltip icon button" is the same tooltip, for buttons), on a
 * trigger that takes focus, and a tap opens it too — the same information by
 * pointer, by keyboard and by finger.
 *
 * The hint is a description, never a name: the element inside keeps its own
 * text and its own `aria-label`, and the hint never repeats either. Requires a
 * `<TooltipProvider>` above it, like every other tooltip in the app.
 */
export type HintProps = Omit<ComponentProps<"span">, "title"> & {
  /** What the tooltip says. Never a copy of the trigger's own accessible name. */
  hint: string;
  side?: "top" | "bottom" | "left" | "right";
};

/**
 * The same hint on something that is already a control. The control keeps its
 * own words and its own focus — no second tab stop, no `aria-label` echo — and
 * the tooltip adds what those words leave out. `undefined` renders the control
 * alone, so a row that only sometimes has more to say stays one expression.
 */
export function ControlHint({
  hint,
  side = "top",
  children,
}: {
  hint?: string | undefined;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  if (!hint) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-80 whitespace-pre-wrap">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

export function Hint({ hint, side = "top", className, children, onClick, ...rest }: HintProps) {
  // Radix opens a tooltip on hover and on focus, and closes it on a pointer
  // press — which is every tap. Owning `open` lets the tap that Radix just
  // dismissed be the gesture that opens it on a phone.
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          data-slot="hint"
          tabIndex={0}
          onClick={(event: MouseEvent<HTMLSpanElement>) => {
            setOpen(true);
            onClick?.(event);
          }}
          className={cn(
            "rounded-sm outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            className,
          )}
          {...rest}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-80 whitespace-pre-wrap">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
