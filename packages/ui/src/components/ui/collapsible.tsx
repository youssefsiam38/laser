import type * as React from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { useExitPresence } from "@/components/ui/exit-presence";
import { cn } from "@/lib/utils";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

/** Instant: DESIGN.md's motion budget is the status sweep, the streaming caret and the sheet slide. */
function CollapsibleContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const contentRef = useExitPresence<HTMLDivElement>(ref);
  return (
    // A collapsed body is `Presence`'s too: callers animate it with
    // `data-[state=closed]:animate-collapsible-up`, and an exit that never
    // ends leaves the "collapsed" content open (`exit-presence.ts`).
    <CollapsiblePrimitive.CollapsibleContent
      ref={contentRef}
      data-slot="collapsible-content"
      className={cn(
        "overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
