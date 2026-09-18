"use client";
/**
 * The list column: your agents, the built-ins in a quieter section at the
 * bottom, and the harness policy row last. A listbox: arrows and Home/End
 * move between rows, Enter or Space (or a click) selects one.
 */
import { effectiveAgents, type AgentDefinition, type AgentWarning, type AgentsSnapshot } from "@lasercode/protocol";
import { Bot, FileWarning, MessageSquare, SlidersHorizontal, Sparkles, Tag } from "lucide-react";
import { useMemo, type KeyboardEvent, type ReactNode } from "react";

import { agentDisplayName } from "@/agents";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { agentForWarning, agentMark, orderAgents, sameSelection, selectionOfAgent, type AgentMark, type AgentsSelection } from "./model.js";

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
  view: "global" | "project" | "effective";
  projectCwd?: string | undefined;
  warnings: readonly AgentWarning[];
  selection: AgentsSelection;
  onSelect(selection: AgentsSelection): void;
  /** Drawn above the rows on a phone: the overview or first-run card. */
  lead?: ReactNode;
  className?: string | undefined;
}

export function AgentList({ snapshot, view, projectCwd, warnings, selection, onSelect, lead, className }: AgentListProps) {
  const { custom, builtin, warningCounts, fileWarnings } = useMemo(() => {
    const ordered = orderAgents(snapshot, projectCwd);
    const globals = snapshot.agents.filter((agent) => agent.kind === "custom" && agent.scope === "global");
    const projects = snapshot.agents.filter((agent) => agent.kind === "custom" && agent.scope === "project" && agent.projectCwd === projectCwd);
    const compareByName = (left: AgentDefinition, right: AgentDefinition) =>
      left.scope === "global" && left.name === snapshot.defaultAgent
        ? -1
        : right.scope === "global" && right.name === snapshot.defaultAgent
          ? 1
          : left.name.localeCompare(right.name);
    const custom = view === "global"
      ? globals.sort(compareByName)
      : view === "project"
        ? [...projects.sort(compareByName), ...globals.sort(compareByName)]
        : effectiveAgents(snapshot.agents, projectCwd).filter((agent) => agent.kind === "custom").sort(compareByName);
    const builtin = view === "global" ? ordered.builtin : [];
    const agents = [...custom, ...builtin];
    const byPath = new Map(agents.flatMap((agent) => agent.path ? [[agent.path, agent] as const] : []));
    const counts = new Map<AgentDefinition, number>();
    const unlinked: AgentWarning[] = [];
    for (const warning of warnings) {
      const linked = warning.path ? byPath.get(warning.path) : agentForWarning(snapshot, warning, projectCwd);
      if (linked) counts.set(linked, (counts.get(linked) ?? 0) + 1);
      else if (warning.field === "file") unlinked.push(warning);
    }
    return { custom, builtin, warningCounts: counts, fileWarnings: unlinked };
  }, [projectCwd, snapshot, view, warnings]);
  const warningCount = (agent: AgentDefinition) => warningCounts.get(agent) ?? 0;

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
            key={agent.scope === "project" ? `project:${agent.projectCwd}:${agent.name}` : `global:${agent.name}`}
            agent={agent}
            isDefault={agent.scope === "global" && agent.name === snapshot.defaultAgent}
            warnings={warningCount(agent)}
            shadowsGlobal={agent.scope === "project" && snapshot.agents.some((candidate) => candidate.scope === "global" && candidate.name === agent.name)}
            showGlobalBadge={view === "project" && agent.scope === "global"}
            selected={sameSelection(selection, selectionOfAgent(agent))}
            tabIndex={focusable(selectionOfAgent(agent), i === 0)}
            onSelect={() => onSelect(selectionOfAgent(agent))}
          />
        ))}
        {fileWarnings.map((warning) => (
          <FileWarningRow key={`${warning.agentName}:${warning.target ?? warning.since}`} warning={warning} />
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
            onSelect={() => selection?.kind === "new" && onSelect(selection)}
          />
        ) : null}
      </Group>
      {view === "global" ? (
        <>
          <Group label="Built in" quiet>
            {builtin.map((agent) => (
              <AgentRow
                key={agent.name}
                agent={agent}
                isDefault={false}
                warnings={warningCount(agent)}
                shadowsGlobal={false}
                showGlobalBadge={false}
                selected={sameSelection(selection, selectionOfAgent(agent))}
                tabIndex={focusable(selectionOfAgent(agent), false)}
                quiet
                onSelect={() => onSelect(selectionOfAgent(agent))}
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
        </>
      ) : null}
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
  shadowsGlobal,
  showGlobalBadge,
  selected,
  tabIndex,
  quiet = false,
  onSelect,
}: {
  agent: AgentDefinition;
  isDefault: boolean;
  warnings: number;
  shadowsGlobal: boolean;
  showGlobalBadge: boolean;
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
      label={`${name}${agent.scope === "project" ? shadowsGlobal ? ", project agent that replaces the global agent in this project" : ", project agent" : showGlobalBadge ? ", read-only global source" : ""}${isDefault ? ", default for new sessions" : ""}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`}
      detail={agent.description || (mark === "custom" ? "No description yet" : undefined)}
      selected={selected}
      tabIndex={tabIndex}
      quiet={quiet}
      data-slot="agent-row"
      data-agent={agent.name}
      data-scope={agent.scope}
      data-project-cwd={agent.projectCwd}
      data-warnings={warnings > 0 ? warnings : undefined}
      badges={
        <>
          {showGlobalBadge ? <Badge variant="outline" data-slot="agent-global-badge">Global</Badge> : null}
          {agent.scope === "project" ? (
            <Badge
              variant="outline"
              data-slot="agent-project-badge"
              aria-label={shadowsGlobal ? "Project agent; replaces the global agent with this name in this project" : "Project agent"}
            >
              Project
            </Badge>
          ) : null}
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

function FileWarningRow({ warning }: { warning: AgentWarning }) {
  return (
    <div
      role="note"
      data-slot="agent-file-warning-row"
      data-path={warning.path}
      aria-label={`${warning.message}${warning.path ? ` File: ${warning.path}` : ""}`}
      className="flex min-w-0 items-start gap-2.5 rounded-lg bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-2 text-start"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface text-attention">
        <FileWarning aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">Couldn’t load an agent file</span>
        <span className="text-xs leading-5 text-ink-2">{warning.message}</span>
        {warning.path ? <span aria-hidden="true" dir="ltr" className="typed truncate text-start text-ink-3">{warning.path}</span> : null}
      </span>
    </div>
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
