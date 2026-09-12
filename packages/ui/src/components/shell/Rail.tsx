import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, type ButtonHTMLAttributes, type CSSProperties } from "react";
import { FileClock, FolderPlus, Moon, Settings, Sun } from "lucide-react";

import { StatusRing, STATUS_LABEL } from "@/components/status";
// Agents page (M13-T5): the rail's way in, with its warning mark.
import { AgentsButton } from "@/components/agents/page/AgentsButton";
// Beam: its one entry point, the spark below Settings (docs/agents.md "Beam").
import { BeamSpark } from "@/components/beam/BeamSpark";
import { LaserLogo } from "@/components/brand/Logo";
import { useWorkbench } from "@/components/workbench";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { initials } from "@/format";
import { useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";

import { projectSummaries, trustLabel, type ProjectSummary } from "./model.js";
import { sessionsList, useSessionsList } from "./session-groups.js";
import { useShell } from "./shell-context.js";

/** Two summary lists are the same when every rendered field is. */
const sameSummaries = (a: readonly ProjectSummary[], b: readonly ProjectSummary[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i]!;
    return (
      p.cwd === q.cwd &&
      p.status === q.status &&
      p.sessionCount === q.sessionCount &&
      p.needYou === q.needYou &&
      p.trust === q.trust &&
      p.worker?.status === q.worker?.status
    );
  });

/**
 * The 56px project rail. One ring per directory: the ring is the project's
 * directory marker. Session activity lives on its single canonical chat row,
 * never as a second attention highlight on the project.
 *
 * A project icon jumps to and filters that project's group in the sessions
 * list rather than replacing the list (D-20 §6); clicking the active icon
 * again clears the filter. Either way the project becomes current, so Cmd+N
 * and the header's `+` start sessions there.
 */
export function Rail() {
  const { projects } = useLaserStable();
  const shell = useShell();
  const { theme, toggle } = useTheme();
  const workbench = useWorkbench();

  return (
    <nav
      aria-label="Projects"
      className="flex h-full w-14 shrink-0 flex-col items-center bg-surface-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-[calc(env(safe-area-inset-bottom)+8px)] hairline-e"
    >
      <Brand />
      {/* Keyed on the project list: `useLaserState` caches by store state,
          and the project list is React state, so a new project would otherwise
          wait for the next store change to appear. */}
      <ProjectList key={projects.join("\n")} />
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        <TooltipIconButton
          tooltip={theme === "dark" ? "Light theme" : "Dark theme"}
          side="right"
          size="icon"
          className="text-ink-3 hover:text-ink"
          onClick={toggle}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </TooltipIconButton>
        {/* Agents page (M13-T5), above Logs. */}
        <AgentsButton side="right" />
        <TooltipIconButton
          tooltip="Logs"
          side="right"
          size="icon"
          aria-current={workbench.page === "logs" ? "page" : undefined}
          className={cn("text-ink-3 hover:text-ink", workbench.page === "logs" && "bg-surface text-ink")}
          onClick={() => workbench.open("logs")}
        >
          <FileClock />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="Settings"
          side="right"
          size="icon"
          aria-current={workbench.page === "settings" ? "page" : undefined}
          className={cn("text-ink-3 hover:text-ink", workbench.page === "settings" && "bg-surface text-ink")}
          onClick={() => workbench.open("settings")}
        >
          <Settings />
        </TooltipIconButton>
        {/* Beam's spark: the last item, directly below Settings. */}
        <BeamSpark side="right" size="icon" />
      </div>
    </nav>
  );
}

