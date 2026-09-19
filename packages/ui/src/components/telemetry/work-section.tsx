import { Wrench } from "lucide-react";
import type { TelemetryToolRank, TelemetryWork } from "@lasercode/protocol";

import { cn } from "@/lib/utils";

import { count, workDurationText, workHeader } from "./format.js";
import { InstrumentCard, TelemetrySection } from "./section.js";

export function WorkSection({
  work,
  open,
  onOpenChange,
}: {
  work: TelemetryWork | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ranked = work?.tools.ranked ?? [];
  const other = work?.tools.other ?? 0;
  const max = Math.max(ranked[0]?.count ?? 0, other);
  return (
    <TelemetrySection id="work" title="Work" icon={Wrench} number={workHeader(work)} open={open} onOpenChange={onOpenChange}>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Turns" value={work ? count(work.turns) : "—"} />
        <Stat label="Duration" value={workDurationText(work)} />
      </div>
      {work && (ranked.length > 0 || other > 0) ? (
        <InstrumentCard className="mt-3">
          <p className="text-xs leading-4 text-ink-3">Tool calls</p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-ink tnum">{count(work.tools.total)}</p>
          <ol className="mt-3 flex flex-col gap-1.5" data-slot="telemetry-tool-ranks">
            {ranked.map((row) => (
              <ToolRankRow key={row.name} row={row} max={max} />
            ))}
            {other > 0 ? <ToolRankRow key="__other__" row={{ name: "other", count: other }} max={max} /> : null}
          </ol>
        </InstrumentCard>
      ) : (
        <p className="mt-3 text-xs leading-4 text-ink-3">No tool calls</p>
      )}
      {work && work.tools.failed.length > 0 ? <FailedCalls failed={work.tools.failed} /> : null}
    </TelemetrySection>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <InstrumentCard>
      <p className="text-xs leading-4 text-ink-3">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm font-semibold text-ink tnum">{value}</p>
    </InstrumentCard>
  );
}

function ToolRankRow({ row, max }: { row: TelemetryToolRank; max: number }) {
  const width = max > 0 ? Math.min(100, (row.count / max) * 100) : 0;
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={row.name}>
        {row.name}
      </span>
      <span className="min-w-8 shrink-0 text-end font-mono text-xs text-ink-3 tnum">{count(row.count)}</span>
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface" aria-hidden="true">
        <span className={cn("block h-full rounded-full bg-live")} style={{ width: `${width}%` }} />
      </span>
    </li>
  );
}

function FailedCalls({ failed }: { failed: readonly TelemetryToolRank[] }) {
  return (
    <div className="mt-3" data-slot="telemetry-failed-tools">
      <p className="text-xs leading-4 text-ink-3">Failed</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {failed.map((row) => (
          <li key={row.name} className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-danger" title={row.name}>
              {row.name}
            </span>
            <span className="shrink-0 font-mono text-xs text-ink-3 tnum">{count(row.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
