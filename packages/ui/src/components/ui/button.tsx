import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none",
    "rounded-lg text-sm font-medium leading-none",
    "transition-[background-color,color,border-color,opacity,transform] duration-75 ease-out",
    "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
    "active:translate-y-px disabled:pointer-events-none disabled:opacity-45",
    "aria-invalid:border-danger",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-live text-on-live hover:bg-[color-mix(in_oklab,var(--live)_88%,var(--ink))] active:bg-[color-mix(in_oklab,var(--live)_80%,var(--ink))]",
        secondary:
          "bg-surface-2 text-ink hover:bg-[color-mix(in_oklab,var(--surface-2)_82%,var(--ink))] active:bg-[color-mix(in_oklab,var(--surface-2)_72%,var(--ink))]",
        outline:
          "border border-line bg-surface text-ink hover:bg-surface-2 hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))] active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
        ghost:
          "text-ink-2 hover:bg-surface-2 hover:text-ink active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] data-[state=open]:bg-surface-2 data-[state=open]:text-ink",
        destructive:
          "bg-danger text-on-danger hover:bg-[color-mix(in_oklab,var(--danger)_88%,var(--ink))] active:bg-[color-mix(in_oklab,var(--danger)_80%,var(--ink))] focus-visible:outline-danger",
        "destructive-ghost":
          "text-danger hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] active:bg-[color-mix(in_oklab,var(--danger)_16%,transparent)] focus-visible:outline-danger",
        link: "h-auto rounded-none px-0 text-live underline-offset-4 hover:underline active:translate-y-0",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 rounded-md px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-4 text-base has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-sm": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    />
  );
}

export { Button, buttonVariants, type ButtonProps };
