import { Activity, Bot, FileClock, FolderPlus, GitBranch, GitFork, Moon, PanelLeft, Plus, Settings, Shrink, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommandPalette as CommandPaletteElement, matchesCommand, type PaletteCommand } from "@/components/assistant-ui/elements/command-palette";
import { StatusDot } from "@/components/status";
import { LAST_PROMPT_MESSAGES, lastPromptEntry, lastPromptMessage } from "@/components/thread/last-prompt";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useWorkbench } from "@/components/workbench";
import { relativeTime, shortCwd, shortcutLabel } from "@/format";
import { useTheme } from "@/hooks";
import { useCapability, useLaserStable, useLaserState, useSessionMeta } from "@/runtime";
import { currentView, samePresentationView } from "@/runtime/presentation-state";

import type { AppState } from "@/store";

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
  const commands = usePaletteCommands(open);
  const { actions } = useLaserStable();
  useEffect(() => open ? actions.expandCatalog?.() : undefined, [actions, open]);

  // A fresh open starts at the top of the list with an empty box.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveId("");
  }, [open]);

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

const NO_VIEW = () => undefined;
const EMPTY_SESSIONS: never[] = [];
const EMPTY_OPEN = {};
const NO_SESSIONS = () => EMPTY_SESSIONS;
const NO_OPEN = () => EMPTY_OPEN;
const allSessions = (state: AppState) => state.sessions;
const allOpen = (state: AppState) => state.open;

/**
 * `active` is the dialog's own `open`. Closed, the palette is not on screen and
 * Radix has unmounted its content, so it reads nothing that moves: the session
 * map alone changes identity with every streamed token, and building this list
 * behind a closed dialog re-rendered the palette for each batch (M16-T32).
 */
function usePaletteCommands(active: boolean): RunnableCommand[] {
  const { actions, client, currentProject, projects } = useLaserStable();
  const view = useLaserState(active ? currentView : NO_VIEW, samePresentationView);
  const meta = useSessionMeta();
  const shell = useShell();
  const workbench = useWorkbench();
  const { theme, toggle } = useTheme();
  // Not a selector closing over `projects`: `useLaserState` caches by store
  // state, and `projects` is React state (see SessionsPanel).
  const sessions = useLaserState(active ? allSessions : NO_SESSIONS);
  const open = useLaserState(active ? allOpen : NO_OPEN);
  const workers = useLaserState((s) => s.workers);
  const groups = useMemo(() => sessionGroups(projects, sessions, open, workers), [projects, sessions, open, workers]);
  const busy = meta.running || meta.compacting;
  const logs = useCapability("pi/logs/query");
  const addProject = useCapability("pi/project/add");
  const createSession = useCapability("session/new");
  const compactSession = useCapability("pi/session/compact");
  const forkSession = useCapability("pi/session/fork");

  return useMemo<RunnableCommand[]>(() => {
    const session: RunnableCommand[] = view
      ? [
          ...(compactSession.state === "available" ? [{ id: "compact", group: "This session", label: "Compact context", detail: busy ? "Waits for the turn to finish" : undefined, icon: Shrink, disabled: busy, run: () => void actions.compact() } satisfies RunnableCommand] : []),
          ...(forkSession.state === "available" ? [{ id: "fork", group: "This session", label: "Fork from last prompt", icon: GitFork, disabled: meta.running, run: () => void forkFromLastPrompt(view.path, client, actions) } satisfies RunnableCommand] : []),
          { id: "history", group: "This session", label: "Open history", keys: ["]"], icon: GitBranch, run: () => shell.openHistory() },
        ]
      : [];
    const app: RunnableCommand[] = [
      ...(createSession.state === "available" ? [{ id: "new", group: "App", label: currentProject ? `New session in ${shortCwd(currentProject)}` : "New session", keys: [shortcutLabel("N")], icon: Plus, disabled: !shell.canCreate, run: () => void shell.newSession() } satisfies RunnableCommand] : []),
      ...(addProject.state === "available" ? [{ id: "add-project", group: "App", label: "Add a project", icon: FolderPlus, run: () => shell.setAddProjectOpen(true) } satisfies RunnableCommand] : []),
      { id: "sessions", group: "App", label: shell.sessionsOpen ? "Hide sessions" : "Show sessions", keys: ["["], icon: PanelLeft, run: () => shell.toggleSessions() },
      { id: "telemetry", group: "App", label: shell.telemetryOpen ? "Hide telemetry" : "Show telemetry", keys: ["]"], icon: Activity, run: () => shell.toggleTelemetry() },
      { id: "settings", group: "App", label: "Settings", icon: Settings, run: () => workbench.open("settings") },
      // Agents page (M13-T5).
      { id: "agents", group: "App", label: "Agents", icon: Bot, run: () => workbench.open("agents") },
      ...(logs.state === "available" ? [{ id: "logs", group: "App", label: "Logs", icon: FileClock, run: () => workbench.open("logs") } satisfies RunnableCommand] : []),
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
  }, [actions, addProject.state, busy, client, compactSession.state, createSession.state, currentProject, forkSession.state, groups, logs.state, meta.running, shell, theme, toggle, view, workbench]);
}

/**
 * The entries and the leaf come from the host at the moment of the command,
 * not from the view the palette rendered with: that view compares by
 * `samePresentationView`, which deliberately ignores entries and leaf so the
 * palette does not re-render per streamed token (M16-T32) — reading them
 * from it here would fork one batch behind.
 */
async function forkFromLastPrompt(path: string, client: ReturnType<typeof useLaserStable>["client"], actions: ReturnType<typeof useLaserStable>["actions"]): Promise<void> {
  try {
    const found = await lastPromptEntry(params => client.request("pi/session/entries", params), path);
    if (found.entryId) {
      await actions.fork(found.entryId);
      return;
    }
    actions.toast("warning", lastPromptMessage(found) ?? LAST_PROMPT_MESSAGES["no-prompt"]);
  } catch (error) {
    actions.toast("error", errorText(error));
  }
}
