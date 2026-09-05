import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Pill for status and metadata. Tonal variants use a 12% tint of the status
 * color with the status color as ink, which reads in both themes. `outline`
 * is the hairline pill; `mono` is a typed value (model ids, extension names).
 */
const badgeVariants = cva(
  [
    "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap",
    "h-5 rounded-full border border-transparent px-2 text-xs font-medium leading-none",
    "transition-colors duration-(--motion-instant) [&>svg]:pointer-events-none [&>svg]:size-3",
    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
  ],
  {
    variants: {
      variant: {
        default: "bg-surface-2 text-ink-2",
        outline: "border-line bg-transparent text-ink-2",
        mono: "border-line bg-transparent px-1.5 font-mono text-xs tracking-typed text-ink-2 tnum",
        live: "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live",
        attention: "bg-[color-mix(in_oklab,var(--attention)_14%,transparent)] text-attention",
        danger: "bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] text-danger",
        ok: "bg-[color-mix(in_oklab,var(--ok)_12%,transparent)] text-ok",
        solid: "bg-live text-on-live",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
