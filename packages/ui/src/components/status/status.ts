import type { SessionAttention } from "@lasercode/protocol";

/** The one status vocabulary (DESIGN.md "Status language"). */
export type Status = SessionAttention;

export const STATUS_ORDER: readonly Status[] = [
  "waiting_for_input",
  "error",
  "finished_unread",
  "working",
  "idle",
];

/** Attention priority: lower sorts first (waiting > error > finished-unread > working > idle). */
export function statusRank(status: Status): number {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}

export const STATUS_LABEL: Record<Status, string> = {
  working: "Working",
  waiting_for_input: "Waiting for you",
  error: "Error",
  finished_unread: "Finished, unread",
  idle: "Idle",
};

/** Aggregate of many sessions: the most attention-worthy one wins. */
export function aggregateStatus(statuses: Iterable<Status>): Status {
  let best: Status = "idle";
  for (const s of statuses) if (statusRank(s) < statusRank(best)) best = s;
  return best;
}

/** CSS color for a status; `finished_unread` and `idle` are drawn as outline / tertiary. */
export function statusColor(status: Status): string {
  switch (status) {
    case "working":
    case "finished_unread":
      return "var(--live)";
    case "waiting_for_input":
      return "var(--attention)";
    case "error":
      return "var(--danger)";
    case "idle":
      return "var(--ink-3)";
  }
}

export type RingTone = "live" | "attention" | "danger" | "ok" | "neutral";

export const TONE_COLOR: Record<RingTone, string> = {
  live: "var(--live)",
  attention: "var(--attention)",
  danger: "var(--danger)",
  ok: "var(--ok)",
  neutral: "var(--ink-3)",
};

/** Default tone for a usage percentage: calm until 70, warm until 90, then danger. */
export function toneForPercent(percent: number): RingTone {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "attention";
  return "live";
}
