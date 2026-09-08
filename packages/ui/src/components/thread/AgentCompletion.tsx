"use client";
/**
 * A child's final message (docs/agents.md "Completion"). The harness stores
 * the `complete_agent_run` call once, in the child's own transcript, and the
 * projection hands it here as {@link AGENT_COMPLETION_DATA_PART} instead of a
 * tool row: a run that ends reads like a reply that ends, with its outcome as
 * a badge, its message as prose, and the moment it happened.
 *
 * Search opts in to the message alone (`data-search-content`), matching the
 * protocol's `complete_agent_run` projection; the badge and the clock are
 * chrome.
 */
import { CheckCheck, CircleAlert } from "lucide-react";

import { messageTimeDescription, messageTimeLabel } from "@/components/assistant-ui/elements/message-timestamp";
import { ShimmerLabel } from "@/components/assistant-ui/elements/surfaces";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentCompletionData } from "@/runtime";

export function AgentCompletion({ data }: { data: AgentCompletionData }) {
  const blocked = data.status === "blocked";
  const at = data.at ? new Date(data.at) : undefined;
  const valid = at !== undefined && !Number.isNaN(at.getTime());
  return (
    <section
      data-slot="agent-completion"
      data-status={data.status}
      data-search-tool
      aria-label={blocked ? "Final message: blocked" : "Final message: completed"}
      className="my-2 flex min-w-0 flex-col gap-2 first:mt-0 last:mb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={blocked ? "attention" : "ok"} data-slot="agent-completion-status">
          {blocked ? <CircleAlert aria-hidden="true" /> : <CheckCheck aria-hidden="true" />}
          {blocked ? "Blocked" : "Completed"}
        </Badge>
        {!data.done ? <ShimmerLabel className="text-xs text-ink-3">Ending the run</ShimmerLabel> : null}
        {valid ? (
          <time dateTime={at.toISOString()} title={messageTimeDescription(at)} aria-label={messageTimeDescription(at)} className="ms-auto typed text-ink-3 tnum">
            {messageTimeLabel(at)}
          </time>
        ) : null}
      </div>
      <div
        data-search-content="message"
        className={cn("min-w-0 rounded-xl border border-line px-3 py-2", blocked ? "border-[color-mix(in_oklab,var(--attention)_32%,var(--line))] bg-[color-mix(in_oklab,var(--attention)_5%,var(--surface))]" : "bg-surface")}
      >
        <MarkdownPreview text={data.message} prose className="p-0" />
      </div>
    </section>
  );
}
