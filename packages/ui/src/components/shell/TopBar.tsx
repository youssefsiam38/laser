import { useMemo, useState } from "react";
import {
  ChevronLeft,
  Copy,
  Ellipsis,
  GitBranch,
  GitFork,
  Layers,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Pencil,
  RotateCw,
  Shrink,
  SquarePen,
} from "lucide-react";

import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { StatusDot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { shortCwd } from "@/format";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useDock, useIslandEntries, usePanelActions } from "@/panels";
import {
  sessionTitle,
  setActivityDetailLevel,
  useActivityDetailLevel,
  useLaserStable,
  useLaserState,
  useLaserView,
  useSessionMeta,
  type ActivityDetailLevel,
} from "@/runtime";

import { InlineRename } from "./InlineRename.js";
import { lastPromptEntryId, sessionStateLabel, sessionStatus, workerChip } from "./model.js";
import { errorText, useShell } from "./shell-context.js";

/**
 * Sticky row above the thread: what session this is, what state it is in,
 * and the two panel toggles. Everything that changes the session lives in the
 * more menu; the composer owns model and thinking.
 */
/** The transcript's first user line, for a session the catalog has not scanned yet. */
const firstUserLine = (view: { blocks: readonly { kind: string; text?: string }[] }): string | undefined => {
  for (const block of view.blocks) if (block.kind === "user" && block.text?.trim()) return block.text.replace(/\s+/g, " ").trim().slice(0, 60);
  return undefined;
};

