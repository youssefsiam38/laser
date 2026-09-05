/**
 * The live values an island shows, per kind and per size budget
 * (docs/ux-panels.md "The legibility floor"): minimal shows exactly one,
 * compact up to three. Pure; the caller passes `now` and re-renders on a tick.
 */
import type { Panel, PanelUsage } from "@piorbit/protocol";
import { duration, money, tokens } from "../format.js";
import { elapsedOf, velocityOf, type PanelEntry } from "./store.js";

export interface LiveValue {
  /** What the value is, for the tooltip and the accessible name. */
  label: string;
  /** Rendered in Martian Mono with tabular numerals. */
  text: string;
  /** Tick every second (elapsed) so the component knows to animate the number. */
  ticking?: boolean;
  tone?: "attention" | "danger" | "muted";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return "idle";
  return `+${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/** Elapsed in the coarse form islands use: 12s · 1m 05s · 1h 02m. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function totalTokens(usage: PanelUsage): number | undefined {
  const parts = [usage.input, usage.output].filter((n): n is number => typeof n === "number");
  return parts.length === 0 ? undefined : parts.reduce((a, b) => a + b, 0);
}

/** "3.2k tokens · $0.04", or "not measured", or undefined when nothing was declared. */
export function usageSummary(usage: PanelUsage | null | undefined): LiveValue | undefined {
  if (usage === undefined) return undefined;
  if (usage === null) return { label: "Usage", text: "not measured", tone: "muted" };
  const total = totalTokens(usage);
  const cost = typeof usage.costUsd === "number" ? money(usage.costUsd) : undefined;
  if (total === undefined && cost === undefined) {
    return usage.unavailableReason ? { label: "Usage", text: "not measured", tone: "muted" } : undefined;
  }
  return { label: "Tokens and cost", text: [total !== undefined ? tokens(total) : undefined, cost].filter(Boolean).join(" · ") };
}

/** Values in priority order; slice to the size budget. */
export function liveValues(entry: PanelEntry, now: number): LiveValue[] {
  const { panel } = entry;
  if (entry.closed) return [{ label: "Ended", text: `ended · ${entry.closed.reason}`, tone: "muted" }];
  switch (panel.kind) {
    case "run": {
      const out: LiveValue[] = [];
      const elapsed = elapsedOf(entry, now);
      if (elapsed !== undefined) {
        out.push({ label: "Elapsed", text: formatElapsed(elapsed), ticking: panel.lifecycle === "running" || panel.lifecycle === "queued" });
      }
      if (panel.progress && panel.progress !== "indeterminate") {
        out.push({ label: "Progress", text: `${panel.progress.done}/${panel.progress.total}` });
      } else if (panel.phase && panel.phase.index !== undefined && panel.phase.total !== undefined) {
        // `phase.index` is 1-based (docs/ux-panels.md); nothing adds to it.
        out.push({ label: "Phase", text: `${panel.phase.index}/${panel.phase.total}` });
      }
      const usage = usageSummary(panel.usage);
      if (usage) out.push(usage);
      if (panel.output?.bytes !== undefined) {
        const rate = velocityOf(entry.ring, now);
        out.push({ label: "Output", text: rate !== undefined && rate >= 1 ? formatRate(rate) : formatBytes(panel.output.bytes) });
      }
      if (panel.lifecycle === "failed") out.unshift({ label: "State", text: "failed", tone: "danger" });
      else if (panel.lifecycle === "cancelled") out.unshift({ label: "State", text: "cancelled", tone: "muted" });
      else if (panel.lifecycle === "paused") out.unshift({ label: "State", text: "paused", tone: "muted" });
      else if (panel.lifecycle === "queued") out.unshift({ label: "State", text: "queued", tone: "muted" });
      return out.length > 0 ? out : [{ label: "State", text: panel.lifecycle }];
    }
    case "plan": {
      const done = panel.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
      const running = panel.steps.filter((s) => s.state === "running").length;
      const failed = panel.steps.filter((s) => s.state === "failed").length;
      const out: LiveValue[] = [{ label: "Steps done", text: `${done}/${panel.steps.length}` }];
      if (failed > 0) out.push({ label: "Failed steps", text: `${failed} failed`, tone: "danger" });
      else if (running > 0) out.push({ label: "Running steps", text: `${running} running` });
      const usage = usageSummary(panel.usage);
      if (usage) out.push(usage);
      return out;
    }
    case "stream": {
      const out: LiveValue[] = [];
      const rate = velocityOf(entry.ring, now);
      if (panel.bytes !== undefined) out.push({ label: "Size", text: formatBytes(panel.bytes) });
      if (rate !== undefined && panel.follow) out.push({ label: "Throughput", text: formatRate(rate) });
      out.push({ label: "Encoding", text: panel.encoding, tone: "muted" });
      if (panel.truncated) out.push({ label: "Truncated", text: `${panel.truncated} truncated`, tone: "attention" });
      return out;
    }
    case "collection": {
      const n = panel.items.length;
      const total = panel.total ?? n;
      return [
        { label: "Items", text: total > n ? `${n} of ${total}` : `${n} ${n === 1 ? "item" : "items"}` },
        ...(panel.layout ? [{ label: "Layout", text: panel.layout, tone: "muted" as const }] : []),
      ];
    }
    case "document": {
      const out: LiveValue[] = [];
      if (panel.version) out.push({ label: "Version", text: panel.version.label });
      out.push({ label: "Type", text: shortMediaType(panel.mediaType), tone: "muted" });
      if (!panel.renderable) out.push({ label: "Viewer", text: "opens externally", tone: "muted" });
      return out;
    }
    case "decision": {
      const out: LiveValue[] = [{ label: "State", text: "needs you", tone: "attention" }];
      out.push({ label: "Blocks", text: blockingWords(panel.blocking), tone: "muted" });
      return out;
    }
  }
}

export function blockingWords(blocking: "tool" | "turn" | "session"): string {
  switch (blocking) {
    case "tool":
      return "blocks one tool";
    case "turn":
      return "blocks this turn";
    case "session":
      return "blocks everything";
  }
}

export function shortMediaType(mediaType: string): string {
  const [type, subtype] = mediaType.split("/");
  if (!subtype) return mediaType;
  if (subtype === "markdown") return "markdown";
  if (subtype === "x-diff" || subtype === "x-patch") return "diff";
  if (type === "image") return `${subtype} image`;
  if (subtype === "plain") return "text";
  return subtype.replace(/^x-/, "");
}

/** The description a screen reader gets for a minimal island: name and its one value. */
export function accessibleSummary(title: string, values: readonly LiveValue[]): string {
  const first = values[0];
  return first ? `${title}, ${first.label.toLowerCase()} ${first.text}` : title;
}

/** Re-exported so components need one import. */
export { duration };
