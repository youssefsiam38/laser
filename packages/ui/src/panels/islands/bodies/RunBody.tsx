import type { PanelUsage, RunPanel } from "@piorbit/protocol";

import { AgentHandoff } from "@/components/assistant-ui/elements/agent-handoff";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { JobProgress } from "@/components/assistant-ui/elements/job-progress";
import { SpecSheet, type SpecRow } from "@/components/assistant-ui/elements/spec-sheet";
import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";
import { Timeline, type TimelineEvent } from "@/components/assistant-ui/elements/timeline";
import { clockTime, money, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { mediaTypeOfRef, usePanelsState } from "../../PanelsProvider.js";
import { elapsedOf, panelKey, type PanelEntry } from "../../store.js";
import { formatElapsed, shortMediaType, totalTokens } from "../../values.js";
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
 * Agent work with a lifecycle: the activity line, the handoff from its
 * parent, progress and phase (never a fake bar), the run's timeline, usage
 * that knows "not measured" from zero (R8), the live output as an embedded
 * stream, artifacts as cards, and exactly the actions the producer declared
 * (R2). The pieces are the catalog's — agent-handoff, job-progress, timeline,
 * artifact-card (docs/ux-elements.md) — fed from the `run` payload.
 */
export function RunBody({ entry, panel, now, onAct, onOpenRef }: RunBodyProps) {
  const elapsed = elapsedOf(entry, now);
  const terminal = panel.lifecycle === "done" || panel.lifecycle === "failed" || panel.lifecycle === "cancelled";
  // Running, saying something, and with no stream of its own to watch: every
  // word it has arrives whole, a message at a time (R4).
  const bursty = panel.lifecycle === "running" && panel.activity !== undefined && panel.output === undefined;
  // The payload carries only an id by design (R12a) — but the client is
  // holding the parent panel, so the handoff can say "Workflow · 2 lanes"
  // instead of "subagents:plan:00948221-af12-4c…".
  const parentTitle = usePanelsState((root) => (panel.parent ? root.panels.entries[panelKey(entry.path, panel.parent.id)]?.panel.title : undefined));
  const events = timelineOf(panel, terminal);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* One line, truncated: in a narrow dock a wrapping state line used
              to run under the elapsed time and the two collided (R13). */}
          <p className="truncate text-sm text-ink-2" title={[LIFECYCLE_WORDS[panel.lifecycle], panel.terminalReason, panel.handle].filter(Boolean).join(" · ")}>
            <span className={cn("font-medium", panel.lifecycle === "failed" ? "text-danger" : "text-ink")}>{LIFECYCLE_WORDS[panel.lifecycle]}</span>
            {panel.terminalReason && <span className="text-ink-2"> · {panel.terminalReason}</span>}
            {panel.handle && <span className="typed ms-2 text-ink-3">{panel.handle}</span>}
          </p>
          {panel.activity ? (
            <>
              <p className="mt-0.5 line-clamp-2 text-sm leading-sm text-ink" title={panel.activity}>
                {panel.activity}
              </p>
              {/* R4, fidelity honesty: a detached run emits no text deltas, so
                  what is above is a whole message that arrived at once. Saying
                  so is the alternative to faking a typewriter. */}
              {bursty && <p className="eyebrow mt-1">updates in bursts</p>}
            </>
          ) : panel.lifecycle === "running" ? (
            /* R4: it is working and has sent nothing. Three dots that read as
               presence are the honest substitute for a typewriter on a run
               that emits no deltas — and they say so in words for a reader
               who cannot see them. */
            <TypingIndicator className="mt-1" />
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

      {panel.parent && (
        <AgentHandoff
          from={parentTitle ?? panel.parent.id}
          to={panel.title}
          relation={panel.parent.relation === "step-of" ? "step of" : "spawned by"}
          carried={requestedOf(panel)}
          settled={terminal}
        />
      )}

      <JobProgress progress={panel.progress} phase={panel.phase} />

      {panel.error && (
        <p className="border-s-2 border-danger ps-3 text-sm leading-sm wrap-break-word whitespace-pre-wrap text-ink" role="alert">
          {panel.error}
        </p>
      )}

      <SpecSheet rows={metaRows(panel)} bare />
      <UsageRow usage={panel.usage} />

      {events.length > 0 && (
        <section aria-label="Timeline" className="flex flex-col gap-1.5">
          <h4 className="eyebrow">Timeline</h4>
          <Timeline events={events} />
        </section>
      )}

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
        <section aria-label="Artifacts" className="flex flex-col gap-1.5">
          <h4 className="eyebrow">Artifacts</h4>
          <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5">
            {panel.artifacts.map((artifact) => (
              <li key={artifact.ref} className="min-w-0">
                <ArtifactCard
                  className="w-full"
                  title={artifact.label}
                  meta={shortMediaType(mediaTypeOfRef(artifact.ref).mediaType)}
                  onClick={() => onOpenRef(artifact.ref, artifact.label)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <ActionButtons actions={panel.actions} onAct={onAct} className="mt-auto" />
    </div>
  );
}

/** What the parent asked for, for the handoff's "asked for" list. Only what the payload says (R12a). */
function requestedOf(panel: RunPanel): string[] {
  const out: string[] = [];
  if (panel.requested?.model) out.push(`model ${panel.requested.model}`);
  if (panel.requested?.thinking) out.push(`thinking ${panel.requested.thinking}`);
  return out;
}

/**
 * The moments a run records: started, the phase it is in, how it ended. Only
 * with a `startedAt` — an event with no time is not on a time axis.
 */
function timelineOf(panel: RunPanel, terminal: boolean): TimelineEvent[] {
  if (!panel.startedAt) return [];
  const events: TimelineEvent[] = [{ id: "started", when: "past", time: clockTime(panel.startedAt), title: "Started", ...(panel.origin ? { detail: `by ${panel.origin}` } : {}) }];
  if (panel.phase && !terminal) {
    const known = panel.phase.index !== undefined && panel.phase.total !== undefined;
    events.push({ id: "phase", when: "now", time: "", title: panel.phase.label, ...(known ? { detail: `phase ${panel.phase.index} of ${panel.phase.total}` } : {}) });
  }
  if (terminal) {
    const title = LIFECYCLE_WORDS[panel.lifecycle];
    events.push({
      id: "ended",
      when: "past",
      time: panel.endedAt ? clockTime(panel.endedAt) : "",
      title,
      ...(panel.terminalReason ? { detail: panel.terminalReason } : {}),
      ...(panel.lifecycle === "failed" ? { tone: "danger" as const } : {}),
    });
  } else if (panel.lifecycle === "paused") {
    events.push({ id: "paused", when: "now", time: "", title: "Paused", tone: "muted" });
  }
  return events;
}

/**
 * The rows the run body itself owns, rendered through the catalog's spec
 * sheet. Deliberately NOT `runSpecRows`: that is the whole of what a run
 * knows, and most of it is already on screen here — the handle is in the
 * state line, the parent is the handoff, tokens are the usage row. Repeating
 * them in a second list is noise, so this picks the ones nothing else shows.
 */
function metaRows(panel: RunPanel): SpecRow[] {
  const rows: SpecRow[] = [];
  if (panel.model) {
    const asked = panel.requested?.model;
    rows.push({ label: "Model", value: asked && asked !== panel.model ? `${panel.model} (asked for ${asked})` : panel.model, typed: true });
  } else if (panel.requested?.model) {
    rows.push({ label: "Model", value: `${panel.requested.model} requested`, typed: true });
  }
  if (panel.requested?.thinking) rows.push({ label: "Thinking", value: panel.requested.thinking, typed: true });
  // "Started by" lives on the timeline's first event once there is a timeline.
  if (panel.origin && !panel.startedAt) rows.push({ label: "Started by", value: panel.origin });
  return rows;
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
