"use client";
/**
 * One frame on the canvas: a screen, its chrome and its chips (M21-T11).
 *
 * The chrome says three things a person needs before they read a pixel: what
 * the screen is called, how grounded it is (Mapped, Proposed, Sketch — never
 * Native, which is Build evidence, D-353), and whether anything in it leans on
 * an index entry nobody has reviewed. The Sketch/Tree chip is here too,
 * because "which one am I looking at" belongs on the thing itself.
 */
import { FlaskConical, Layers, Link2Off, MessageSquare } from "lucide-react";
import type { DesignBody, DesignScreen } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CANVAS_VIEWPORTS, frameSize } from "@/design/canvas";
import { counterpartScreen, sketchOfScreen, unreviewedNodes } from "@/design/tree-model";
import { screenFidelity } from "@lasercode/protocol";

import type { DesignPin } from "@/design/review";

import { SketchFrame } from "./SketchFrame.js";
import { TreeFrame } from "./TreeFrame.js";
import type { KitRenderContext } from "./kit/KitNode.js";

export const FIDELITY_LABEL: Readonly<Record<string, string>> = {
  sketch: "Sketch",
  mapped: "Mapped",
  proposed: "Proposed",
  native: "Native",
};

export const FIDELITY_TONE = { sketch: "attention", mapped: "ok", proposed: "live", native: "outline" } as const;

export interface SketchBytes {
  document?: string | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
}

export function ScreenFrame({
  body,
  screen,
  context,
  tokenProperties,
  sketchBytes,
  selected,
  onSelectScreen,
  onFlip,
  pins,
  onSelectPin,
  theme,
  className,
}: {
  body: DesignBody;
  screen: DesignScreen;
  context: KitRenderContext;
  tokenProperties: Readonly<Record<string, string>>;
  sketchBytes?: SketchBytes | undefined;
  selected: boolean;
  onSelectScreen?: ((screenId: string) => void) | undefined;
  /** Flip to the sketch this tree was grounded from, or back. */
  onFlip?: ((screenId: string) => void) | undefined;
  /** Comments pinned to this screen or to a node inside it (M21-T13). */
  pins?: readonly DesignPin[] | undefined;
  onSelectPin?: ((pin: DesignPin) => void) | undefined;
  theme?: string | undefined;
  className?: string;
}) {
  const size = frameSize(screen.viewport);
  const sketch = sketchOfScreen(body, screen);
  const fidelity = screenFidelity(screen);
  const unreviewed = unreviewedNodes(screen);
  const counterpart = counterpartScreen(body, screen);
  const viewportLabel = screen.viewport ? (CANVAS_VIEWPORTS[screen.viewport]?.label ?? screen.viewport) : undefined;

  return (
    <div
      data-slot="design-screen-frame"
      data-screen-id={screen.id}
      data-fidelity={fidelity}
      data-selected={selected ? "true" : undefined}
      className={cn("flex flex-col rounded-lg border bg-surface", selected ? "border-live" : "border-line", className)}
      style={{ width: `${String(size.width)}px` }}
    >
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => onSelectScreen?.(screen.id)}
          className="min-w-0 flex-1 truncate rounded text-start text-sm leading-5 font-medium text-ink outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
        >
          {screen.name}
        </button>
        <Badge variant={FIDELITY_TONE[fidelity]}>{FIDELITY_LABEL[fidelity]}</Badge>
        {unreviewed.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="attention" tabIndex={0}>
                {unreviewed.length} unreviewed
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {unreviewed.length === 1 ? "One node uses" : `${String(unreviewed.length)} nodes use`} an index entry nobody has reviewed yet. Accept it in the Design Index panel to
              make this screen Mapped.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {viewportLabel ? <Badge variant="mono">{viewportLabel}</Badge> : null}
        {counterpart && onFlip ? (
          <Button size="xs" variant="outline" onClick={() => onFlip(counterpart.id)}>
            {sketch ? <Layers /> : <FlaskConical />}
            {sketch ? "Design" : "Sketch"}
          </Button>
        ) : null}
      </div>

      {/* The pins of this screen. A comment anchors to a node id, never to a
          coordinate (leap, "Design contract"), so the rail carries the number
          a person reads on the thread and selecting one takes them to the node
          itself — which the frame already outlines. A pin whose node this
          revision no longer has is kept, counted and labelled. */}
      {pins && pins.length > 0 ? (
        <ul role="list" aria-label={`Comments on ${screen.name}`} data-slot="screen-pins" className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
          {pins.map((pin) => (
            <li key={pin.commentId}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-slot="screen-pin"
                    data-orphaned={pin.orphaned ? "true" : undefined}
                    aria-label={`Comment ${String(pin.number)}${pin.orphaned ? ", anchor gone" : ""}`}
                    onClick={() => onSelectPin?.(pin)}
                    className={cn(
                      "flex h-5 items-center gap-1 rounded-full border px-1.5 text-xs leading-none outline-none transition-colors duration-(--motion-instant) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                      pin.orphaned
                        ? "border-attention text-attention"
                        : pin.blocking
                          ? "border-danger text-danger"
                          : pin.resolved
                            ? "border-line text-ink-3"
                            : "border-live text-live",
                    )}
                  >
                    {pin.orphaned ? <Link2Off aria-hidden="true" className="size-3" /> : <MessageSquare aria-hidden="true" className="size-3" />}
                    {pin.number}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {pin.orphaned ? "The node this was pinned to is not in this revision. The comment is kept as it was written. " : ""}
                  {pin.text.slice(0, 200)}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="min-h-0 overflow-hidden rounded-b-lg border-t border-line">
        {sketch ? (
          <SketchFrame sketch={sketch} document={sketchBytes?.document} loading={sketchBytes?.loading ?? false} error={sketchBytes?.error} />
        ) : (
          <TreeFrame context={context} tokenProperties={tokenProperties} width={size.width} height={size.height} theme={theme} label={`${screen.name}, drawn from this project's design system`} />
        )}
      </div>
    </div>
  );
}