function ProjectList() {
  const { projects, projectInfo, currentProject, actions } = useLaserStable();
  const shell = useShell();
  const { filter } = useSessionsList();
  // Derived inside the selector so a streamed token that changes nothing the
  // rail shows does not re-render it (or its Radix tooltips).
  const summaries = useLaserState(
    useCallback((s) => projectSummaries(projects, s.sessions, s.open, s.workers, projectInfo), [projectInfo, projects]),
    sameSummaries,
  );

  const select = useCallback(
    (cwd: string) => {
      const wasActive = cwd === currentProject;
      if (wasActive && filter === cwd) sessionsList.clearFilter(cwd);
      else sessionsList.filter(cwd);
      void actions.goProject(cwd);
      // Bring the list on screen: the docked column when it was hidden with
      // `[`, the sheet on tablet. The workbench, if open, stays where it is —
      // the list is a peer of it, not a page.
      shell.setSessionsOpen(true);
    },
    [actions, currentProject, filter, shell],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorder = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const from = projects.indexOf(String(active.id));
      const to = projects.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      void actions.reorderProjects(arrayMove(projects, from, to));
    },
    [actions, projects],
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
      <SortableContext items={projects} strategy={verticalListSortingStrategy}>
        <ul role="list" className="mt-2 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1 scrollbar-none">
          {summaries.map((project) => (
            <SortableProjectButton
              key={project.cwd}
              project={project}
              active={project.cwd === currentProject}
              filtered={filter === project.cwd}
              onSelect={() => select(project.cwd)}
            />
          ))}
          <li>
            <TooltipIconButton
              tooltip="Add project"
              side="right"
              size="icon"
              className="text-ink-3 hover:text-ink"
              onClick={() => shell.setAddProjectOpen(true)}
            >
              <FolderPlus />
            </TooltipIconButton>
          </li>
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableProjectButton(props: ProjectButtonProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.project.cwd });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li ref={setNodeRef} style={style} className={cn(isDragging && "z-10 opacity-80")}>
      <ProjectButton
        {...props}
        dragging={isDragging}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </li>
  );
}

/**
 * The logo means "back to my chat", from anywhere (M13-T50): the map, the
 * fullscreen map, Settings, Logs, the Agents page, a sheet. One click, one
 * keyboard activation, and the last opened session's chat is on screen.
 * The verb lives with the shell (chat-navigation.tsx); this is its button.
 */
function Brand() {
  const { returnToChat } = useShell();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Back to your chat"
          data-slot="back-to-chat"
          onClick={returnToChat}
          className="flex size-10 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live"
        >
          <LaserLogo className="size-8 rounded-lg shadow-float-sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Back to your chat</TooltipContent>
    </Tooltip>
  );
}

interface ProjectButtonProps {
  project: ProjectSummary;
  active: boolean;
  /** The sessions list is showing only this project. */
  filtered: boolean;
  onSelect(): void;
  dragging?: boolean;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

function ProjectButton({ project, active, filtered, onSelect, dragging = false, dragHandleProps }: ProjectButtonProps) {
  const count = `${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}`;
  const trust = trustLabel(project.trust);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...dragHandleProps}
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          aria-pressed={filtered}
          aria-label={`${project.name} — ${project.cwd}`}
          className={cn(
            "relative flex size-10 cursor-grab items-center justify-center rounded-lg active:cursor-grabbing",
            "transition-[background-color,color] duration-(--motion-instant) outline-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            filtered
              ? "bg-surface text-ink"
              : "text-ink-2 hover:bg-[color-mix(in_oklab,var(--surface)_65%,transparent)] hover:text-ink active:translate-y-px",
            // Selection bar on the rail's outer edge (8px outside the 40px button).
            "before:absolute before:-start-2 before:top-2.5 before:bottom-2.5 before:w-0.5 before:rounded-e-full before:bg-ink",
            "before:opacity-0 before:transition-opacity before:duration-(--motion-instant)",
            filtered && "before:opacity-100",
            dragging && "bg-surface text-ink shadow-float-sm",
          )}
        >
          <StatusRing status="idle" size={32} thickness={2} aria-hidden="true">
            <span className="font-mono text-xs font-medium tracking-typed">{initials(project.name)}</span>
          </StatusRing>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-80 items-start py-1.5">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">{project.name}</span>
          <span className="font-mono text-xs leading-4 break-all opacity-80">{project.cwd}</span>
          <span className="text-xs leading-4 opacity-70">
            {count}
            {project.status !== "idle" ? ` · ${STATUS_LABEL[project.status]}` : ""}
            {project.worker && project.worker.status !== "ready" ? ` · worker ${project.worker.status}` : ""}
          </span>
          {trust && <span className="text-xs leading-4 opacity-70">{trust.label}</span>}
          <span className="text-xs leading-4 opacity-70">
            {filtered
              ? "Click again to show every project"
              : active
                ? "Current for new chats and project settings · click to filter"
                : "Click to make current and show only this project's sessions"}
          </span>
          <span className="text-xs leading-4 opacity-70">Drag to change project priority</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
