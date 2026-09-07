import { RefreshCw, Landmark, CircleDollarSign } from "lucide-react";
import type { ReactNode } from "react";
import type { AccountCredits, AccountUsageState } from "@lasercode/protocol";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useLaserStable } from "@/runtime";
import { cn } from "@/lib/utils";
import { AccountAllowances, AllowanceHelp } from "./AccountAllowances.js";
import { creditsExplanation } from "./account-allowance.js";
import { useResetDisplay } from "./use-reset-display.js";

function InstrumentCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-line bg-surface-2/70 p-3", className)}>{children}</div>;
}

export function AccountUsage({ state, compact = false, canRefresh = true }: { state: AccountUsageState | undefined; compact?: boolean; canRefresh?: boolean }) {
  const { actions, client } = useLaserStable();
  const { display, choose, saveError } = useResetDisplay(client);
  const snapshot = state?.snapshot;
  const loading = state?.status === "loading";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink">Subscription allowance</p>
          <p className="truncate text-xs leading-4 text-ink-3">
            {snapshot ? `Updated ${relativeTime(snapshot.fetchedAt)}` : "Current across every app using this account"}
          </p>
        </div>
        <TooltipIconButton
          tooltip="Refresh account allowance"
          size="icon-sm"
          variant="outline"
          disabled={loading || !canRefresh}
          onClick={() => void actions.refreshAccountUsage()}
        >
          <RefreshCw className={cn(loading && "motion-safe:animate-sweep")} />
        </TooltipIconButton>
      </div>

      {snapshot ? (
        <>
          {snapshot.windows.length > 0 ? <AccountAllowances compact={compact} windows={snapshot.windows} display={display} onDisplayChange={choose} /> : null}
          {saveError ? <p role="status" className="text-xs text-attention">Reset display changed here, but could not be saved. Choose it again to retry.</p> : null}
          {snapshot.credits && !compact ? <CreditsCard credits={snapshot.credits} /> : null}
          {state?.status === "unavailable" && state.message ? (
            <p role="status" className="text-xs leading-4 text-attention">{state.message} Showing the last update.</p>
          ) : null}
        </>
      ) : (
        <InstrumentCard className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-3">
            <Landmark className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{loading ? "Reading allowance…" : "Allowance unavailable"}</p>
            <p className="mt-0.5 text-xs leading-4 text-ink-3">
              {state?.message ?? "Refresh to read the latest limits from your connected account."}
            </p>
          </div>
        </InstrumentCard>
      )}
    </div>
  );
}

function CreditsCard({ credits }: { credits: AccountCredits }) {
  const value = credits.unlimited ? "Unlimited" : credits.balance ?? (credits.hasCredits ? "Available" : "None");
  return (
    <InstrumentCard className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-live">
        <CircleDollarSign className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-4 text-ink-3">Purchased credits</p>
        <p className="truncate font-mono text-sm font-semibold text-ink tnum">{value}</p>
      </div>
      <AllowanceHelp name="Purchased credits" explanation={creditsExplanation} />
    </InstrumentCard>
  );
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
