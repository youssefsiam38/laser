"use client";
/**
 * `elements-tool-timeline` (assistant-ui registry), de-demoed and restyled:
 * a whole run's tool calls as verbs, targets and file stats — the sequence
 * inside an expanded `run` island (docs/ux-elements.md "Tool timeline").
 *
 * The registry copy takes `visibleSteps` (a demo's typewriter) and a
 * per-step `icon`. Here the steps are built from real tool-call parts by
 * `toolTimelineFromParts` (verb and target from `tool-summary.ts`, file stats
 * from `diff.ts`), the icon follows the tool's kind, and the live step
 * shimmers while it runs. `useThreadToolTimeline` reads the current thread.
 */
import { useAuiState, type ToolCallMessagePart, type ToolCallMessagePartStatus } from "@assistant-ui/react";
import { ChevronRight } from "lucide-react";
import { useMemo, type ComponentProps } from "react";

import { diffStats, diffViewForTool } from "@/components/thread/diff";
import { isNonZeroExit, resultDetails, resultText, shortPath, summarizeTool, type ToolKind } from "@/components/thread/tool-summary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { DiffStat } from "./code-diff.js";
import { collapsePanel, mono, ShimmerLabel, SwapLabel } from "./surfaces.js";
import { TOOL_ICONS } from "./tool-group.aui.js";

export interface TimelineStep {
  id: string;
  kind: ToolKind;
  verb: string;
  /** The typed target: a path, a command, a pattern. */
  chip: string;
  running: boolean;
  failed: boolean;
}

export interface TimelineStat {
  file: string;
  added: number;
  removed: number;
}

export interface ToolTimeline {
  steps: TimelineStep[];
  stats: TimelineStat[];
  /** Any step still running. */
  streaming: boolean;
}

/** The shape both `thread.messages` and a projected message satisfy; parts are narrowed by `type`. */
export type MessageLike = { readonly id?: string; readonly parts: readonly { readonly type: string }[] };
type ToolPart = ToolCallMessagePart & { readonly status: ToolCallMessagePartStatus };

/** Every tool call in `messages`, in order, with per-file churn from edits and writes. */
export function toolTimelineFromParts(messages: readonly MessageLike[]): ToolTimeline {
  const steps: TimelineStep[] = [];
  const churn = new Map<string, TimelineStat>();
  let streaming = false;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      const p = part as ToolPart;
      const s = summarizeTool(p.toolName, p.args);
      const running = p.status.type === "running" || p.status.type === "requires-action";
      // A command that ran and came back non-zero is a result, not a failure
      // (D-148). The transcript stopped calling it one; the monitor's chips
      // read from the same predicate so the two cannot disagree.
      const failed =
        (p.isError === true || (p.status.type === "incomplete" && p.status.reason !== "cancelled")) &&
        !isNonZeroExit(p.toolName, p.isError === true, resultText(p.result));
      streaming ||= running;
      steps.push({ id: p.toolCallId, kind: s.kind, verb: s.verb, chip: s.summary || s.verb, running, failed });
      if ((s.kind === "edit" || s.kind === "write") && !failed) {
        const view = diffViewForTool(s.kind, p.args, resultDetails(p.result));
        const path = view?.path;
        if (view && path) {
          const { added, removed } = diffStats(view.hunks);
          const prev = churn.get(path) ?? { file: shortPath(path), added: 0, removed: 0 };
          churn.set(path, { ...prev, added: prev.added + added, removed: prev.removed + removed });
        }
      }
    }
  }
  return { steps, stats: [...churn.values()], streaming };
}

/** The current thread's timeline; the run the person is looking at. */
export function useThreadToolTimeline(): ToolTimeline {
  const messages = useAuiState((s) => s.thread.messages) as readonly MessageLike[];
  return useMemo(() => toolTimelineFromParts(messages), [messages]);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface ToolTimelineProps extends Omit<ComponentProps<"div">, "children"> {
  timeline: ToolTimeline;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolTimeline({ timeline, open, onOpenChange, className, ...props }: ToolTimelineProps) {
  const { steps, stats, streaming } = timeline;
  const failed = steps.filter((s) => s.failed).length;
  const restingLabel = `${plural(steps.length, "tool call", "tool calls")}${stats.length ? ` · ${plural(stats.length, "file changed", "files changed")}` : ""}`;
  const live = steps.find((s) => s.running);
  const activeLabel = live ? `${live.verb} ${live.chip}` : "Working";

  if (steps.length === 0) {
    return (
      <p data-slot="tool-timeline" className={cn("text-sm text-ink-3", className)}>
        No tools used yet.
      </p>
    );
  }

  return (
    <Collapsible data-slot="tool-timeline" open={open} onOpenChange={onOpenChange} className={cn("w-full min-w-0", className)} {...props}>
      <CollapsibleTrigger
        className={cn(
          "group/trigger flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md text-start text-sm text-ink-2 outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) ease-(--motion-ease) group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none"
        />
        <SwapLabel active={streaming ? 0 : 1} className="min-w-0 text-start tabular-nums">
          <ShimmerLabel active={streaming} className="relative inline-block truncate leading-none">
            {activeLabel}
          </ShimmerLabel>
          <>{restingLabel}</>
        </SwapLabel>
        {failed > 0 ? <span className={cn(mono, "ms-auto shrink-0 text-danger")}>{plural(failed, "failure", "failures")}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <ol className="flex flex-col gap-1.5 ps-5 pt-2">
          {steps.map((step) => {
            const Icon = TOOL_ICONS[step.kind];
            return (
              <li key={step.id} className="flex min-w-0 items-center gap-2 text-sm text-ink-2" data-running={step.running || undefined}>
                <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", step.failed ? "text-danger" : "text-ink-3")} />
                <ShimmerLabel active={step.running} className="shrink-0 leading-none">
                  {step.verb}
                </ShimmerLabel>
                <span className={cn(mono, "min-w-0 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-ink-2")} title={step.chip}>
                  {step.chip}
                </span>
                {step.failed ? <span className={cn(mono, "shrink-0 text-danger")}>failed</span> : null}
              </li>
            );
          })}
        </ol>
        {stats.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5 ps-5 pt-2.5">
            {stats.map((stat) => (
              <li key={stat.file} className={cn(mono, "inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-ink-2")}>
                <span className="min-w-0 truncate" title={stat.file}>
                  {stat.file}
                </span>
                <DiffStat added={stat.added} removed={stat.removed} />
              </li>
            ))}
          </ul>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
