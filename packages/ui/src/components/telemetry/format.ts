/**
 * Pure display helpers for the telemetry column. Numbers in, strings out —
 * nothing here walks loaded entries (leap §5 C.1).
 */
import type {
  ProjectChanges,
  TelemetryContext,
  TelemetryHistory,
  TelemetrySpend,
  TelemetryWork,
} from "@lasercode/protocol";
import { formatElapsed, money, percent, tokens } from "@/format";

/** Narrow no-break space so `2 795` does not wrap mid-number. */
const GROUP = "\u202f";

/** Grouped integer, matching the spec drawing (`2 795 records`). */
export function count(n: number): string {
  const rounded = Math.round(n);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  return rounded < 0 ? `−${grouped}` : grouped;
}

export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** First row of the panel: what every figure covers, unless a figure says otherwise. */
export function scopeBarText(history: TelemetryHistory | undefined): string {
  if (!history) return "Whole session";
  return `Whole session · ${plural(history.records, "record", "records")} · ${plural(history.compactions, "compaction", "compactions")}`;
}

export function contextHeader(context: TelemetryContext | undefined): string {
  if (!context) return "Live only";
  if (context.percent === null) return "—";
  return percent(context.percent);
}

export function autoCompactText(auto: TelemetryContext["autoCompact"] | undefined): string {
  if (!auto || !auto.enabled || auto.state === "off") return "Auto-compact off";
  if (auto.state === "compacting") return "Compacting";
  if (auto.thresholdTokens !== undefined) return `Auto-compact on · ${tokens(auto.thresholdTokens)}`;
  return "Auto-compact on";
}

/** Spend header while collapsed: the API total, or Account, or None. */
export function spendHeader(spend: TelemetrySpend | undefined): string {
  if (!spend || spend.billing === "none") return "None";
  if (spend.api) return money(spend.api.totals.cost);
  if (spend.billing === "account" || spend.billing === "mixed") return "Account";
  return "None";
}

export function hasApiCost(spend: TelemetrySpend | undefined): boolean {
  return Boolean(spend?.api);
}

export function workHeader(work: TelemetryWork | undefined): string {
  if (!work) return "—";
  return plural(work.turns, "turn", "turns");
}

export function workDurationText(work: TelemetryWork | undefined): string {
  if (!work) return "—";
  return formatElapsed(work.durationMs);
}

export type FileTotals = { files: number; added: number; removed: number };

export function fileTotals(changes: ProjectChanges | undefined): FileTotals {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const repo of changes?.repos ?? []) {
    for (const file of repo.files) {
      files += 1;
      added += file.added ?? 0;
      removed += file.removed ?? 0;
    }
  }
  return { files, added, removed };
}

export function filesHeader(totals: FileTotals): string {
  if (totals.files === 0) return "0";
  return `+${count(totals.added)} −${count(totals.removed)}`;
}

/**
 * History header. When this client holds fewer records than the session,
 * the qualification lives on this figure (`N of M`), never as a blanket line.
 */
export function historyHeader(history: TelemetryHistory | undefined, held: number): string {
  if (!history) return held > 0 ? `${count(held)} loaded` : "—";
  if (held < history.records) return `${count(held)} of ${count(history.records)}`;
  return count(history.records);
}

export function compositionMissingText(): string {
  return "Tools / chat / thinking / system not in this snapshot";
}

export function contextLiveOnlyText(): string {
  return "Live window only — this snapshot has no context";
}
