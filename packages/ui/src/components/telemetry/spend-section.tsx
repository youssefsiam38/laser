import { ChevronRight, CircleDollarSign, Landmark } from "lucide-react";
import type { TelemetrySpend } from "@lasercode/protocol";

import { CostMeter } from "@/components/assistant-ui/elements/cost-meter";
import { Button } from "@/components/ui/button";
import { AccountUsage } from "@/components/shell/AccountUsage.js";

import { hasApiCost, spendHeader } from "./format.js";
import { InstrumentCard, TelemetrySection } from "./section.js";

export function SpendSection({
  spend,
  open,
  onOpenChange,
  onOpenUsage,
}: {
  spend: TelemetrySpend | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenUsage: () => void;
}) {
  const api = hasApiCost(spend);
  const account = spend?.billing === "account" || spend?.billing === "mixed";
  const icon = account && !api ? Landmark : CircleDollarSign;
  return (
    <TelemetrySection id="spend" title="Spend" icon={icon} number={spendHeader(spend)} open={open} onOpenChange={onOpenChange}>
      {!api ? (
        <p data-slot="telemetry-no-api-cost" className="text-xs leading-4 text-ink-2">
          No API cost
        </p>
      ) : (
        <ApiSpend spend={spend!} />
      )}
      {account ? (
        <div className={api ? "mt-4" : "mt-3"}>
          <AccountUsage state={spend?.account} compact />
          <Button variant="link" size="sm" className="justify-start text-xs" onClick={onOpenUsage}>
            All usage details <ChevronRight className="rtl:-scale-x-100 size-3" />
          </Button>
        </div>
      ) : null}
    </TelemetrySection>
  );
}

function ApiSpend({ spend }: { spend: TelemetrySpend }) {
  const usage = spend.api!.totals;
  const lines = spend.api!.byModel;
  const series = spend.api!.series;
  const lastTurn = series.length > 1 ? series[series.length - 1]! - series[series.length - 2]! : series[0];
  return (
    <InstrumentCard>
      <CostMeter
        sessionCostUsd={usage.cost}
        runCostUsd={lastTurn}
        turns={usage.turns}
        lines={lines.map((line) => ({
          model: line.model,
          inputTokens: line.input,
          outputTokens: line.output,
          costUsd: line.cost,
        }))}
      />
    </InstrumentCard>
  );
}
