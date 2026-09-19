import { Wrench } from "lucide-react";
import type { TelemetryToolRank, TelemetryWork } from "@lasercode/protocol";

import { count, workDurationText, workHeader } from "./format.js";
import { Datum, FigureNote, TelemetrySection } from "./section.js";

/**
 * Work is five numbers, so it is a definition list — not three cards
 * (redesign P7). The tool ranks carry a quiet inline meter; failures are
 * named in `--danger`.
 */
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
  const hasTools = Boolean(work) && (ranked.length > 0 || other > 0);
  return (
    <TelemetrySection id="work" title="Work" icon={Wrench} number={workHeader(work)} open={open} onOpenChange={onOpenChange}>
      <dl className="flex flex-col gap-1">
        <Datum label="Turns" value={work ? count(work.turns) : "—"} />
        <Datum label="Wall clock" value={workDurationText(work)} />
        <Datum label="Tool calls" value={work ? count(work.tools.total) : "—"} />
      </dl>
      {hasTools ? (
        <dl className="mt-2 flex flex-col gap-1" data-slot="telemetry-tool-ranks">
          {ranked.map((row) => (
            <ToolRank key={row.name} row={row} max={max} />
          ))}
          {other > 0 ? <ToolRank key="__other__" row={{ name: "other", count: other }} max={max} /> : null}
        </dl>
      ) : (
        <FigureNote slot="telemetry-no-tool-calls">No tool calls</FigureNote>
      )}
      {work && work.tools.failed.length > 0 ? <FailedCalls failed={work.tools.failed} /> : null}
    </TelemetrySection>
  );
}

function ToolRank({ row, max }: { row: TelemetryToolRank; max: number }) {
  return (
    <Datum
      label={<span className="typed">{row.name}</span>}
      title={row.name}
      value={count(row.count)}
      meter={max > 0 ? row.count / max : 0}
    />
  );
}

function FailedCalls({ failed }: { failed: readonly TelemetryToolRank[] }) {
  return (
    <div className="mt-2" data-slot="telemetry-failed-tools">
      <p className="eyebrow">Failed</p>
      <dl className="mt-1 flex flex-col gap-1">
        {failed.map((row) => (
          <Datum key={row.name} label={row.name} title={row.name} value={count(row.count)} tone="danger" />
        ))}
      </dl>
    </div>
  );
}
