import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Loading placeholder. Quiet: a plain surface-2 block — the motion budget in
 * DESIGN.md has no room for a shimmer. Compose rows with the `SkeletonText` shape.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "rounded-md bg-surface-2",
        className,
      )}
      {...props}
    />
  );
}

/** A line of placeholder text, sized to the type scale. */
function SkeletonText({
  className,
  width = "100%",
  ...props
}: React.ComponentProps<"div"> & { width?: string | number }) {
  return (
    <Skeleton
      className={cn("h-3.5 rounded-[3px]", className)}
      style={{ width, ...props.style }}
      {...props}
    />
  );
}

export { Skeleton, SkeletonText };
