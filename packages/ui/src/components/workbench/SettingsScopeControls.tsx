"use client";

import { ChevronsUpDown, FolderGit2 } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useState, useSyncExternalStore } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortCwd } from "@/format";
import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";
import { deviceStore } from "@/runtime/device-storage";
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
  const logicalKey = useLogicalArrowKeys();
  const { settingsScope, requestSettingsScope } = useWorkbench();
  const deviceStatus = useSyncExternalStore(deviceStore.subscribe, deviceStore.status, deviceStore.status);
  const [busy, setBusy] = useState(false);
  const selected = settingsScope.projectCwd;
  const available = selected !== undefined && projects.includes(selected);
  const selectedName = selected === undefined
    ? "Choose a project"
    : projectInfo[selected]?.name ?? shortCwd(selected);

  const changeView = async (view: SettingsScopeView) => {
    if (view === settingsScope.view || busy || !deviceStatus.active) return;
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
    if (busy || !deviceStatus.active || settingsScope.view === "global") return;
    setBusy(true);
    try {
      await requestSettingsScope({ view: settingsScope.view, projectCwd });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <RadioGroup.Root
        value={settingsScope.view}
        onValueChange={(value) => void changeView(value as SettingsScopeView)}
        disabled={!deviceStatus.active}
        orientation="horizontal"
        loop
        aria-label="Settings scope"
        aria-busy={busy || undefined}
        onKeyDownCapture={(event) => {
          const key = logicalKey(event.key);
          if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
          const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-scope-view]")];
          const current = radios.indexOf(event.target as HTMLButtonElement);
          if (current < 0) return;
          const next = key === "Home"
            ? 0
            : key === "End"
              ? radios.length - 1
              : key === "ArrowRight" || key === "ArrowDown"
                ? (current + 1) % radios.length
                : (current - 1 + radios.length) % radios.length;
          const radio = radios[next];
          const option = OPTIONS[next];
          if (!radio || !option) return;
          event.preventDefault();
          event.stopPropagation();
          radio.focus();
          void changeView(option.id);
        }}
        className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {OPTIONS.map((option) => (
          <Tooltip key={option.id}>
            <TooltipTrigger asChild>
              <RadioGroup.Item
                value={option.id}
                data-scope-view={option.id}
                aria-label={`${option.label}. ${option.description}`}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "pointer-coarse:min-h-11 data-[state=checked]:bg-surface data-[state=checked]:text-ink",
                )}
              >
                {option.label}
              </RadioGroup.Item>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="pointer-events-none">{option.description}</TooltipContent>
          </Tooltip>
        ))}
      </RadioGroup.Root>

      {settingsScope.view !== "global" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!deviceStatus.active}
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

      {!deviceStatus.active ? (
        <p className="basis-full text-xs leading-5 text-attention" role="status">
          Settings scope is unavailable while this environment reconnects.
        </p>
      ) : null}
    </div>
  );
}
