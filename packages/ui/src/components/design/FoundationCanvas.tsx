"use client";
/**
 * The foundation on the canvas (M21-T14).
 *
 * A foundation is a set of decisions; this is what those decisions look like.
 * The T11 primitive kit is rendered inside a Shadow DOM frame skinned by the
 * *proposal's own* tokens — type scale and palette, the core components in
 * their variants, and one ordinary screen built out of them — so a person
 * approves something they have seen rather than a list of hex values.
 *
 * It renders exactly what the foundation holds: a proposal with no tokens yet
 * draws in this app's tokens and says so, and a step that has not been
 * proposed simply has nothing in the sample. Nothing here is Native and
 * nothing pretends to be: every frame is `Proposed` until Build implements
 * the foundation.
 */
import { useMemo, useState } from "react";
import type { DesignFoundation } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { frameSize } from "@/design/canvas";
import { foundationSampleBody } from "@/design/foundation";
import { frameTokens } from "@/design/tokens";

import { TreeFrame } from "./TreeFrame.js";
import type { KitRenderContext } from "./kit/KitNode.js";

export interface FoundationCanvasProps {
  foundation: DesignFoundation;
  /** The modes to offer. Defaults to the foundation's own. */
  className?: string | undefined;
}

/** How wide a sample frame is drawn, against the frame's own design width. */
const SAMPLE_SCALE = 0.42;

export function FoundationCanvas({ foundation, className }: FoundationCanvasProps) {
  const modes = ["base", ...(foundation.modes ?? []).map((mode) => mode.name)];
  const [mode, setMode] = useState<string>(modes.includes("light") ? "light" : "base");
  const body = useMemo(() => foundationSampleBody(foundation, "Foundation samples"), [foundation]);

  // A mode is the base document with that mode's tokens over it: the same
  // rule the built product will follow, so what is drawn here is what a
  // person will get rather than a second interpretation of it.
  const tokens = useMemo(() => {
    const overlay = (foundation.modes ?? []).find((candidate) => candidate.name === mode);
    const base = frameTokens(foundation.tokens);
    if (!overlay) return base;
    const over = frameTokens(overlay.tokens);
    return {
      properties: { ...base.properties, ...over.properties },
      tokens: [...base.tokens, ...over.tokens],
      skipped: [...base.skipped, ...over.skipped],
    };
  }, [foundation.modes, foundation.tokens, mode]);

  return (
    <div data-slot="foundation-canvas" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="live">Proposed</Badge>
        <span className="text-xs leading-xs text-ink-3">
          {tokens.tokens.length > 0
            ? `${String(tokens.tokens.length)} tokens, drawn by this app's primitive kit.`
            : "No tokens yet: these samples are drawn in this app's own tokens."}
        </span>
        {modes.length > 1 ? (
          <span role="group" aria-label="Mode" className="ms-auto flex flex-wrap items-center gap-1">
            {modes.map((name) => (
              <Button key={name} size="xs" variant={name === mode ? "default" : "ghost"} aria-pressed={name === mode} onClick={() => setMode(name)}>
                {name === "base" ? "Base" : name}
              </Button>
            ))}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-start gap-4 overflow-hidden">
        {body.screens.map((screen) => {
          const size = frameSize(screen.viewport);
          const context: KitRenderContext = {
            body,
            screen,
            mode: "read",
            nodeStates: {},
            nodeVariants: {},
          };
          return (
            <figure key={screen.id} data-slot="foundation-sample" className="flex min-w-0 flex-col gap-1">
              <div
                className="overflow-hidden rounded-lg border border-line bg-surface"
                style={{ width: `${String(Math.round(size.width * SAMPLE_SCALE))}px`, height: `${String(Math.round(size.height * SAMPLE_SCALE))}px` }}
              >
                <div style={{ transform: `scale(${String(SAMPLE_SCALE)})`, transformOrigin: "top left" }}>
                  <TreeFrame context={context} tokenProperties={tokens.properties} width={size.width} height={size.height} theme={mode} label={`${screen.name}, ${mode}`} />
                </div>
              </div>
              <figcaption className="text-xs leading-xs text-ink-2">{screen.name}</figcaption>
            </figure>
          );
        })}
      </div>

      {tokens.skipped.length > 0 ? (
        <p role="status" className="text-xs leading-xs text-ink-3">
          {tokens.skipped.length} token{tokens.skipped.length === 1 ? " was" : "s were"} not applied: {tokens.skipped[0]?.path} {tokens.skipped[0]?.reason}.
        </p>
      ) : null}
    </div>
  );
}
