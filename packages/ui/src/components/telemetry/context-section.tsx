import { Gauge, Shrink } from "lucide-react";
import type { TelemetryContext } from "@lasercode/protocol";

import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { Button } from "@/components/ui/button";
import { tokens } from "@/format";
import { cn } from "@/lib/utils";
import { useSessionMeta } from "@/runtime";

import { autoCompactText, compositionMissingText, contextHeader, contextLiveOnlyText } from "./format.js";
import { FigureNote, TelemetrySection } from "./section.js";

/** Category fills — live and ink only. Status tones are not categories (DESIGN.md). */
const COMPOSITION = [
  { key: "tools" as const, label: "Tools", tone: "bg-live" },
  { key: "chat" as const, label: "Chat", tone: "bg-[color-mix(in_oklab,var(--live)_55%,transparent)]" },
  { key: "thinking" as const, label: "Thinking", tone: "bg-ink-2" },
  { key: "system" as const, label: "System", tone: "bg-ink-3" },
];

export function ContextSection({
  context,
  busy,
  compacting,
  open,
  onOpenChange,
  onCompact,
}: {
  context: TelemetryContext | undefined;
  busy: boolean;
  compacting: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompact: () => void;
}) {
  const { contextUsage } = useSessionMeta();
  return (
    <TelemetrySection
      id="context"
      title="Context"
      icon={Gauge}
      number={contextHeader(context)}
      open={open}
      onOpenChange={onOpenChange}
      action={
        <Button size="xs" variant="ghost" className="text-ink-2" disabled={busy || !context} onClick={() => onCompact()}>
          <Shrink />
          {compacting ? "Compacting…" : "Compact"}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {contextUsage ? (
          <ContextRingButton variant="meter" side="left" label="Window" />
        ) : context ? (
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="text-xs leading-xs text-ink-2">Window</span>
            <span className="ms-auto min-w-0 truncate typed text-ink">
              {context.tokens === null ? "—" : tokens(context.tokens)}
              <span className="text-ink-3"> / {tokens(context.contextWindow)}</span>
            </span>
          </p>
        ) : null}
        {context ? (
          <p data-slot="telemetry-auto-compact" className="text-xs leading-xs text-ink-2">
            {autoCompactText(context.autoCompact)}
          </p>
        ) : (
          <FigureNote slot="telemetry-context-live-only">{contextLiveOnlyText()}</FigureNote>
        )}
        <Composition context={context} />
      </div>
    </TelemetrySection>
  );
}

/**
 * The split, once: one bar, one legend. A category at zero is named in the
 * legend — it does not get a tile of its own (redesign P4).
 */
function Composition({ context }: { context: TelemetryContext | undefined }) {
  const parts = context?.composition;
  if (!parts) {
    return <FigureNote slot="telemetry-composition-missing">{compositionMissingText()}</FigureNote>;
  }
  const measured = COMPOSITION.reduce((sum, part) => sum + parts[part.key], 0);
  return (
    <div data-slot="telemetry-composition" className="mt-0.5 flex flex-col gap-1.5">
      <div
        data-slot="telemetry-composition-bar"
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-2"
        aria-hidden="true"
      >
        {COMPOSITION.map((part) => {
          const value = parts[part.key];
          const share = measured > 0 ? (value / measured) * 100 : 0;
          if (share === 0) return null;
          return <span key={part.key} data-part={part.key} className={cn("h-full", part.tone)} style={{ width: `${share}%` }} />;
        })}
      </div>
      <ul data-slot="telemetry-composition-legend" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {COMPOSITION.map((part) => (
          <li key={part.key} data-part={part.key} className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("size-1.5 shrink-0 self-center rounded-full", part.tone)} aria-hidden="true" />
            <span className="text-xs leading-xs text-ink-2">{part.label}</span>
            <span className="typed text-ink">{tokens(parts[part.key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
