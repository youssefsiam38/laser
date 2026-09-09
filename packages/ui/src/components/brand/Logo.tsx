import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { PRODUCT_MARK_PATHS, PRODUCT_MARK_VIEW_BOX } from "@lasercode/protocol/startup-screen";
import type { ComponentProps, SVGProps } from "react";

import { cn } from "@/lib/utils";

/** The approved product mark copied from the laser.hubtrix.com brand assets. */
export function LaserLogo({ className, ...props }: Omit<ComponentProps<"img">, "src" | "alt">) {
  return (
    <img
      src="/icons/mark-192.png"
      alt={PRODUCT_DISPLAY_NAME}
      draggable={false}
      className={cn("block select-none", className)}
      {...props}
    />
  );
}

/**
 * The website's transparent mark, adapted to the active theme for contrast.
 *
 * The paths come from `@lasercode/protocol/startup-screen` rather than from
 * this file: the opening screen is drawn a second time, as a standalone
 * document, before the app exists, and one mark that two renderers share
 * cannot drift from itself.
 */
export function LaserMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={PRODUCT_MARK_VIEW_BOX} className={cn("block text-ink", className)} {...props}>
      {PRODUCT_MARK_PATHS.map((path) => (
        <path key={path.d} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}
