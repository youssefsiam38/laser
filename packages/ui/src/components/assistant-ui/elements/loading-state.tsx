"use client";
/**
 * Loader (`elements-loading-state`): a 3×3 matrix that keeps time while
 * there is nothing to show yet, with a shimmering label beneath it. Used for
 * session hydration, the entries fetch, the model list and a panel body
 * before its first data.
 *
 * Divergences from the registry copy, each on purpose:
 *   - `tick` is optional. Left out, the loader drives itself off the
 *     `--motion-fast` token, and holds still when that token is zero
 *     (reduced motion), so no caller has to own an interval.
 *   - Left-aligned like everything else in the thread; no `items-center`.
 *   - Cells are `--ink-3`, the label is `--ink-2`; no `foreground/55` alphas.
 */
import { createElement, useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import {
  STARTUP_SCREEN_EXIT_CLASS,
  STARTUP_SCREEN_ROOT_CLASS,
  startupScene,
  type StartupNode,
} from "@lasercode/protocol/startup-screen";

import { useTick } from "@/components/thread/timing";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";

import { ShimmerLabel } from "./surfaces.js";

export type GenerationLoaderVariant = "dots" | "squares" | "rounded";

export interface GenerationLoaderProps extends Omit<ComponentProps<"div">, "children"> {
  /** What is being waited for, in words a person reads: "Loading session". */
  label: string;
  /** Drive the matrix from outside; omit to let it tick on its own. */
  tick?: number | undefined;
  variant?: GenerationLoaderVariant;
  /** `inline` fits a row (a menu, a table cell); `block` stands alone. */
  layout?: "inline" | "block";
}

const CELL_SHAPES: Record<GenerationLoaderVariant, string> = {
  dots: "rounded-full",
  squares: "rounded-[1px]",
  rounded: "rounded-xs",
};

export function GenerationLoader({ label, tick, variant = "dots", layout = "block", className, ...props }: GenerationLoaderProps) {
  const step = motionMs("--motion-fast");
  const own = useTick(tick === undefined && step > 0, Math.max(step, 50) * 2);
  const frame = tick ?? own;
  const pixelOffset = Math.floor(frame / 3);

  return (
    <div
      data-slot="generation-loader"
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn(layout === "block" ? "flex flex-col items-start gap-3" : "flex items-center gap-2.5", className)}
      {...props}
    >
      <div aria-hidden="true" className={cn("grid grid-cols-3", layout === "block" ? "gap-1" : "gap-px")}>
        {Array.from({ length: 9 }, (_, index) => {
          const active = (index * 2 + pixelOffset) % 9 < 3;
          return (
            <span
              key={index}
              className={cn(
                "bg-ink-3 transition-opacity duration-(--motion-fast) motion-reduce:transition-none",
                layout === "block" ? "size-1.5" : "size-1",
                CELL_SHAPES[variant],
                active ? "opacity-90" : "opacity-20",
              )}
            />
          );
        })}
      </div>
      <ShimmerLabel className="relative inline-block text-sm">{label}</ShimmerLabel>
    </div>
  );
}

interface StartupRestorationScreenProps {
  label: string;
  exiting?: boolean;
  notice?: ReactNode;
  onExited?: () => void;
}

/**
 * Attribute names that React spells differently from HTML. Everything else in
 * the scene — `viewBox`, `gradientUnits`, `pathLength`, `x1` — React already
 * passes through under its own name.
 */
const REACT_ATTRIBUTE: Record<string, string> = {
  class: "className",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
};

/** The shared scene, as React elements. The tree itself lives in the protocol. */
function renderNode(node: StartupNode, key: number): ReactNode {
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    props[REACT_ATTRIBUTE[name] ?? name] = value;
  }
  if (node.text !== undefined) return createElement(node.tag, props, node.text);
  return createElement(node.tag, props, (node.children ?? []).map(renderNode));
}

/**
 * The document paints this screen before React exists — `index.html` carries
 * the same scene, and in the desktop the shell has been showing it while the
 * host started. So the first mount of the session takes over something
 * identical and must not fade in over it; a later one, when a session
 * reconnects mid-flight, is a real arrival and keeps the animation.
 */
let takingOverTheFirstFrame = true;

/**
 * Full-window form of the catalog Loader. The converging SVG paths follow
 * Magic UI's Animated Beam composition, but use Laser's mark, motion tokens
 * and theme colours instead of the registry demo's integration logos.
 *
 * The composition is not written here. It comes from
 * `@lasercode/protocol/startup-screen`, which the desktop shell serializes to
 * a standalone document and shows while the host is still starting — so the
 * screen a person is already looking at is this one, and the app taking over
 * changes nothing on the glass. Its rules live in `globals.css` between the
 * `@startup-screen` markers, pinned to the same module by
 * `test/startup-screen.test.ts`.
 */
export function StartupRestorationScreen({ label, exiting = false, notice, onExited }: StartupRestorationScreenProps) {
  const idPrefix = useId().replaceAll(":", "");
  const [continuing] = useState(() => {
    if (exiting || !takingOverTheFirstFrame) return false;
    takingOverTheFirstFrame = false;
    return true;
  });

  return (
    <div
      data-slot="startup-restoration"
      data-exiting={exiting || undefined}
      data-continuing={continuing || undefined}
      role={exiting ? undefined : "status"}
      aria-live={exiting ? undefined : "polite"}
      aria-busy={exiting ? undefined : "true"}
      aria-label={exiting ? undefined : label}
      aria-hidden={exiting || undefined}
      className={cn(STARTUP_SCREEN_ROOT_CLASS, exiting && STARTUP_SCREEN_EXIT_CLASS)}
      onAnimationEnd={(event) => {
        if (exiting && event.currentTarget === event.target) onExited?.();
      }}
    >
      {!exiting && notice}
      {startupScene({ idPrefix, title: PRODUCT_DISPLAY_NAME, label }).map(renderNode)}
    </div>
  );
}

interface StartupRestorationGateProps {
  active: boolean;
  label: string;
  notice?: ReactNode;
  /**
   * Questions the host can ask before the shell exists — project trust holds
   * the very session load this screen is waiting on. They mount in both
   * states, so a person can answer while the screen is up and the answer is
   * what lets it come down; leaving them in the shell would hide them until
   * the host gave up on its own.
   */
  prompts?: ReactNode;
  children: ReactNode;
}

/** Do not mount the operational shell until restoration is complete. */
export function StartupRestorationGate({ active, label, notice, prompts, children }: StartupRestorationGateProps) {
  const [overlayPresent, setOverlayPresent] = useState(active);

  useEffect(() => {
    if (active) setOverlayPresent(true);
  }, [active]);

  if (active) {
    return (
      <>
        {prompts}
        <StartupRestorationScreen label={label} notice={notice} />
      </>
    );
  }

  return (
    <>
      {prompts}
      {children}
      {overlayPresent && (
        <StartupRestorationScreen
          label={label}
          exiting
          notice={notice}
          onExited={() => setOverlayPresent(false)}
        />
      )}
    </>
  );
}
