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
import { middleTruncate } from "@/fleet/truncate.js";

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

export type ScopeBarStatus = "idle" | "loading" | "ready" | "error";

/** First row of the panel: what every figure covers, unless a figure says otherwise. */
export function scopeBarText(history: TelemetryHistory | undefined, status: ScopeBarStatus = "ready"): string {
  if (status === "error") return "Could not read this session's totals.";
  if (status === "idle" || status === "loading") return "Reading session…";
  if (!history) return "Session totals unavailable";
  return `Whole session · ${plural(history.records, "record", "records")} · ${plural(history.compactions, "compaction", "compactions")}`;
}

export function contextHeader(context: TelemetryContext | undefined): string {
  if (!context) return "Live only";
  if (context.percent === null) return "—";
  return percent(context.percent);
}

/**
 * Auto-compact, and the threshold it fires at. A threshold the engine did not
 * report is **not** zero: printing `0` there claimed the session compacts
 * immediately. An unknown figure says so on itself (redesign P3).
 */
export function autoCompactText(auto: TelemetryContext["autoCompact"] | undefined): string {
  if (!auto || !auto.enabled || auto.state === "off") return "Auto-compact off";
  if (auto.state === "compacting") return "Compacting";
  if (auto.thresholdTokens !== undefined && auto.thresholdTokens > 0) {
    return `Auto-compact on · ${tokens(auto.thresholdTokens)}`;
  }
  return `Auto-compact on · ${THRESHOLD_UNKNOWN}`;
}

/** The voice the composition already uses for a figure the snapshot lacks. */
const THRESHOLD_UNKNOWN = "threshold not reported";

export function autoCompactThresholdUnknownText(): string {
  return THRESHOLD_UNKNOWN;
}

export function hasPartialSpend(spend: TelemetrySpend | undefined): boolean {
  return (spend?.coverage?.unavailableChildren ?? 0) > 0;
}

/** Spend header while collapsed: exact totals stay compact; subtotals say partial. */
export function spendHeader(spend: TelemetrySpend | undefined): string {
  const partial = hasPartialSpend(spend);
  if (hasApiCost(spend)) return `${money(spend.api.totals.cost)}${partial ? " · partial" : ""}`;
  if (spend?.billing === "account" || spend?.billing === "mixed") return partial ? "Account · partial" : "Account";
  if (partial) return "Partial";
  return "None";
}

/**
 * True only when there is an API cost to show. A settled `$0` is no API cost:
 * drawing it spends four lines saying zero four times, and the spec asks for
 * one (leap §4.2, redesign P2).
 */
export function hasApiCost(
  spend: TelemetrySpend | undefined,
): spend is TelemetrySpend & { api: NonNullable<TelemetrySpend["api"]> } {
  return spend?.api !== undefined && spend.api.totals.cost > 0;
}

function unavailableChildrenText(spend: TelemetrySpend): string {
  const count = spend.coverage?.unavailableChildren ?? 0;
  return `${count} child ${count === 1 ? "session" : "sessions"} unavailable`;
}

/** Expanded qualification for a nonzero known subtotal. */
export function partialApiSubtotalText(spend: TelemetrySpend | undefined): string | undefined {
  if (!spend || !hasPartialSpend(spend)) return undefined;
  return `Partial · Known API subtotal · ${unavailableChildrenText(spend)}.`;
}

/** The one line a session with no known API cost gets. */
export function noApiCostText(spend: TelemetrySpend | undefined): string {
  if (spend && hasPartialSpend(spend)) {
    return `Partial · API cost is incomplete · ${unavailableChildrenText(spend)}.`;
  }
  if (spend?.billing === "account" || spend?.billing === "mixed") return "No API cost — account billed";
  return "No API cost";
}

export function workHeader(work: TelemetryWork | undefined): string {
  if (!work) return "—";
  return plural(work.turns, "turn", "turns");
}

export function workDurationText(work: TelemetryWork | undefined): string {
  if (!work) return "—";
  if (work.durationMs <= 0) return "No timestamps";
  return formatElapsed(work.durationMs);
}

export type FilesStatus = "idle" | "loading" | "ready" | "error";

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

export function filesHeader(totals: FileTotals, status: FilesStatus = "ready"): string {
  if (status === "idle" || status === "loading") return "—";
  if (status === "error") return "Failed";
  if (totals.files === 0) return "0";
  return `+${count(totals.added)} −${count(totals.removed)}`;
}

/** Last two path segments so two repos that share a basename stay distinct. */
export function repoLabel(repo: string): string {
  const parts = repo.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || repo;
  return parts.slice(-2).join("/");
}

export function filesErrorText(): string {
  return "Could not read the changes. Try again.";
}

export function filesIdleText(): string {
  return "No working directory to read yet.";
}

/**
 * History header. When this client holds fewer **records** than the session,
 * the qualification lives on this figure (`N of M`), never as a blanket line.
 * `held` is `entries.length` (records this client has), not the navigable
 * `historyRows` count. `navigable` is the figure shown while qualifying.
 */
export function historyHeader(history: TelemetryHistory | undefined, held: number, navigable = held): string {
  if (!history) return navigable > 0 ? `${count(navigable)} loaded` : "—";
  if (held < history.records) return `${count(navigable)} of ${count(history.records)}`;
  return count(history.records);
}

/**
 * A file path that keeps its **name**. The name is the identity of the row;
 * the directory is context, so the middle of the path is what gives way
 * (redesign P: Files). The full path stays in the tooltip and the accessible
 * name.
 */
export function pathDisplay(path: string, max = 30): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = cut >= 0 ? path.slice(cut + 1) : path;
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  if (!dir) return { dir: "", name: middleTruncate(name, max) };
  const room = max - name.length;
  if (room < 4) return { dir: "…/", name: middleTruncate(name, Math.max(8, max - 2)) };
  return { dir: middleTruncate(dir, room), name };
}

export function compositionMissingText(): string {
  return "Tools / chat / thinking / system not in this snapshot";
}

export function contextLiveOnlyText(): string {
  return "Live window only — this snapshot has no context";
}
