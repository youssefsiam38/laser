"use client";

import { ChevronsUpDown, FolderGit2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, type SettingsScopeView } from "@/runtime";

import { useWorkbench } from "./workbench-context.js";

const OPTIONS: Array<{ id: SettingsScopeView; label: string; description: string }> = [
  { id: "global", label: "Global", description: "Settings used for every project" },
  { id: "project", label: "Project", description: "Overrides saved in one chosen project" },
  { id: "effective", label: "Effective", description: "Read-only resolved settings for one chosen project" },
];

/** The one visible Settings-scope control, shared by every migrated surface. */
export function SettingsScopeControls() {
  const { projects, projectInfo } = useLaserStable();
  const { settingsScope, requestSettingsScope } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const selected = settingsScope.projectCwd;
  const available = selected !== undefined && projects.includes(selected);
  const selectedName = selected === undefined
    ? "Choose a project"
    : projectInfo[selected]?.name ?? shortCwd(selected);

  const changeView = async (view: SettingsScopeView) => {
    if (view === settingsScope.view || busy) return;
    setBusy(true);
    try {
      await requestSettingsScope(
        view === "global"
          ? { view }
          : { view, ...(selected === undefined ? {} : { projectCwd: selected }) },
      );
    } finally {
      setBusy(false);
    }
  };

  const changeProject = async (projectCwd: string) => {
    if (busy || settingsScope.view === "global") return;
    setBusy(true);
    try {
      await requestSettingsScope({ view: settingsScope.view, projectCwd });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div role="tablist" aria-label="Settings scope" className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
        {OPTIONS.map((option) => (
          <Button
            key={option.id}
            type="button"
            role="tab"
            variant="ghost"
            size="sm"
            aria-selected={settingsScope.view === option.id}
            aria-label={`${option.label}. ${option.description}`}
            disabled={busy}
            onClick={() => void changeView(option.id)}
            className={cn(
              "pointer-coarse:min-h-11",
              settingsScope.view === option.id && "bg-surface text-ink",
            )}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {settingsScope.view !== "global" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              className="min-w-0 max-w-72 gap-1.5 pointer-coarse:min-h-11"
              aria-label={`${settingsScope.view === "project" ? "Project settings target" : "Effective settings project"}: ${selectedName}${selected !== undefined && !available ? ", unavailable" : ""}`}
              title={selected}
            >
              <FolderGit2 className="shrink-0" />
              <span className="min-w-0 truncate">
                {selectedName}{selected !== undefined && !available ? " · unavailable" : ""}
              </span>
              <ChevronsUpDown className="shrink-0 text-ink-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-var(--spacing-6))]">
            <DropdownMenuLabel>
              {settingsScope.view === "project" ? "Project settings to edit" : "Project settings to resolve"}
            </DropdownMenuLabel>
            {selected !== undefined && !available ? (
              <DropdownMenuItem disabled className="items-start">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-ink">Unavailable project</span>
                  <span className="font-mono text-xs leading-4 break-all text-ink-3">{selected}</span>
                </span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuRadioGroup value={available ? selected : ""} onValueChange={(value) => void changeProject(value)}>
              {projects.map((project) => (
                <DropdownMenuRadioItem key={project} value={project} className="items-start">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-ink">{projectInfo[project]?.name ?? shortCwd(project)}</span>
                    <span className="font-mono text-xs leading-4 break-all text-ink-3">{project}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
