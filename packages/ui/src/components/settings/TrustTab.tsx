"use client";
/**
 * Settings → Trust (M4-T7, the trust-store half).
 *
 * A project's `.pi` directory can carry settings, extensions, skills, prompts
 * and system-prompt text that run as soon as the agent opens the directory.
 * The agent gates that behind a decision; the SDK the worker uses does not
 * ask, so the host decides before it starts a worker and this screen is where
 * the decision is made and changed.
 *
 * What is *not* here matters as much. laser reads the agent's own
 * `trust.json` and never writes it (`packages/host/src/trust.ts`): that file
 * has a lock protocol owned by a program that may be running, and taking a
 * second writer to it is the bug in AGENTS.md invariant 8. So a decision made
 * here is laser's, kept in laser's project registry, and the row says so
 * rather than implying it changed the agent's terminal behaviour too.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { ProjectInfo, ProjectTrust } from "@lasercode/protocol";

import { Empty, SearchInput } from "./SettingsScreen.js";

const ORDER: Record<ProjectTrust, number> = { unknown: 0, declined: 1, trusted: 2, not_required: 3 };

const ICON = {
  trusted: ShieldCheck,
  declined: ShieldX,
  unknown: ShieldQuestion,
  not_required: ShieldAlert,
} as const;

function toneOf(trust: ProjectTrust): string {
  if (trust === "trusted") return "text-ok";
  if (trust === "declined") return "text-danger";
  if (trust === "unknown") return "text-attention";
  return "text-ink-3";
}

function headline(trust: ProjectTrust): string {
  switch (trust) {
    case "trusted":
      return "Loads this project's own configuration";
    case "declined":
      return "Runs without this project's configuration";
    case "unknown":
      return "Not decided yet";
    default:
      return "Nothing here needs a decision";
  }
}

export function TrustTab() {
  const { projectInfo, actions } = useLaserStable();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();

  const projects = useMemo(() => {
    const all = Object.values(projectInfo);
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? all.filter((p) => p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle))
      : all;
    return [...matched].sort((a, b) => ORDER[a.trust] - ORDER[b.trust] || a.name.localeCompare(b.name));
  }, [projectInfo, query]);

  const decide = useCallback(
    async (cwd: string, trusted: boolean) => {
      setBusy(cwd);
      try {
        // The registry is the writer, and it remembers: an answer given here is
        // a standing decision, not an answer to one prompt.
        await actions.answerTrust(cwd, trusted, true);
      } finally {
        setBusy(undefined);
      }
    },
    [actions],
  );

  const undecided = projects.filter((p) => p.trust === "unknown").length;

  if (Object.keys(projectInfo).length === 0) {
    return (
      <Empty
        title="No projects yet"
        body="Trust is decided per project directory. Add one from the rail and it will appear here with what it wants to load."
      />
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-6 py-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs leading-5 text-ink-3">
            A project can ship its own settings, extensions, skills and prompts. Trusting it lets the agent load them
            when it opens that directory; declining runs the agent with your configuration only. You can change your
            mind here at any time — it takes effect the next time the project&rsquo;s worker starts.
          </p>
          {undecided > 0 && (
            <p className="text-xs leading-5 text-attention">
              {undecided} {undecided === 1 ? "project is" : "projects are"} waiting on an answer. Opening one will ask.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Filter projects" className="max-w-72 flex-1" />
          <TooltipIconButton tooltip="Reload projects" onClick={() => void actions.refreshProjects()}>
            <RefreshCw />
          </TooltipIconButton>
        </div>

        {projects.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-2">No project matches “{query}”.</p>
        ) : (
          <div className="flex flex-col rounded-lg border border-line">
            {projects.map((project, index) => (
              <Row
                key={project.cwd}
                project={project}
                first={index === 0}
                busy={busy === project.cwd}
                onDecide={decide}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function Row({
  project,
  first,
  busy,
  onDecide,
}: {
  project: ProjectInfo;
  first: boolean;
  busy: boolean;
  onDecide: (cwd: string, trusted: boolean) => void;
}) {
  const Icon = ICON[project.trust];
  const decidable = project.trust !== "not_required";
  const reasons = project.trustReasons ?? [];

  return (
    <div className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3", !first && "hairline-t")}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toneOf(project.trust))} />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-ink">{project.name}</span>
          {project.trust === "unknown" && <Badge variant="attention">undecided</Badge>}
        </div>
        <p className="typed mt-0.5 truncate text-ink-3" title={project.cwd}>
          {shortCwd(project.cwd)}
        </p>
        <p className={cn("mt-1 text-xs leading-4", toneOf(project.trust))}>{headline(project.trust)}</p>
        {reasons.length > 0 && (
          <p className="mt-1 text-xs leading-4 text-ink-3">
            Found here:{" "}
            <span className="typed text-ink-2">{reasons.join(" · ")}</span>
          </p>
        )}
      </div>

      {decidable ? (
        <div
          role="radiogroup"
          aria-label={`Trust for ${project.name}`}
          className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
        >
          {(
            [
              { value: true, label: "Trust" },
              { value: false, label: "Decline" },
            ] as const
          ).map((option) => {
            const checked = option.value ? project.trust === "trusted" : project.trust === "declined";
            return (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                disabled={busy}
                onClick={() => onDecide(project.cwd, option.value)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-xs font-medium outline-none",
                  "transition-[background-color,color] duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                  "disabled:opacity-45",
                  checked
                    ? option.value
                      ? "bg-surface text-ok shadow-float-sm"
                      : "bg-surface text-danger shadow-float-sm"
                    : "text-ink-2 hover:text-ink",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <span className="shrink-0 text-xs text-ink-3">nothing to decide</span>
      )}
    </div>
  );
}
