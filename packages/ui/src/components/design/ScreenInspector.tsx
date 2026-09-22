"use client";
/**
 * The inspector when a screen, not a node, is selected (M21-T11).
 *
 * A tree screen shows its states — which are included and why one was skipped
 * — its viewport and theme. A sketch screen shows the sketch's facts and the
 * two things a person can do with one: **Ground it**, and understand why it
 * cannot be approved (`SKETCH_GATE_REFUSAL`, D-354). The gate rule itself is
 * M21-T8's; this surface only refuses to pretend a sketch could pass one.
 */
import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { DesignBody, DesignScreen } from "@lasercode/protocol";
import { screenFidelity } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dateTime } from "@/format";
import { CANVAS_VIEWPORTS } from "@/design/canvas";
import { SKETCH_GATE_REFUSAL } from "@/design/sketch";
import { sketchOfScreen, treeOf, unreviewedNodes } from "@/design/tree-model";

import { FIDELITY_LABEL, FIDELITY_TONE } from "./ScreenFrame.js";

export type GroundSketch = (sketchId: string) => Promise<{ ok: true; screenId?: string } | { ok: false; message: string }>;

/** What the detail says when grounding is not wired to this window yet. */
export const GROUND_PENDING_SENTENCE =
  "Grounding a sketch is the model's work, from a session: it rebuilds the sketch from this project's design index, records what did not map as Proposed and lists the logic that became states. Ask for it in the chat with this design open — the sketch stays on the revision as provenance.";

export function ScreenInspector({
  body,
  screen,
  groundSketch,
  onGrounded,
}: {
  body: DesignBody;
  screen: DesignScreen;
  groundSketch?: GroundSketch | undefined;
  onGrounded?: (() => void) | undefined;
}) {
  const sketch = sketchOfScreen(body, screen);
  const tree = treeOf(screen);
  const fidelity = screenFidelity(screen);
  const unreviewed = unreviewedNodes(screen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <div data-slot="design-screen-inspector" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{screen.name}</h3>
          <Badge variant={FIDELITY_TONE[fidelity]}>{FIDELITY_LABEL[fidelity]}</Badge>
          {screen.viewport ? <Badge variant="mono">{CANVAS_VIEWPORTS[screen.viewport]?.label ?? screen.viewport}</Badge> : null}
          {screen.theme ? <Badge variant="outline">{screen.theme}</Badge> : null}
        </div>
        <span className="typed text-ink-3">{screen.id}</span>
      </header>

      {sketch ? (
        <section aria-label="Sketch" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs leading-xs">
            <dt className="text-ink-3">Written</dt>
            <dd className="text-ink-2">{dateTime(sketch.createdAt)}</dd>
            <dt className="text-ink-3">Size</dt>
            <dd className="typed tnum text-ink-2">
              {Math.round(sketch.bytes / 1024)} KB · {sketch.bounds.width}×{sketch.bounds.height}
            </dd>
            <dt className="text-ink-3">Grounded</dt>
            <dd className="text-ink-2">{sketch.groundedIntoScreenId ? `Yes, into ${body.screens.find((s) => s.id === sketch.groundedIntoScreenId)?.name ?? sketch.groundedIntoScreenId}` : "Not yet"}</dd>
          </dl>
          <p role="status" data-slot="sketch-gate-refusal" className="text-xs leading-xs text-ink-2">
            {SKETCH_GATE_REFUSAL}
          </p>
          {groundSketch ? (
            <div className="flex flex-col gap-1.5">
              <Button
                size="sm"
                className="self-start"
                disabled={busy || sketch.groundedIntoScreenId !== undefined}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  void groundSketch(sketch.id).then((outcome) => {
                    setBusy(false);
                    if (outcome.ok) onGrounded?.();
                    else setError(outcome.message);
                  });
                }}
              >
                <Sparkles />
                {sketch.groundedIntoScreenId ? "Grounded" : busy ? "Grounding…" : "Ground it"}
              </Button>
              {error ? (
                <p role="alert" className="text-xs leading-xs text-danger">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <p data-slot="ground-pending" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
              {GROUND_PENDING_SENTENCE}
            </p>
          )}
        </section>
      ) : null}

      {tree ? (
        <section aria-label="Tree" className="flex flex-col gap-1 text-xs leading-xs text-ink-2">
          <span>
            {tree.nodes.length} node{tree.nodes.length === 1 ? "" : "s"}
            {unreviewed.length > 0 ? ` · ${String(unreviewed.length)} on unreviewed entries` : ""}
          </span>
          <span className="text-ink-3">Select a node in the frame to inspect and edit it.</span>
        </section>
      ) : null}

      {screen.states.length > 0 ? (
        <section aria-label="States" className="flex flex-col gap-1.5">
          <h4 className="eyebrow">States</h4>
          <ul role="list" className="flex flex-col gap-1">
            {screen.states.map((state) => (
              <li key={state.name} className="flex min-w-0 items-start gap-2 text-xs leading-xs">
                <Badge variant={state.included ? "default" : "outline"}>{state.name}</Badge>
                <span className="min-w-0 text-ink-2">{state.included ? "included" : (state.skipReason ?? "skipped, no reason recorded")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