export function TopBar() {
  const { actions, client, currentProject } = useLaserStable();
  const view = useLaserView();
  const sessions = useLaserState((s) => s.sessions);
  const meta = useSessionMeta();
  const shell = useShell();
  const { copy } = useCopy();
  const [renaming, setRenaming] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const activityLevel = useActivityDetailLevel(view?.path);

  const summary = useMemo(() => (view ? sessions.find((s) => s.path === view.path) : undefined), [sessions, view]);
  const status = sessionStatus(view, summary);
  const stateLabel = sessionStateLabel(view, meta.worker);
  const chip = workerChip(meta.worker);
  // One rule for what a session is called, everywhere (runtime/threadList.ts).
  const title = view ? (summary ? sessionTitle(summary, view) : (view.state.name ?? view.title ?? firstUserLine(view) ?? "New session")) : "New session";
  const untitled = view ? title === "New session" : false;
  // Islands live in the dock; the toggle appears only when there is something to toggle.
  const islands = useIslandEntries(view?.path, "desktop");
  const dock = useDock(view?.path);
  const panelActions = usePanelActions();
  const dockable = shell.layout !== "mobile" && islands.some((e) => !dock.dismissed.includes(e.key));
  const busy = meta.running || meta.compacting;

  const copyPath = async () => {
    if (!view) return;
    const ok = await copy(view.path);
    actions.toast(ok ? "info" : "error", ok ? "Session path copied" : "Could not copy the path");
  };

  const forkFromLastPrompt = async () => {
    if (!view) return;
    try {
      const { entries } = await client.request("pi/session/entries", { path: view.path });
      const entryId = lastPromptEntryId(entries);
      if (!entryId) {
        actions.toast("warning", "Nothing to fork yet: this session has no prompt.");
        return;
      }
      await actions.fork(entryId);
    } catch (error) {
      actions.toast("error", errorText(error));
    }
  };

  return (
    <header
      className={cn(
        "flex h-[calc(var(--spacing)*12+env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-bg px-2 pt-[env(safe-area-inset-top)] hairline-b",
      )}
    >
      {shell.layout === "mobile" ? (
        <TooltipIconButton tooltip="Sessions" size="icon" onClick={() => shell.setSessionsOpen(true)}>
          <ChevronLeft />
        </TooltipIconButton>
      ) : (
        <TooltipIconButton
          tooltip={shell.sessionsOpen ? "Hide sessions" : "Show sessions"}
          shortcut="["
          aria-pressed={shell.sessionsOpen}
          onClick={shell.toggleSessions}
        >
          {shell.sessionsOpen ? <PanelLeftClose /> : <PanelLeft />}
        </TooltipIconButton>
      )}

      <div className="group flex min-w-0 flex-1 items-center gap-2 ps-1">
        {view ? (
          <StatusDot status={status} size="md" label={stateLabel} />
        ) : (
          currentProject && <span className="eyebrow hidden sm:inline">{shortCwd(currentProject)}</span>
        )}

        {renaming && view ? (
          <InlineRename
            initial={view.state.name ?? ""}
            className="max-w-sm"
            onCommit={(name) => {
              setRenaming(false);
              void actions.rename(name);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h1
            className={cn(
              "min-w-0 truncate leading-5 select-none",
              untitled ? "text-sm text-ink-2 italic" : "text-sm font-semibold text-ink",
            )}
            title={view ? `${view.path}\nDouble-click to rename` : undefined}
            onDoubleClick={() => view && setRenaming(true)}
          >
            {title}
          </h1>
        )}

        {view && !renaming && (
          <TooltipIconButton
            tooltip="Rename session"
            size="icon-xs"
            className="text-ink-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
            onClick={() => setRenaming(true)}
          >
            <Pencil />
          </TooltipIconButton>
        )}

        {/* The session's state in words lives in the status line above the
            composer (D-20 §5), where a phone and a desktop both find it in the
            same place. Here it is only the dot's accessible name. */}

        {chip && meta.session && (
          <span className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant={chip.tone === "muted" ? "outline" : chip.tone} tabIndex={0}>
                  {chip.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-80 items-start">
                {chip.detail ?? chip.label}
                <span className="text-xs opacity-70">
                  One agent process runs each project directory. Its sessions are safe on disk either way.
                </span>
              </TooltipContent>
            </Tooltip>
            {chip.canRetry && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void actions.restartWorker(meta.session!.cwd)}
                title={`Start the worker for ${meta.session.cwd} again`}
              >
                <RotateCw />
                Retry
              </Button>
            )}
          </span>
        )}

      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {meta.model && (
          <span
            className="me-1.5 hidden max-w-40 truncate font-mono text-xs text-ink-3 xl:inline"
            title={`${meta.model.provider}/${meta.model.id}`}
          >
            {meta.model.id}
          </span>
        )}

        {/* The context ring (docs/ux-elements.md "Context display"); the
            composer carries the same element next to Send. */}
        <ContextRingButton side="bottom" className="me-1" />

        {dockable && (
          <TooltipIconButton
            tooltip={dock.hidden ? `Show panels (${islands.length})` : "Hide panels"}
            aria-pressed={!dock.hidden}
            onClick={() => panelActions.setHidden(!dock.hidden)}
          >
            <Layers />
          </TooltipIconButton>
        )}

        <TooltipIconButton
          tooltip={shell.telemetryOpen ? "Hide telemetry" : "Show telemetry"}
          shortcut="]"
          aria-pressed={shell.telemetryOpen}
          onClick={shell.toggleTelemetry}
        >
          {shell.telemetryOpen ? <PanelRightClose /> : <PanelRight />}
        </TooltipIconButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip="More">
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-60">
            <DropdownMenuItem disabled={!view || busy} onSelect={() => void actions.compact()}>
              <Shrink />
              Compact context
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view || busy} onSelect={() => setCompactOpen(true)}>
              <SquarePen />
              Compact with instructions…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Activity detail</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activityLevel}
              onValueChange={(level) => view && setActivityDetailLevel(view.path, level as ActivityDetailLevel)}
            >
              <DropdownMenuRadioItem value="answers" disabled={!view} className="items-start">
                <span>
                  <span className="block">Answers only</span>
                  <span className="mt-0.5 block text-xs leading-4 text-ink-3">Reasoning and actions folded</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="reasoning" disabled={!view} className="items-start">
                <span>
                  <span className="block">Show reasoning</span>
                  <span className="mt-0.5 block text-xs leading-4 text-ink-3">Reasoning open, action bodies folded</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="everything" disabled={!view} className="items-start">
                <span>
                  <span className="block">Show everything</span>
                  <span className="mt-0.5 block text-xs leading-4 text-ink-3">Reasoning and action details open</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!view || meta.running} onSelect={() => void forkFromLastPrompt()}>
              <GitFork />
              Fork from last prompt
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view} onSelect={() => void copyPath()}>
              <Copy />
              Copy session path
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view} onSelect={shell.openHistory}>
              <GitBranch />
              Open history
              <DropdownMenuShortcut>]</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CompactDialog open={compactOpen} onOpenChange={setCompactOpen} />
    </header>
  );
}

function CompactDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { actions } = useLaserStable();
  const [instructions, setInstructions] = useState("");
  const submit = () => {
    const text = instructions.trim();
    void actions.compact(text ? text : undefined);
    onOpenChange(false);
    setInstructions("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Compact context</DialogTitle>
          <DialogDescription>
            The agent summarises the conversation so far and keeps working from the summary. Tell it what must survive.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Instructions · optional</span>
            <Textarea
              autoFocus
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Keep the list of files we changed and the failing test names."
              className="max-h-40 min-h-20 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              <Shrink />
              Compact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
