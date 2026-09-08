"use client";
/**
 * The list column: your agents, the built-ins in a quieter section at the
 * bottom, and the harness policy row last. A listbox: arrows and Home/End
 * move between rows, Enter or Space (or a click) selects one.
 */
import type { AgentDefinition, AgentWarning, AgentsSnapshot } from "@lasercode/protocol";
import { Bot, MessageSquare, SlidersHorizontal, Sparkles, Tag } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { agentDisplayName } from "@/agents";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { agentMark, orderAgents, sameSelection, type AgentMark, type AgentsSelection } from "./model.js";

const MARK_ICON: Record<AgentMark, typeof Bot> = {
  default: Bot,
  custom: Bot,
  beam: Sparkles,
  chat: MessageSquare,
  namer: Tag,
};

export function AgentMarkIcon({ mark, className }: { mark: AgentMark; className?: string | undefined }) {
  const Icon = MARK_ICON[mark];
  return <Icon aria-hidden="true" className={className} />;
}

export interface AgentListProps {
  snapshot: AgentsSnapshot;
  warnings: readonly AgentWarning[];
  selection: AgentsSelection;
  onSelect(selection: AgentsSelection): void;
  /** Drawn above the rows on a phone: the overview or first-run card. */
  lead?: ReactNode;
  className?: string | undefined;
}

export function AgentList({ snapshot, warnings, selection, onSelect, lead, className }: AgentListProps) {
  const { custom, builtin } = orderAgents(snapshot);
  const warningCount = (name: string) => warnings.filter((warning) => warning.agentName === name).length;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    if (options.length === 0) return;
    const index = options.findIndex((option) => option === document.activeElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(options.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    options[next]?.focus();
  };

  // Roving tabindex: the selected row is the one Tab lands on, else the first.
  const focusable = (candidate: AgentsSelection, first: boolean): number => (selection ? (sameSelection(selection, candidate) ? 0 : -1) : first ? 0 : -1);

  return (
    <div
      role="listbox"
      aria-label="Agents"
      data-slot="agent-list"
      className={cn("flex flex-col gap-4 px-2 py-3", className)}
      onKeyDown={onKeyDown}
    >
      {lead}
      <Group label="Your agents">
        {custom.map((agent, i) => (
          <AgentRow
            key={agent.name}
            agent={agent}
            isDefault={agent.name === snapshot.defaultAgent}
            warnings={warningCount(agent.name)}
            selected={sameSelection(selection, { kind: "agent", name: agent.name })}
            tabIndex={focusable({ kind: "agent", name: agent.name }, i === 0)}
            onSelect={() => onSelect({ kind: "agent", name: agent.name })}
          />
        ))}
        {selection?.kind === "new" ? (
          <Row
            icon={<Bot aria-hidden="true" />}
            title="New agent"
            detail="Not saved yet"
            selected
            tabIndex={0}
            data-slot="agent-row"
            data-agent=""
            onSelect={() => onSelect({ kind: "new" })}
          />
        ) : null}
      </Group>
      <Group label="Built in" quiet>
        {builtin.map((agent) => (
          <AgentRow
            key={agent.name}
            agent={agent}
            isDefault={false}
            warnings={warningCount(agent.name)}
            selected={sameSelection(selection, { kind: "agent", name: agent.name })}
            tabIndex={focusable({ kind: "agent", name: agent.name }, false)}
            quiet
            onSelect={() => onSelect({ kind: "agent", name: agent.name })}
          />
        ))}
      </Group>
      <Group label="Harness" quiet>
        <Row
          icon={<SlidersHorizontal aria-hidden="true" />}
          title="Limits"
          detail={`Depth ${snapshot.policy.maxDepth} · commands ${snapshot.policy.foregroundCommandSeconds}s`}
          selected={selection?.kind === "harness"}
          tabIndex={focusable({ kind: "harness" }, false)}
          quiet
          data-slot="harness-row"
          onSelect={() => onSelect({ kind: "harness" })}
        />
      </Group>
    </div>
  );
}

function Group({ label, quiet = false, children }: { label: string; quiet?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} data-slot="agent-group" data-quiet={quiet || undefined} className="flex flex-col gap-0.5">
      <span className={cn("eyebrow px-2 pb-1", quiet && "text-ink-3/80")}>{label}</span>
      {children}
    </div>
  );
}

function AgentRow({
  agent,
  isDefault,
  warnings,
  selected,
  tabIndex,
  quiet = false,
  onSelect,
}: {
  agent: AgentDefinition;
  isDefault: boolean;
  warnings: number;
  selected: boolean;
  tabIndex: number;
  quiet?: boolean;
  onSelect(): void;
}) {
  const mark = agentMark(agent);
  const name = agentDisplayName(agent.name);
  return (
    <Row
      icon={<AgentMarkIcon mark={mark} />}
      title={name}
      label={`${name}${isDefault ? ", default for new sessions" : ""}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`}
      detail={agent.description || (mark === "custom" ? "No description yet" : undefined)}
      selected={selected}
      tabIndex={tabIndex}
      quiet={quiet}
      data-slot="agent-row"
      data-agent={agent.name}
      data-warnings={warnings > 0 ? warnings : undefined}
      badges={
        <>
          {isDefault ? (
            <Badge variant="live" data-slot="agent-default-badge">
              Default
            </Badge>
          ) : null}
          {warnings > 0 ? (
            <Badge variant="attention" data-slot="agent-warning-badge" aria-label={`${warnings} warning${warnings === 1 ? "" : "s"}`}>
              {warnings}
            </Badge>
          ) : null}
        </>
      }
      onSelect={onSelect}
    />
  );
}

interface RowProps {
  icon: ReactNode;
  title: string;
  /** The accessible name, when the badges add to the title. */
  label?: string | undefined;
  detail?: string | undefined;
  badges?: ReactNode;
  selected: boolean;
  tabIndex: number;
  quiet?: boolean;
  onSelect(): void;
  [data: `data-${string}`]: string | number | undefined;
}

function Row({ icon, title, label, detail, badges, selected, tabIndex, quiet = false, onSelect, ...data }: RowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={label ?? title}
      tabIndex={tabIndex}
      onClick={onSelect}
      className={cn(
        "group/row flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-start outline-none",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        selected ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/60 hover:text-ink active:bg-surface-2",
      )}
      {...data}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4",
          selected ? "bg-surface text-ink" : quiet ? "bg-transparent text-ink-3" : "bg-surface text-ink-2",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm", selected ? "font-medium text-ink" : quiet ? "text-ink-2" : "text-ink")}>{title}</span>
          {badges}
        </span>
        {detail ? (
          <span className="truncate text-xs text-ink-3" title={detail}>
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}
