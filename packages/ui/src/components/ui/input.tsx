import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Single-line text field. Installed by the `thread-list` element's registry
 * dependency and restyled to DESIGN.md tokens: hairline border, `--surface`
 * ground, `--live` focus ring. 16px on touch comes from `globals.css`.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink",
        "placeholder:text-ink-3 transition-[border-color] duration-(--motion-instant) outline-none",
        "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
        "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
        "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25",
        "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
