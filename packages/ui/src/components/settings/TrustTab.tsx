"use client";
import type { CapabilityDecision } from "@/runtime/environment-capabilities";
/**
 * Settings → Trust (M4-T7, the trust-store half).
 *
 * A project's `.laser/settings.json` can affect the agent when the project is
 * opened. The host decides whether Laser may apply it before starting a worker;
 * this screen is where that product-owned decision is reviewed and changed.
 * Pi trust state and `<project>/.pi` are deliberately ignored.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";

import { CapabilityNotice } from "@/components/capability-gate";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl } from "@/components/ui/tabs";
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

export function TrustTab({ decision }: { decision?: CapabilityDecision | undefined }) {
  const writable = decision?.state === "available" || decision === undefined;
  const readOnlyExplanation = decision?.state === "explained" ? decision.explanation : undefined;
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
            A project can ship its own settings, tools, instructions and automations. Trusting it lets the agent load them
            when it opens that directory; declining runs the agent with your configuration only. You can change your
            mind here at any time — it takes effect the next time the project&rsquo;s worker starts.
          </p>
          {undecided > 0 && (
            <p className="text-xs leading-5 text-attention">
              {undecided} {undecided === 1 ? "project is" : "projects are"} waiting on an answer. Opening one will ask.
            </p>
          )}
        </div>

        {!writable && readOnlyExplanation ? <CapabilityNotice explanation={readOnlyExplanation} /> : null}

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
                writable={writable}
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
  writable,
  onDecide,
}: {
  project: ProjectInfo;
  first: boolean;
  busy: boolean;
  writable: boolean;
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

      {decidable && writable ? (
        /* The shared segmented control (`components/ui/tabs.tsx`): the product's
           one idiom, and the arrow keys and reachable tab stop this pair never
           had while nothing was decided yet. The decision's tone stays on the
           headline above, which already carries it. */
        <SegmentedControl
          label={`Trust for ${project.name}`}
          value={project.trust === "trusted" ? "trust" : project.trust === "declined" ? "decline" : ""}
          options={[
            { value: "trust", label: "Trust" },
            { value: "decline", label: "Decline" },
          ]}
          onChange={(next) => onDecide(project.cwd, next === "trust")}
          disabled={busy}
          className="shrink-0"
        />
      ) : !decidable ? (
        <span className="shrink-0 text-xs text-ink-3">nothing to decide</span>
      ) : null}
    </div>
  );
}
