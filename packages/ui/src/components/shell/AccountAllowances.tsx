import { useEffect, useId, useState } from "react";
import type { AccountUsageWindow } from "@lasercode/protocol";
import { Info } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { QuotaBanner } from "@/components/assistant-ui/elements/quota-banner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { allowanceExplanation, allowanceWindowLabel, groupAllowances, resetLabel, type AllowanceExplanation, type ResetDisplay } from "./account-allowance.js";

export function AllowanceHelp({ name, explanation, periods }: { name: string; explanation: AllowanceExplanation; periods?: string[] }) {
  const id = useId();
  return <Popover>
    <PopoverTrigger asChild><TooltipIconButton tooltip={`About ${name}`} size="icon-xs" className="pointer-coarse:size-11"><Info /></TooltipIconButton></PopoverTrigger>
    <PopoverContent align="end" aria-labelledby={id} className="max-w-[calc(100vw-var(--space-unit)*8)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
      <h3 id={id} className="break-words text-sm font-semibold">{name}</h3>
      <p className="text-xs leading-5 text-ink-2">{explanation.text}</p>
      {periods?.length ? <div className="border-t border-line pt-2 text-xs leading-5 text-ink-2">
        {periods.map((period, index) => <p key={index}>{period}: usage measured over this window; its reset applies only to this window.</p>)}
        {periods.length > 1 ? <p className="mt-2">These limits belong to the same allowance. Each has its own cap and reset; their percentages are not added together.</p> : null}
      </div> : null}
      {explanation.source ? <a href={explanation.source} target="_blank" rel="noreferrer" className="text-xs text-live underline underline-offset-4">OpenAI documentation</a> : null}
    </PopoverContent>
  </Popover>;
}

export function AccountAllowances({ windows, display, onDisplayChange, compact = false }: { windows: readonly AccountUsageWindow[]; display: ResetDisplay; onDisplayChange: (value: ResetDisplay) => void; compact?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (display !== "remaining") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [display]);
  const id = useId();
  // Only understood allowances belong in the glanceable chat rail. Settings
  // retains the full dynamic list, including reserve and future provider names.
  const groups = groupAllowances(windows).filter(group => !compact || allowanceExplanation(group).source !== undefined);
  if (!groups.length) return <p className="text-xs text-ink-3">Allowance details are available in Settings → Usage.</p>;
  return <div className="grid gap-2">
    <RadioGroup.Root aria-label="Reset display" value={display} onValueChange={value => onDisplayChange(value as ResetDisplay)} className="grid grid-cols-2 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
      {([['remaining', 'Time left'], ['time', 'Reset time']] as const).map(([value, label]) => <RadioGroup.Item key={value} value={value} className="rounded-md px-2 py-1.5 text-xs text-ink-3 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-live data-[state=checked]:bg-surface data-[state=checked]:text-ink pointer-coarse:min-h-11">{label}</RadioGroup.Item>)}
    </RadioGroup.Root>
    {groups.map((group, index) => <section key={group.id} data-slot="allowance-group" aria-labelledby={`${id}-${index}`} className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface-2/70">
      <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h3 id={`${id}-${index}`} className="break-words text-xs font-semibold leading-5 text-ink">{group.name}</h3>
          {!compact && group.windows.length > 1 ? <p className="text-xs leading-4 text-ink-3">{group.windows.length} windows · one allowance</p> : null}
        </div>
        <AllowanceHelp name={group.name} explanation={allowanceExplanation(group)} periods={group.windows.map(window => allowanceWindowLabel(window.windowDurationMins, window.kind))} />
      </div>
      <div className="divide-y divide-line">
        {group.windows.map((window, i) => <QuotaBanner key={`${window.kind}:${i}`} compact={compact} bucketLabel={group.name} hideBucketLabel label={allowanceWindowLabel(window.windowDurationMins, window.kind)} usedPercent={window.usedPercent} resetsLabel={resetLabel(window.resetsAt, display, now)} className="rounded-none border-0 bg-transparent" />)}
      </div>
    </section>)}
  </div>;
}
