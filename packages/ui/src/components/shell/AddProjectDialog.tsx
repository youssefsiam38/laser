import { useMemo, useState } from "react";
import { Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitState } from "@/runtime";

import { isAbsolutePath, recentCwds } from "./model.js";
import { useShell } from "./shell-context.js";

/**
 * "Add project": an absolute directory path, or one of the directories Pi has
 * already run in (from the session catalog). Choosing selects the project.
 */
export function AddProjectDialog() {
  const shell = useShell();
  const { actions, setCurrentProject } = usePiorbitStable();
  const sessions = usePiorbitState((s) => s.sessions);
  const [value, setValue] = useState("");
  const recent = useMemo(() => recentCwds(sessions), [sessions]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && isAbsolutePath(trimmed);
  const invalid = trimmed.length > 0 && !valid;

  const close = (open: boolean) => {
    shell.setAddProjectOpen(open);
    if (!open) setValue("");
  };
  /**
   * Adding is server-side now, so it survives a reload and every other client
   * sees it. Select it only once the host has taken it: a rejected path (a
   * typo, an unreadable directory) must not leave the rail pointing at nothing.
   */
  const choose = (cwd: string) => {
    void actions.addProject(cwd).then((project) => project && setCurrentProject(project.cwd));
    close(false);
  };

  return (
    <Dialog open={shell.addProjectOpen} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            piorbit runs one Pi worker per directory. Sessions you start here are saved under it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) choose(trimmed);
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Directory</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="/home/you/projects/app"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={invalid ? true : undefined}
              className={cn(
                "h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-xs text-ink",
                "transition-[border-color] duration-75 outline-none placeholder:text-ink-3",
                "hover:border-[color-mix(in_oklab,var(--line)_60%,var(--ink-3))]",
                "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
                "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25",
              )}
            />
            <span className={cn("text-xs leading-4", invalid ? "text-danger" : "text-ink-3")}>
              {invalid ? "Use an absolute path (starts with / or a drive letter)." : "Absolute path on the host machine."}
            </span>
          </label>

          {recent.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">Recent directories</span>
              <ul role="list" className="-mx-1 max-h-52 overflow-y-auto">
                {recent.map((cwd) => (
                  <li key={cwd}>
                    <button
                      type="button"
                      onClick={() => choose(cwd)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start",
                        "transition-colors duration-75 outline-none hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
                        "focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                      )}
                    >
                      <Folder className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                      <span className="shrink-0 text-sm font-medium text-ink">{shortCwd(cwd)}</span>
                      <span className="min-w-0 flex-1 truncate text-end font-mono text-[11px] text-ink-3">{cwd}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
