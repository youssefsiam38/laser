import type { PanelUsage, RunPanel } from "@piorbit/protocol";
import { Paperclip } from "lucide-react";

import { money, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { usePanelsState } from "../../PanelsProvider.js";
import { elapsedOf, panelKey, type PanelEntry } from "../../store.js";
import { formatElapsed, totalTokens } from "../../values.js";
import { ActionButtons } from "../ActionButtons.js";
import { StreamBody } from "./StreamBody.js";

export interface RunBodyProps {
  entry: PanelEntry;
  panel: RunPanel;
  now: number;
  onAct(actionId: string): Promise<unknown>;
  onOpenRef(ref: string, label: string): void;
}

const LIFECYCLE_WORDS: Record<RunPanel["lifecycle"], string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Agent work with a lifecycle: the activity line, a phase stepper (not a
 * bar), usage that knows "not measured" from zero (R8), the live output as
 * an embedded stream, artifacts, and exactly the actions the producer
 * declared (R2).
 */
export function RunBody({ entry, panel, now, onAct, onOpenRef }: RunBodyProps) {
  const elapsed = elapsedOf(entry, now);
  const terminal = panel.lifecycle === "done" || panel.lifecycle === "failed" || panel.lifecycle === "cancelled";
  // Running, saying something, and with no stream of its own to watch: every
  // word it has arrives whole, a message at a time (R4).
  const bursty = panel.lifecycle === "running" && panel.activity !== undefined && panel.output === undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* One line, truncated: in a narrow dock a wrapping state line used
              to run under the elapsed time and the two collided (R13). */}
          <p
            className="truncate text-sm text-ink-2"
            title={[LIFECYCLE_WORDS[panel.lifecycle], panel.terminalReason, panel.handle].filter(Boolean).join(" · ")}
          >
            <span className={cn("font-medium", panel.lifecycle === "failed" ? "text-danger" : "text-ink")}>{LIFECYCLE_WORDS[panel.lifecycle]}</span>
            {panel.terminalReason && <span className="text-ink-2"> · {panel.terminalReason}</span>}
            {panel.handle && <span className="ms-2 font-mono text-xs text-ink-3">{panel.handle}</span>}
          </p>
          {panel.activity ? (
            <>
              <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-ink" title={panel.activity}>
                {panel.activity}
              </p>
              {/* R4, fidelity honesty: a detached run emits no text deltas, so
                  what is above is a whole message that arrived at once. Saying
                  so is the alternative to faking a typewriter. */}
              {bursty && <p className="eyebrow mt-1">updates in bursts</p>}
            </>
          ) : (
            !terminal && <p className="mt-0.5 text-sm text-ink-3">No word from the agent yet.</p>
          )}
        </div>
        {elapsed !== undefined && (
          <span className="typed shrink-0 pt-0.5 text-ink-2" aria-label={`Elapsed ${formatElapsed(elapsed)}`}>
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>

      {panel.phase && <PhaseStepper phase={panel.phase} />}
      {panel.progress && <Progress progress={panel.progress} />}

      {panel.error && (
        <p className="border-s-2 border-danger ps-3 text-sm leading-5 wrap-break-word whitespace-pre-wrap text-ink" role="alert">
          {panel.error}
        </p>
      )}

      <Meta panel={panel} path={entry.path} />
      <UsageRow usage={panel.usage} />

      {panel.output && (
        <section aria-label="Output" className="flex min-h-0 flex-col gap-1.5">
          <h4 className="eyebrow">Output</h4>
          <StreamBody
            entry={entry}
            panel={{
              kind: "stream",
              id: `${panel.id}:output`,
              source: panel.source,
              title: `${panel.title} output`,
              intent: "follow",
              // A run's output has no declared framing; interpreting escapes is
              // harmless on plain text and right for a shell's.
              encoding: "ansi",
              ref: panel.output.ref,
              ...(panel.output.bytes !== undefined ? { bytes: panel.output.bytes } : {}),
              follow: !terminal,
            }}
            embedded
            onAct={onAct}
          />
        </section>
      )}

      {panel.artifacts && panel.artifacts.length > 0 && (
        <section aria-label="Artifacts" className="flex flex-col gap-1">
          <h4 className="eyebrow">Artifacts</h4>
          <ul role="list" className="flex flex-wrap gap-1.5">
            {panel.artifacts.map((artifact) => (
              <li key={artifact.ref}>
                <button
                  type="button"
                  onClick={() => onOpenRef(artifact.ref, artifact.label)}
                  className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-ink outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
                  title={artifact.ref}
                >
                  <Paperclip className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
                  <span className="truncate">{artifact.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ActionButtons actions={panel.actions} onAct={onAct} className="mt-auto" />
    </div>
  );
}

/**
 * `phase.index` is 1-based (docs/ux-panels.md), so `index/total` is printed as
 * it arrives and the dot loop compares against `index - 1`. Nothing here adds
 * one: the producer already did.
 */
function PhaseStepper({ phase }: { phase: NonNullable<RunPanel["phase"]> }) {
  const known = phase.index !== undefined && phase.total !== undefined && phase.total > 0;
  const current = (phase.index ?? 1) - 1;
  return (
    <div className="flex flex-col gap-1" aria-label={known ? `Phase ${phase.index} of ${phase.total}: ${phase.label}` : `Phase: ${phase.label}`}>
      <div className="flex items-baseline gap-2">
        <span className="eyebrow">Phase</span>
        {known && (
          <span className="typed text-ink-2">
            {phase.index}/{phase.total}
          </span>
        )}
        <span className="min-w-0 truncate text-sm text-ink">{phase.label}</span>
      </div>
      {known && (
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: Math.min(phase.total!, 24) }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full",
                i < current ? "bg-live" : i === current ? "bg-live/50 motion-safe:animate-attention" : "bg-line",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Progress({ progress }: { progress: NonNullable<RunPanel["progress"]> }) {
  if (progress === "indeterminate") {
    return (
      <div className="h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Working" aria-valuetext="in progress">
        <div className="h-full w-full rounded-full bg-live/60 motion-safe:animate-attention" />
      </div>
    );
  }
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <div className="h-full rounded-full bg-live transition-[width] duration-(--motion-slow) motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <span className="typed text-ink-2">
        {progress.done}/{progress.total}
      </span>
    </div>
  );
}

function Meta({ panel, path }: { panel: RunPanel; path: string }) {
  // The payload carries only an id by design (R12a) — but the client is
  // holding the parent panel, so it can say "Step of Workflow · 2 lanes"
  // instead of "Step of subagents:plan:00948221-af12-4c…".
  const parentTitle = usePanelsState((root) =>
    panel.parent ? root.panels.entries[panelKey(path, panel.parent.id)]?.panel.title : undefined,
  );
  const rows: Array<[string, string]> = [];
  if (panel.model) {
    const asked = panel.requested?.model;
    rows.push(["Model", asked && asked !== panel.model ? `${panel.model} (asked for ${asked})` : panel.model]);
  } else if (panel.requested?.model) rows.push(["Model", `${panel.requested.model} requested`]);
  if (panel.requested?.thinking) rows.push(["Thinking", panel.requested.thinking]);
  if (panel.origin) rows.push(["Started by", panel.origin]);
  if (panel.parent) rows.push([panel.parent.relation === "step-of" ? "Step of" : "Spawned by", parentTitle ?? panel.parent.id]);
  if (panel.startedAt) rows.push(["Started", new Date(panel.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })]);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-xs leading-5 text-ink-3">{label}</dt>
          <dd className="typed truncate leading-5 text-ink-2" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Tokens and cost, or "not measured" — never a silent zero (R8). */
export function UsageRow({ usage, compact = false }: { usage: PanelUsage | null | undefined; compact?: boolean }) {
  if (usage === undefined) return null;
  if (usage === null || (totalTokens(usage) === undefined && usage.costUsd == null)) {
    return (
      <p className={cn("text-xs text-ink-3", compact && "truncate")}>
        <span className="font-medium text-ink-2">Not measured</span>
        {usage?.unavailableReason ? ` · ${usage.unavailableReason}` : " · this producer reports no usage"}
      </p>
    );
  }
  const cells: Array<[string, string]> = [];
  if (usage.input !== undefined) cells.push(["in", tokens(usage.input)]);
  if (usage.output !== undefined) cells.push(["out", tokens(usage.output)]);
  if (usage.cacheRead !== undefined) cells.push(["cache read", tokens(usage.cacheRead)]);
  if (usage.cacheWrite !== undefined) cells.push(["cache write", tokens(usage.cacheWrite)]);
  if (typeof usage.costUsd === "number") cells.push(["cost", money(usage.costUsd)]);
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-0.5" aria-label="Usage">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1">
          <dt className="eyebrow">{label}</dt>
          <dd className={cn("typed", label === "cost" ? "font-medium text-ink" : "text-ink-2")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
