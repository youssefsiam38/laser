import { useCallback } from "react";
import { FileClock, FolderPlus, Moon, Settings, Sun } from "lucide-react";

import { StatusRing, STATUS_LABEL } from "@/components/status";
import { useWorkbench } from "@/components/workbench";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { initials } from "@/format";
import { useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitState } from "@/runtime";

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
 * aggregate status (live while any session works, attention while any waits,
 * danger when a worker crashed), the count is how many sessions need you.
 *
 * A project icon jumps to and filters that project's group in the sessions
 * list rather than replacing the list (D-20 §6); clicking the active icon
 * again clears the filter. Either way the project becomes current, so Cmd+N
 * and the header's `+` start sessions there.
 */
export function Rail() {
  const { projects } = usePiorbitStable();
  const shell = useShell();
  const { theme, toggle } = useTheme();
  const workbench = useWorkbench();

  return (
    <nav
      aria-label="Projects"
      className="flex h-full w-14 shrink-0 flex-col items-center bg-surface-2 pt-[calc(env(safe-area-inset-top)+8px)] pb-[calc(env(safe-area-inset-bottom)+8px)] hairline-r"
    >
      <Brand />
      {/* Keyed on the project list: `usePiorbitState` caches by store state,
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
      </div>
    </nav>
  );
}

function ProjectList() {
  const { projects, projectInfo, currentProject, setCurrentProject } = usePiorbitStable();
  const shell = useShell();
  const { filter } = useSessionsList();
  // Derived inside the selector so a streamed token that changes nothing the
  // rail shows does not re-render it (or its Radix tooltips).
  const summaries = usePiorbitState(
    useCallback((s) => projectSummaries(projects, s.sessions, s.open, s.workers, projectInfo), [projectInfo, projects]),
    sameSummaries,
  );

  const select = useCallback(
    (cwd: string) => {
      const wasActive = cwd === currentProject;
      setCurrentProject(cwd);
      if (wasActive && filter === cwd) sessionsList.clearFilter(cwd);
      else sessionsList.filter(cwd);
      // Bring the list on screen: the docked column when it was hidden with
      // `[`, the sheet on tablet. The workbench, if open, stays where it is —
      // the list is a peer of it, not a page.
      shell.setSessionsOpen(true);
    },
    [currentProject, filter, setCurrentProject, shell],
  );

  return (
    <ul role="list" className="mt-2 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1 scrollbar-none">
      {summaries.map((project) => (
        <li key={project.cwd}>
          <ProjectButton
            project={project}
            active={project.cwd === currentProject}
            filtered={filter === project.cwd}
            onSelect={() => select(project.cwd)}
          />
        </li>
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
  );
}

/** The orbit mark: a ring with one body on it. Monochrome, 20px. */
function Brand() {
  return (
    <div className="flex size-10 items-center justify-center" aria-label="piorbit" role="img">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="text-ink">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
        <circle cx="10" cy="10" r="2" fill="currentColor" />
        <circle cx="15.3" cy="4.7" r="2" fill="currentColor" />
      </svg>
    </div>
  );
}

interface ProjectButtonProps {
  project: ProjectSummary;
  active: boolean;
  /** The sessions list is showing only this project. */
  filtered: boolean;
  onSelect(): void;
}

function ProjectButton({ project, active, filtered, onSelect }: ProjectButtonProps) {
  const count = `${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}`;
  const trust = trustLabel(project.trust);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          aria-pressed={filtered}
          aria-label={`${project.name} — ${project.cwd}`}
          className={cn(
            "relative flex size-10 items-center justify-center rounded-lg",
            "transition-[background-color,color] duration-(--motion-instant) outline-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            active
              ? "bg-surface text-ink"
              : "text-ink-2 hover:bg-[color-mix(in_oklab,var(--surface)_65%,transparent)] hover:text-ink active:translate-y-px",
            // Selection bar on the rail's outer edge (8px outside the 40px button).
            "before:absolute before:-start-2 before:top-2.5 before:bottom-2.5 before:w-0.5 before:rounded-e-full before:bg-ink",
            "before:opacity-0 before:transition-opacity before:duration-(--motion-instant)",
            active && "before:opacity-100",
          )}
        >
          <StatusRing status={project.status} size={32} thickness={2} aria-hidden="true">
            <span className="font-mono text-xs font-medium tracking-typed">{initials(project.name)}</span>
          </StatusRing>
          {project.needYou > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -end-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-attention px-1 font-mono text-xs leading-none font-medium text-on-attention tnum ring-2 ring-surface-2"
            >
              {project.needYou}
            </span>
          )}
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
          <span className="text-xs leading-4 opacity-70">{filtered ? "Click again to show every project" : "Click to show only this project's sessions"}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
