import { CheckCheck, Target } from "lucide-react";
import { useState } from "react";
import { ToolFallbackContent, ToolFallbackRoot, ToolFallbackTrigger } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { Timeline } from "@/components/assistant-ui/elements/timeline";
import { useActivityDetailLevel, useLaserState } from "@/runtime";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import type { GoalRecord as RecordData } from "@/runtime/goal-history";

const statusLabel = (status: string) => ({ active: "Working toward the goal", complete: "Goal completed", paused: "Goal paused", blocked: "Goal blocked", waiting: "Waiting for external work", cleared: "Goal cleared", replaced: "Goal replaced", usage_limited: "Provider limit reached" })[status] ?? "Goal updated";

/** Reuses the adopted activity disclosure and timeline, not another card grammar. */
export function GoalRecord({ goal }: { goal: RecordData }) {
  const path = useLaserState(state => state.current);
  const level = useActivityDetailLevel(path);
  const [choice, setChoice] = useState<{ level: string; open: boolean }>();
  const open = choice?.level === level ? choice.open : level === "everything";
  return (
    <ToolFallbackRoot open={open} onOpenChange={value => setChoice({ level, open: value })} className="my-2" data-goal-record={goal.id}>
      <ToolFallbackTrigger verb={statusLabel(goal.status)} icon={goal.status === "complete" ? CheckCheck : Target} state="done" showDuration={false} trailing={<span className="text-xs text-ink-3">View goal</span>} />
      <ToolFallbackContent>
        <div className="space-y-4 p-3" data-search-content="goal">
          <section className="space-y-1">
            <h3 className="eyebrow flex items-center gap-2 text-ink-3"><Target className="size-3.5" aria-hidden="true" />Original objective</h3>
            <p className="whitespace-pre-wrap wrap-break-word text-sm text-ink">{goal.moments[0]?.objective ?? goal.objective}</p>
          </section>
          {goal.summary && <section className="space-y-1">
            <h3 className="eyebrow flex items-center gap-2 text-ink-3"><CheckCheck className="size-3.5 text-ok" aria-hidden="true" />Completion summary</h3>
            <MarkdownPreview text={goal.summary} className="p-0" />
          </section>}
          <section className="space-y-2">
            <h3 className="eyebrow text-ink-3">Goal history</h3>
            <Timeline events={goal.moments.map((moment, index) => ({
              id: `${goal.id}:${index}`, when: "past", time: new Date(moment.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
              title: index === 0 ? "Goal set" : moment.objective !== goal.moments[index - 1]?.objective ? "Objective updated" : statusLabel(moment.status),
              detail: [index > 0 && moment.objective !== goal.moments[index - 1]?.objective ? moment.objective : undefined, moment.reason].filter(Boolean).join("\n") || undefined,
            }))} />
          </section>
          {goal.continuations > 0 && <p className="text-xs text-ink-3" title="Times the goal automatically asked the agent to continue after it would otherwise stop. Not tool calls or a separate evaluation.">{goal.continuations} automatic continuation{goal.continuations === 1 ? "" : "s"}</p>}
        </div>
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}
