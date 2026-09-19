import { Cpu } from "lucide-react";
import { TELEMETRY_SERIES_MAX, type TelemetryModel } from "@lasercode/protocol";

import { Chart } from "@/components/assistant-ui/elements/chart";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { tokens } from "@/format";
import { middleTruncate } from "@/fleet/truncate.js";

import { FigureNote, TelemetrySection } from "./section.js";

/** A model id at 12px mono beside its provider mark in a 288px column. */
const MODEL_BUDGET = 20;

export function ModelSection({
  model,
  open,
  onOpenChange,
}: {
  model: TelemetryModel | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = model?.id;
  const series = boundSeries(model?.tokenSeries ?? []);
  const windowed = (model?.tokenSeries.length ?? 0) > TELEMETRY_SERIES_MAX;
  return (
    <TelemetrySection
      id="model"
      title="Model"
      icon={Cpu}
      number={id ? middleTruncate(id, 18) : "—"}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-2">
        {id || model?.provider ? (
          <>
            <p className="flex min-w-0 items-center gap-1.5">
              <ProviderLogo provider={model?.provider ?? ""} className="size-3.5 shrink-0 text-ink-2" />
              <span className="shrink-0 typed text-ink" title={id ?? model?.provider}>
                {id ? middleTruncate(id, MODEL_BUDGET) : "—"}
              </span>
              <span className="ms-auto min-w-0 truncate text-xs leading-xs text-ink-3" title={model?.provider}>
                {model?.provider ?? "provider not reported"}
              </span>
            </p>
            <p className="flex min-w-0 items-baseline gap-2 text-xs leading-xs text-ink-2">
              <span>
                Thinking <span className="typed text-ink">{model?.thinkingLevel ?? "—"}</span>
              </span>
              <span className="ms-auto shrink-0">
                {model?.contextWindow !== undefined ? (
                  <>
                    <span className="typed text-ink">{tokens(model.contextWindow)}</span> window
                  </>
                ) : (
                  "window not reported"
                )}
              </span>
            </p>
          </>
        ) : (
          <FigureNote slot="telemetry-model-none">No model selected</FigureNote>
        )}
        {series.length > 0 ? (
          <Chart
            className="mt-1"
            density="sparkline"
            label={windowed ? `Tokens per turn · last ${TELEMETRY_SERIES_MAX} turns` : `Tokens per turn · ${series.length} turns`}
            value={tokens(series[series.length - 1] ?? 0)}
            points={series}
            pointLabel={(value, index) => `turn ${index + 1}: ${tokens(value)}`}
            variant="bars"
          />
        ) : null}
      </div>
    </TelemetrySection>
  );
}

function boundSeries(points: readonly number[]): number[] {
  if (points.length <= TELEMETRY_SERIES_MAX) return [...points];
  return points.slice(-TELEMETRY_SERIES_MAX);
}
