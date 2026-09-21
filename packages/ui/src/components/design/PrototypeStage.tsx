"use client";
/**
 * Prototype mode: one screen at a time, the flows played (M21-T11, D-354).
 *
 * The stage shows the current screen at the size it was designed for, scaled
 * down only when the window is smaller than the frame — a design is never
 * scaled *up*, because that would show a fidelity it does not have. An
 * overlay screen sits on top with a scrim; `close` and Back take it away.
 * Every transition is announced in a live region, so what happened is said
 * in words and not only shown.
 */
import { ArrowLeft, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { DesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CANVAS_VIEWPORTS, frameSize } from "@/design/canvas";
import { prototypeBack, reachableScreens, type PrototypeState } from "@/design/prototype";
import { screenOf, sketchOfScreen } from "@/design/tree-model";

import { ScreenFrame, type SketchBytes } from "./ScreenFrame.js";
import type { KitRenderContext } from "./kit/KitNode.js";

export function PrototypeStage({
  body,
  state,
  onState,
  tokenProperties,
  contextFor,
  sketchBytes,
  onExit,
  className,
}: {
  body: DesignBody;
  state: PrototypeState;
  onState: (state: PrototypeState) => void;
  tokenProperties: Readonly<Record<string, string>>;
  contextFor: (screenId: string) => KitRenderContext;
  sketchBytes?: Readonly<Record<string, SketchBytes>> | undefined;
  onExit: () => void;
  className?: string;
}) {
  const screen = screenOf(body, state.screenId);
  const overlay = state.overlayScreenId ? screenOf(body, state.overlayScreenId) : undefined;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const viewport = state.viewport ?? screen?.viewport;
  const size = frameSize(viewport);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      setScale(Math.min(1, rect.width / (size.width + 32), rect.height / (size.height + 32)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [size.width, size.height]);

  const canGoBack = state.history.length > 0 || state.overlayScreenId !== undefined;
  const reachable = screen ? reachableScreens(body, screen.id) : [];

  return (
    <div data-slot="design-prototype" className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <Button size="xs" variant="ghost" disabled={!canGoBack} onClick={() => onState(prototypeBack(state))}>
          <ArrowLeft className="rtl:-scale-x-100" />
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium text-ink">{screen?.name ?? "No screen"}</span>
        {state.theme ? <Badge variant="outline">{state.theme}</Badge> : null}
        {viewport ? <Badge variant="mono">{CANVAS_VIEWPORTS[viewport]?.label ?? viewport}</Badge> : null}
        <Button size="xs" variant="outline" onClick={onExit}>
          <X />
          Exit prototype
        </Button>
      </div>

      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
        {screen ? (
          <div style={{ transform: `scale(${String(scale)})`, transformOrigin: "top center", width: `${String(size.width)}px` }} className="relative">
            <ScreenFrame
              body={body}
              screen={screen}
              context={contextFor(screen.id)}
              tokenProperties={tokenProperties}
              sketchBytes={sketchBytes?.[screen.id]}
              selected={false}
              theme={state.theme}
            />
            {overlay ? (
              <div
                data-slot="design-prototype-overlay"
                className="absolute inset-0 flex items-start justify-center bg-[color-mix(in_oklab,var(--ink)_40%,transparent)] p-6"
                onClick={() => onState(prototypeBack(state))}
              >
                <div onClick={(event) => event.stopPropagation()} className="max-w-full">
                  <ScreenFrame
                    body={body}
                    screen={overlay}
                    context={contextFor(overlay.id)}
                    tokenProperties={tokenProperties}
                    sketchBytes={sketchBytes?.[overlay.id]}
                    selected={false}
                    theme={state.theme}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm leading-5 text-ink-2">This design has no screen to play.</p>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-2 border-t border-line bg-surface px-2 py-1 text-xs leading-xs text-ink-3">
        <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate">
          {state.last?.said ??
            (reachable.length === 0 && !sketchOfScreen(body, screen)
              ? "Nothing on this screen leads anywhere yet. Flows are added by composing, or in the chat."
              : "Press anything that is wired to a flow.")}
        </span>
        <span className="typed tnum">{Math.round(scale * 100)}%</span>
      </div>
    </div>
  );
}
