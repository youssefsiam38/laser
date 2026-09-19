import { Brain, Cpu } from "lucide-react";
import type { TelemetryModel } from "@lasercode/protocol";

import { Chart } from "@/components/assistant-ui/elements/chart";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { tokens } from "@/format";

import { InstrumentCard, TelemetrySection } from "./section.js";

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
  return (
    <TelemetrySection id="model" title="Model" icon={Cpu} number={id ?? "—"} open={open} onOpenChange={onOpenChange}>
      <InstrumentCard>
        {id || model?.provider ? (
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface text-live shadow-float-sm">
              <ProviderLogo provider={model?.provider ?? ""} className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs leading-4 text-ink-3">{model?.provider ?? "—"}</p>
              <p className="truncate font-mono text-sm font-medium text-ink" title={id}>
                {id ?? "—"}
              </p>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                <Brain className="size-3.5 text-ink-3" aria-hidden="true" />
                <span className="text-xs text-ink-2">Thinking</span>
                <Badge variant="mono">{model?.thinkingLevel ?? "—"}</Badge>
                {model?.contextWindow !== undefined ? (
                  <span className="ms-auto font-mono text-xs text-ink-3 tnum">{tokens(model.contextWindow)}</span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-ink-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-surface">
              <Cpu className="size-5" aria-hidden="true" />
            </span>
            No model selected
          </div>
        )}
      </InstrumentCard>
      {model && model.tokenSeries.length > 0 ? (
        <InstrumentCard className="mt-3">
          <Chart
            label="Tokens per turn"
            value={tokens(model.tokenSeries[model.tokenSeries.length - 1] ?? 0)}
            points={model.tokenSeries}
            pointLabel={(value, index) => `turn ${index + 1}: ${tokens(value)}`}
            variant="bars"
          />
        </InstrumentCard>
      ) : null}
    </TelemetrySection>
  );
}
