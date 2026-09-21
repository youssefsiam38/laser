"use client";
/**
 * The flows, read as sentences: what starts them and what they do (M21-T13).
 *
 * A flow is declarative — the canvas draws it between frames and Prototype
 * mode plays it — so this panel only has to say it in words, and let a name
 * take the person to the screen it names.
 */
import type { DesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";

export interface FlowsPanelProps {
  body: DesignBody;
  onSelectScreen: (screenId: string) => void;
}

export function FlowsPanel({ body, onSelectScreen }: FlowsPanelProps) {
  const screenName = (screenId: string): string => body.screens.find((screen) => screen.id === screenId)?.name ?? screenId;
  if (body.flows.length === 0) {
    return (
      <div role="status" data-slot="design-flows" className="rounded-lg border border-dashed border-line p-3 text-xs leading-xs text-ink-2">
        This design has no flows yet. A flow is one declarative step — a click that opens a screen, a submit that shows the loading state, a tab that switches a variant. The canvas
        draws them between frames as soon as there are some.
      </div>
    );
  }
  return (
    <section data-slot="design-flows" aria-label="Flows" className="flex min-w-0 flex-col gap-1.5">
      <h3 className="eyebrow">Flows</h3>
      <ul role="list" className="flex flex-col gap-1">
        {body.flows.map((flow) => (
          <li key={flow.id} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs leading-xs text-ink-2">
            <Badge variant="mono">{flow.trigger}</Badge>
            <button
              type="button"
              className="rounded text-ink underline-offset-4 outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              onClick={() => onSelectScreen(flow.fromScreenId)}
            >
              {screenName(flow.fromScreenId)}
            </button>
            <span aria-hidden="true">→</span>
            <span>{flowActionLabel(flow.action, screenName)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function flowActionLabel(action: DesignBody["flows"][number]["action"], screenName: (screenId: string) => string): string {
  switch (action.type) {
    case "navigate":
      return `go to ${screenName(action.screenId)}${action.transition ? ` (${action.transition})` : ""}`;
    case "overlay":
      return `open ${screenName(action.screenId)} over it`;
    case "close":
      return "close the overlay";
    case "setState":
      return `put ${action.nodeId} into its ${action.state} state`;
    case "setVariant":
      return `switch ${action.nodeId} to ${action.variant}`;
    case "switchTheme":
      return `switch the theme to ${action.theme}`;
    case "switchViewport":
      return `switch the viewport to ${action.viewport}`;
  }
}
