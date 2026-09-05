import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Plain textarea. `field-sizing-content` autosizes where supported; set
 * `max-h-*` on it to cap growth (the composer caps at 8 lines).
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content min-h-16 w-full min-w-0 resize-none rounded-lg",
        "border border-line bg-surface px-3 py-2 text-base leading-base text-ink",
        "placeholder:text-ink-3",
        "transition-[border-color,background-color] duration-(--motion-instant) outline-none",
        "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
        "focus-visible:border-live focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live/25",
        "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25",
        "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
