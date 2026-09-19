import { ChevronRight, CircleDollarSign, Landmark } from "lucide-react";
import type { TelemetrySpend } from "@lasercode/protocol";

import { CostMeter } from "@/components/assistant-ui/elements/cost-meter";
import { Button } from "@/components/ui/button";
import { AccountUsage } from "@/components/shell/AccountUsage.js";

import { hasApiCost, noApiCostText, spendHeader } from "./format.js";
import { FigureNote, TelemetrySection } from "./section.js";

/**
 * Spend. A session with no API cost is **one** line (leap §4.2): the meter,
 * the per-model rollup and the per-turn figure are all the same zero, and
 * four of them said nothing four times (redesign P2).
 */
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
      {api ? (
        <CostMeter
          sessionCostUsd={spend.api.totals.cost}
          runCostUsd={lastTurnCost(spend.api.series)}
          turns={spend.api.totals.turns}
          lines={spend.api.byModel.map((line) => ({
            model: line.model,
            inputTokens: line.input,
            outputTokens: line.output,
            costUsd: line.cost,
          }))}
        />
      ) : (
        <FigureNote slot="telemetry-no-api-cost">{noApiCostText(spend)}</FigureNote>
      )}
      {account ? (
        <div className={api ? "mt-4" : "mt-3"}>
          <AccountUsage state={spend?.account} compact />
          <Button variant="link" size="sm" className="justify-start px-0 text-xs" onClick={onOpenUsage}>
            All usage details <ChevronRight className="rtl:-scale-x-100 size-3" />
          </Button>
        </div>
      ) : null}
    </TelemetrySection>
  );
}

/** What the last API-billed turn added, from the cumulative series. */
function lastTurnCost(series: readonly number[]): number | undefined {
  if (series.length === 0) return undefined;
  if (series.length === 1) return series[0];
  return series[series.length - 1]! - series[series.length - 2]!;
}
