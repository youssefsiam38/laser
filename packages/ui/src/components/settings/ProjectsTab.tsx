"use client";
/** Settings → Projects: one Bash pre-command per known project. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderKanban } from "lucide-react";
import type { ProjectEnvStatus, ProjectInfo } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { Empty } from "./SettingsScreen.js";

export function ProjectsTab({ activeCwd }: { activeCwd: string | undefined }) {
  const { client, projectInfo } = useLaserStable();
  const projects = useMemo(
    () => Object.values(projectInfo).sort((a, b) => {
      if (a.cwd === activeCwd) return -1;
      if (b.cwd === activeCwd) return 1;
      return a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd);
    }),
    [activeCwd, projectInfo],
  );
  const projectKey = projects.map(project => project.cwd).join("\0");
  const [statuses, setStatuses] = useState<Record<string, ProjectEnvStatus>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});

  useEffect(() => {
    let current = true;
    void Promise.all(projects.map(async project => {
      try {
        const answer = await client.request("pi/project/env/status", { cwd: project.cwd });
        return { cwd: project.cwd, status: answer.status };
      } catch (error) {
        return { cwd: project.cwd, error: error instanceof Error ? error.message : "This project could not be loaded." };
      }
    })).then(results => {
      if (!current) return;
      const nextStatuses: Record<string, ProjectEnvStatus> = {};
      const nextFailures: Record<string, string> = {};
      for (const result of results) {
        if ("status" in result) nextStatuses[result.cwd] = result.status;
        else nextFailures[result.cwd] = result.error;
      }
      setStatuses(nextStatuses);
      setFailures(nextFailures);
    });
    return () => { current = false; };
    // projectKey is the stable set of project roots; names do not require RPC reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectKey]);

  const save = useCallback(async (cwd: string, command: string) => {
    const trimmed = command.trim();
    const answer = await client.request("pi/project/env/set", {
      cwd,
      config: trimmed
        ? { enabled: true, preface: trimmed, command: "", args: [], required: true }
        : null,
    });
    setStatuses(current => ({ ...current, [cwd]: answer.status }));
    setFailures(current => {
      const next = { ...current };
      delete next[cwd];
      return next;
    });
    return answer.status;
  }, [client]);

  if (projects.length === 0) {
    return <Empty title="No projects yet" body="Open a project and it will appear here." />;
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-6 py-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-ink">Projects</h2>
          <p className="text-xs leading-5 text-ink-3">
            Give any project one optional command to prepare its shell. Each project keeps its own setting.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {projects.map(project => (
            <ProjectSection
              key={project.cwd}
              project={project}
              status={statuses[project.cwd]}
              loadError={failures[project.cwd]}
              defaultOpen={project.cwd === activeCwd}
              onSave={save}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

function ProjectSection({
  project,
  status,
  loadError,
  defaultOpen,
  onSave,
}: {
  project: ProjectInfo;
  status: ProjectEnvStatus | undefined;
  loadError: string | undefined;
  defaultOpen: boolean;
  onSave: (cwd: string, command: string) => Promise<ProjectEnvStatus>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [command, setCommand] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>();

  useEffect(() => {
    if (dirty || !status) return;
    setCommand(status.config?.preface ?? "");
  }, [dirty, status]);

  const configured = Boolean(status?.config?.preface);
  const olderConfig = Boolean(status?.config?.command && !status.config.preface);

  const submit = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const saved = await onSave(project.cwd, command);
      setDirty(false);
      const trimmed = command.trim();
      setNote({ text: !trimmed
        ? "Removed. The next Bash command runs normally."
        : saved.state === "ready"
          ? "Saved. The next Bash command uses it; work already running keeps the shell it started with."
          : saved.state === "untrusted"
            ? "Saved, but it will not run until this project is trusted."
            : saved.state === "needs-approval"
              ? "Saved, but the changed command still needs approval before it can run."
              : saved.state === "failed"
                ? saved.error ?? "Saved, but Bash remains blocked until the project setup is fixed."
                : "Saved. This project is not using the command yet.", error: saved.state === "failed" });
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : "That command could not be saved.", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-xl border border-line bg-surface">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-3 py-3 text-start outline-none transition-colors duration-(--motion-fast) hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-live motion-reduce:transition-none"
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name} project settings`}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
            <FolderKanban aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{project.name}</span>
            <span className="typed block truncate text-ink-3" title={project.cwd}>{shortCwd(project.cwd)}</span>
          </span>
          {status?.state === "failed" ? <Badge variant="danger">Blocked</Badge>
            : status?.state === "untrusted" ? <Badge variant="attention">Not trusted</Badge>
              : status?.state === "needs-approval" ? <Badge variant="attention">Review</Badge>
                : configured ? <Badge variant="ok">Configured</Badge>
                  : olderConfig ? <Badge variant="attention">Review</Badge> : null}
          <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-instant)", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="hairline-t flex flex-col gap-3 px-3 py-4 sm:ps-14">
          <label className="flex flex-col gap-1.5" htmlFor={`project-command-${project.cwd}`}>
            <span className="text-xs font-medium text-ink-2">Command to run before Bash</span>
            <Input
              id={`project-command-${project.cwd}`}
              value={command}
              onChange={event => { setCommand(event.target.value); setDirty(true); setNote(undefined); }}
              placeholder="source .venv/bin/activate"
              spellCheck={false}
              className="font-mono [font-variant-ligatures:none]"
            />
          </label>
          <p className="text-xs leading-5 text-ink-3">
            Runs in the same shell before every Bash command in this project, including child agents, worktrees and background commands. Leave it empty to disable it. If it fails, the requested Bash command does not run.
          </p>
          {olderConfig && (
            <div className="flex flex-col gap-1 text-xs leading-5 text-attention" role="status">
              <p>This project still uses an older saved resolver. Saving here replaces it with this Bash pre-command.</p>
              <p className="text-ink-3">Executable: <code className="font-mono text-ink-2">{status?.config?.command}</code>{status?.resolverArgumentCount ? ` · ${status.resolverArgumentCount} saved ${status.resolverArgumentCount === 1 ? "argument" : "arguments"} hidden` : ""}</p>
            </div>
          )}
          {status?.state === "failed" && <p className="text-xs leading-5 text-danger" role="alert">{status.error ?? "Bash is blocked until this project's saved setup is fixed."}</p>}
          {status?.state === "untrusted" && <p className="text-xs leading-5 text-attention" role="status">Trust this project before its saved setup can run.</p>}
          {status?.state === "needs-approval" && <p className="text-xs leading-5 text-attention" role="status">Review and save the command before it can run.</p>}
          {loadError && <p className="text-xs leading-5 text-danger" role="alert">{loadError}</p>}
          {note && <p className={cn("text-xs leading-5", note.error ? "text-danger" : "text-ink-2")} role={note.error ? "alert" : "status"}>{note.text}</p>}
          <div>
            <Button size="sm" onClick={() => void submit()} disabled={busy}>
              {busy ? "Saving…" : command.trim() ? "Save command" : "Remove command"}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
