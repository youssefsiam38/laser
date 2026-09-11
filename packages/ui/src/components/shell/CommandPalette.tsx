import { Activity, Bot, FileClock, FolderPlus, GitBranch, GitFork, Moon, PanelLeft, Plus, Settings, Shrink, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommandPalette as CommandPaletteElement, matchesCommand, type PaletteCommand } from "@/components/assistant-ui/elements/command-palette";
import { StatusDot } from "@/components/status";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useWorkbench } from "@/components/workbench";
import { relativeTime, shortCwd, shortcutLabel } from "@/format";
import { useTheme } from "@/hooks";
import { useLaserStable, useLaserState, useLaserView, useSessionMeta } from "@/runtime";

import { errorText, useShell } from "./shell-context.js";
import { sessionGroups, sessionsList } from "./session-groups.js";

/**
 * `Cmd+K` (DESIGN.md "Accessibility"): everything the app can do, one
 * keystroke away, grouped by where it acts — this session, the panels, the
 * app — plus every session and project by name. The `command-palette` element
 * draws it; this file decides what is in it.
 */
export function CommandPaletteDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState("");
  const commands = usePaletteCommands();

  // A fresh open starts at the top of the list with an empty box.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveId(commands[0]?.id ?? "");
  }, [open, commands]);

  // The highlight follows the filter: the first match is active by default.
  useEffect(() => {
    if (commands.some((c) => c.id === activeId && matchesCommand(c, query))) return;
    setActiveId(commands.find((c) => matchesCommand(c, query))?.id ?? "");
  }, [query, commands, activeId]);

  const run = useCallback(
    (id: string) => {
      const command = commands.find((c) => c.id === id);
      if (!command || command.disabled) return;
      onOpenChange(false);
      command.run();
    },
    [commands, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[15vh] translate-y-0 gap-0 p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Type to filter commands, sessions and projects. Enter runs the highlighted one.</DialogDescription>
        <CommandPaletteElement commands={commands} query={query} activeId={activeId} onQueryChange={setQuery} onActiveChange={setActiveId} onRun={run} />
      </DialogContent>
    </Dialog>
  );
}

type RunnableCommand = PaletteCommand & { run(): void };

function usePaletteCommands(): RunnableCommand[] {
  const { actions, currentProject, projects } = useLaserStable();
  const view = useLaserView();
  const meta = useSessionMeta();
  const shell = useShell();
  const workbench = useWorkbench();
  const { theme, toggle } = useTheme();
  // Not a selector closing over `projects`: `useLaserState` caches by store
  // state, and `projects` is React state (see SessionsPanel).
  const sessions = useLaserState((s) => s.sessions);
  const open = useLaserState((s) => s.open);
  const workers = useLaserState((s) => s.workers);
  const groups = useMemo(() => sessionGroups(projects, sessions, open, workers), [projects, sessions, open, workers]);
  const busy = meta.running || meta.compacting;

  return useMemo<RunnableCommand[]>(() => {
    const session: RunnableCommand[] = view
      ? [
          { id: "compact", group: "This session", label: "Compact context", detail: busy ? "Waits for the turn to finish" : undefined, icon: Shrink, disabled: busy, run: () => void actions.compact() },
          { id: "fork", group: "This session", label: "Fork from last prompt", icon: GitFork, disabled: meta.running, run: () => void forkFromLastPrompt(view.entries, actions) },
          { id: "history", group: "This session", label: "Open history", keys: ["]"], icon: GitBranch, run: () => shell.openHistory() },
        ]
      : [];
    const app: RunnableCommand[] = [
      { id: "new", group: "App", label: currentProject ? `New session in ${shortCwd(currentProject)}` : "New session", keys: [shortcutLabel("N")], icon: Plus, disabled: !shell.canCreate, run: () => void shell.newSession() },
      { id: "add-project", group: "App", label: "Add a project", icon: FolderPlus, run: () => shell.setAddProjectOpen(true) },
      { id: "sessions", group: "App", label: shell.sessionsOpen ? "Hide sessions" : "Show sessions", keys: ["["], icon: PanelLeft, run: () => shell.toggleSessions() },
      { id: "telemetry", group: "App", label: shell.telemetryOpen ? "Hide telemetry" : "Show telemetry", keys: ["]"], icon: Activity, run: () => shell.toggleTelemetry() },
      { id: "settings", group: "App", label: "Settings", icon: Settings, run: () => workbench.open("settings") },
      // Agents page (M13-T5).
      { id: "agents", group: "App", label: "Agents", icon: Bot, run: () => workbench.open("agents") },
      { id: "logs", group: "App", label: "Logs", icon: FileClock, run: () => workbench.open("logs") },
      { id: "theme", group: "App", label: theme === "dark" ? "Light theme" : "Dark theme", icon: theme === "dark" ? Sun : Moon, run: () => toggle() },
    ];
    const projectRows: RunnableCommand[] = groups.map((g) => ({
      id: `project:${g.cwd}`,
      group: "Projects",
      label: g.name,
      detail: `${g.rows.length} session${g.rows.length === 1 ? "" : "s"}${g.needYou ? ` · ${g.needYou} need${g.needYou === 1 ? "s" : ""} you` : ""}`,
      run: () => {
        sessionsList.filter(g.cwd);
        void actions.goProject(g.cwd);
        shell.setSessionsOpen(true);
      },
    }));
    const sessionRows: RunnableCommand[] = groups.flatMap((g) =>
      g.rows.map((row) => ({
        id: `session:${row.path}`,
        group: "Sessions",
        label: row.title,
        detail: `${g.name} · ${relativeTime(row.summary.modifiedAt)}${row.sub.tone === "attention" ? " · waiting for you" : ""}`,
        icon: (({ className }: { className?: string }) => <StatusDot status={row.status} size="sm" className={className} />) as unknown as PaletteCommand["icon"],
        run: () => {
          void actions.openSession(row.path).catch((error: unknown) => actions.toast("error", errorText(error)));
        },
      })),
    );
    return [...session, ...app, ...sessionRows, ...projectRows];
  }, [actions, busy, currentProject, groups, meta.running, shell, theme, toggle, view, workbench]);
}

async function forkFromLastPrompt(entries: readonly unknown[], actions: ReturnType<typeof useLaserStable>["actions"]): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; id?: string; message?: { role?: string } };
    if (e.type === "message" && e.message?.role === "user" && e.id) {
      await actions.fork(e.id);
      return;
    }
  }
  actions.toast("warning", "Nothing to fork yet: this session has no prompt.");
}
