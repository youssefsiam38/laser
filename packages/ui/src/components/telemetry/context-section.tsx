import { Gauge, Shrink } from "lucide-react";
import type { TelemetryContext } from "@lasercode/protocol";

import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { StatusRing } from "@/components/status";
import { Button } from "@/components/ui/button";
import { tokens } from "@/format";
import { cn } from "@/lib/utils";
import { useSessionMeta } from "@/runtime";

import { autoCompactText, compositionMissingText, contextHeader, contextLiveOnlyText } from "./format.js";
import { InstrumentCard, TelemetrySection } from "./section.js";

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
        <Button size="xs" variant="outline" disabled={busy || !context} onClick={() => onCompact()}>
          <Shrink />
          {compacting ? "Compacting…" : "Compact"}
        </Button>
      }
    >
      <InstrumentCard className="flex items-center gap-4">
        {contextUsage ? (
          <ContextRingButton size={64} stroke={3} showLabel side="left" />
        ) : (
          <StatusRing status="idle" size={64} thickness={3} label="Context usage unknown" aria-hidden="true">
            <span className="text-sm text-ink-3">—</span>
          </StatusRing>
        )}
        <div className="min-w-0 flex-1">
          {context ? (
            <>
              <p className="text-xs leading-4 text-ink-3">Window</p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-ink tnum">
                {context.tokens === null ? "—" : tokens(context.tokens)}{" "}
                <span className="font-normal text-ink-3">/ {tokens(context.contextWindow)}</span>
              </p>
              <p className="mt-2 text-xs leading-4 text-ink-2">{autoCompactText(context.autoCompact)}</p>
            </>
          ) : (
            <p data-slot="telemetry-context-live-only" className="text-xs leading-4 text-ink-2">
              {contextLiveOnlyText()}
            </p>
          )}
        </div>
      </InstrumentCard>
      <Composition context={context} />
    </TelemetrySection>
  );
}

function Composition({ context }: { context: TelemetryContext | undefined }) {
  const parts = context?.composition;
  if (!parts) {
    return (
      <p data-slot="telemetry-composition-missing" className="mt-3 text-xs leading-4 text-ink-2">
        {compositionMissingText()}
      </p>
    );
  }
  const measured = COMPOSITION.reduce((sum, part) => sum + parts[part.key], 0);
  return (
    <InstrumentCard className="mt-3">
      <p className="text-xs leading-4 text-ink-3">Composition</p>
      <div className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface" aria-hidden="true">
        {COMPOSITION.map((part) => {
          const value = parts[part.key];
          const share = measured > 0 ? (value / measured) * 100 : 0;
          if (share === 0) return null;
          return <span key={part.key} className={cn("h-full", part.tone)} style={{ width: `${share}%` }} />;
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {COMPOSITION.map((part) => (
          <div key={part.key} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", part.tone)} aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-xs leading-4 text-ink-3">{part.label}</p>
              <p className="font-mono text-xs leading-4 text-ink tnum">{tokens(parts[part.key])}</p>
            </div>
          </div>
        ))}
      </div>
    </InstrumentCard>
  );
}
