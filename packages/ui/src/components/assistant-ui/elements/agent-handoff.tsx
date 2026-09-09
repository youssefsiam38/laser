"use client";
/**
 * Handoff — "control passing between agents, with the reason and what came
 * along" (docs/ux-elements.md "Handoff"). Installed from
 * `elements-agent-handoff`; what is mounted is `AgentEventCard`, the
 * parent-side card a `lasercode/agent-event` custom message draws through
 * `thread/AgentEventMessage.tsx` (D-140, M13-T6).
 *
 * The registry's parent → child strip (`AgentHandoff`) was removed in
 * M13-T61: it had no caller since the run island went (D-147), and the
 * map's edges (`agents/map/`) say the same thing structurally.
 *
 * Divergences from the registry copy:
 *   - the child is the pill, followed by what happened, the reason when a
 *     person gave one, the child's message, and the way to its chat.
 *   - the message body is the caller's, so the transcript renderer stays
 *     the one Markdown renderer there is.
 *   - Colours are the live token and the inks; the fixed `max-w-sm` is gone.
 */
import { Bot, MessageSquare } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { useSearchReveal } from "@/components/thread/search-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { field, mono } from "./surfaces.js";

export type AgentEventKind = "agent.completed" | "agent.blocked" | "agent.failed" | "agent.cancelled" | "agent.message" | "agent.needs_input";
export type AgentEventInitiator = "parent" | "user" | "harness";

/** The tone the event's dot and its sentence take. */
export function agentEventTone(kind: AgentEventKind): "ok" | "attention" | "danger" | "muted" | "live" {
  switch (kind) {
    case "agent.completed":
      // Muted, not `ok`. Green means happening now in this app, and a run that
      // has finished is the one thing that needs no attention (D-154).
      return "muted";
    case "agent.blocked":
    // Live and paused on a question: the warm hue, because it needs someone.
    case "agent.needs_input":
      return "attention";
    case "agent.failed":
      return "danger";
    case "agent.cancelled":
      return "muted";
    case "agent.message":
      return "live";
  }
}

/** "{name} completed", "{name} was ended by you" — the verb in a person's words. */
export function agentEventSentence(name: string, kind: AgentEventKind, initiator: AgentEventInitiator | undefined): string {
  switch (kind) {
    case "agent.completed":
      return `${name} completed`;
    case "agent.blocked":
      return `${name} was blocked`;
    case "agent.failed":
      return `${name} failed`;
    case "agent.message":
      return `${name} sent a message`;
    case "agent.needs_input":
      return `${name} is asking a question`;
    case "agent.cancelled":
      return initiator === "user" ? `${name} was ended by you` : initiator === "parent" ? `${name} was ended by its parent` : `${name} was ended`;
  }
}

const DOT_TONE: Record<ReturnType<typeof agentEventTone>, string> = {
  ok: "bg-ok",
  attention: "bg-attention motion-safe:animate-attention",
  danger: "bg-danger",
  muted: "bg-ink-3",
  live: "bg-live",
};

export interface AgentEventCardProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  subagentName: string;
  agentName: string;
  kind: AgentEventKind;
  /** Who ended it, when it was ended. */
  initiator?: AgentEventInitiator | undefined;
  /** The person's verbatim reason, when they gave one. */
  reason?: string | undefined;
  /** The child's message, already rendered; folded past `collapseAt` lines. */
  children?: ReactNode;
  /** Wall-clock label of the event. */
  when?: string | undefined;
  whenTitle?: string | undefined;
  onOpen?: (() => void) | undefined;
  /** Lines of message shown before the fold. */
  collapseAt?: number;
}

export function AgentEventCard({
  subagentName,
  agentName,
  kind,
  initiator,
  reason,
  children,
  when,
  whenTitle,
  onOpen,
  collapseAt = 6,
  className,
  ...props
}: AgentEventCardProps) {
  const tone = agentEventTone(kind);
  // The run is still going for a message and for a question; only an ending settles.
  const settled = kind !== "agent.message" && kind !== "agent.needs_input";
  const sentence = agentEventSentence(subagentName, kind, initiator);
  return (
    <div
      data-slot="agent-event-card"
      data-kind={kind}
      // Search opts in per region below: the sentence and the labels are
      // chrome, the message and the reason are content.
      data-search-tool
      className={cn("flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2.5", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT_TONE[tone])} />
        <span
          className={cn(
            "flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-xs",
            settled ? cn(field, "text-ink") : "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live",
          )}
          title={`${subagentName} · ${agentName}`}
        >
          <Bot className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{subagentName}</span>
        </span>
        <span data-slot="agent-event-sentence" className={cn("min-w-0 text-sm font-medium", tone === "danger" ? "text-danger" : tone === "attention" ? "text-attention" : "text-ink")}>
          {sentence.slice(subagentName.length).trim()}
        </span>
        <span className={cn(mono, "text-ink-3")} title={`Agent: ${agentName}`}>{agentName}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          {when ? <span className={cn(mono, "text-ink-3 tnum")} title={whenTitle}>{when}</span> : null}
          {onOpen ? (
            <Button size="xs" variant="ghost" onClick={onOpen} data-slot="agent-event-open" className="-me-1 text-ink-2">
              <MessageSquare />
              Open chat
            </Button>
          ) : null}
        </span>
      </div>
      {reason ? (
        <p className="border-s-2 border-line ps-2.5 text-sm leading-sm text-ink-2">
          <span className="text-ink-3">Reason: </span>
          <span data-search-content="reason" className="whitespace-pre-wrap wrap-break-word text-ink">{reason}</span>
        </p>
      ) : null}
      {children ? <FoldedBody lines={collapseAt}>{children}</FoldedBody> : null}
    </div>
  );
}

/**
 * A body that folds past `lines` of prose and opens in place: the measured
 * height plays on `--motion-fast`; reduced motion makes it instant. Search
 * reveals it, so a match inside the fold is never hidden from the finder.
 */
function FoldedBody({ lines, children }: { lines: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [full, setFull] = useState<number | undefined>(undefined);
  const reveal = useSearchReveal();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const cap = Number.parseFloat(getComputedStyle(element).lineHeight) * lines;
      setFull(element.scrollHeight);
      setOverflow(element.scrollHeight > cap + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [lines, children]);
  const expanded = open || reveal || !overflow;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        ref={ref}
        data-slot="agent-event-message"
        data-search-content="message"
        data-folded={!expanded || undefined}
        style={expanded ? (full !== undefined && overflow ? { maxHeight: full } : undefined) : { maxHeight: `calc(${lines} * 1lh)` }}
        className={cn("min-w-0 overflow-hidden text-base leading-base text-ink transition-[max-height] duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none")}
      >
        {children}
      </div>
      {overflow ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={expanded}
          data-search-exclude
          className="self-start text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live pointer-coarse:min-h-11"
        >
          {expanded ? "Show less" : "Show the whole message"}
        </button>
      ) : null}
    </div>
  );
}
