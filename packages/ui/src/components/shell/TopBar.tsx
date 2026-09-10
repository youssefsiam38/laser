import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Ellipsis,
  FolderInput,
  GitBranch,
  GitFork,
  Radio,
  PanelLeft,
  PanelLeftClose,
  RotateCw,
  Shrink,
  Search,
  SquarePen,
  Waypoints,
} from "lucide-react";

// Agent map (M13-T7): the toggle that swaps the main column between the thread and the live map.
import { mapUi, useMapUi } from "@/components/agents/map";
import { useSessionAgent } from "@/agents/hooks";
import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
// Beam: the quiet mark on one of its sessions (view styling, not an entry point).
import { BeamSessionMark } from "@/components/beam/BeamSessionMark";
import { StatusDot } from "@/components/status";
import { preserveReadingPosition } from "@/components/thread/preserve-reading-position";
import { openConversationFind } from "@/components/thread/search-state";
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
import { useFleet, type FleetView } from "@/fleet";
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
import { requestMoveSession } from "./move-session.js";
import { SessionIdentity } from "./SessionIdentity.js";

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

function useRoomyTopBar(): { roomy: boolean; markerRef: RefObject<HTMLSpanElement | null> } {
  const markerRef = useRef<HTMLSpanElement>(null);
  const [roomy, setRoomy] = useState(false);
  useLayoutEffect(() => {
    const marker = markerRef.current;
    if (!marker || typeof ResizeObserver === "undefined") return;
    const update = () => setRoomy(getComputedStyle(marker).display !== "none");
    const observer = new ResizeObserver(update);
    observer.observe(marker.parentElement ?? marker);
    update();
    return () => observer.disconnect();
  }, []);
  return { roomy, markerRef };
}

export function TopBar() {
  const { actions, client, currentProject } = useLaserStable();
  const view = useLaserView();
  const sessions = useLaserState((s) => s.sessions);
  const meta = useSessionMeta();
  const shell = useShell();
  const { copy } = useCopy();
  const [renaming, setRenaming] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  // A CSS container sentinel makes responsive controls follow the thread
  // column, not the viewport (a wide screen can still have a narrow thread).
  const { roomy, markerRef } = useRoomyTopBar();
  const activityLevel = useActivityDetailLevel(view?.path);
  // Agent map (M13-T7): shown in place of the thread while `open`.
  const mapOpen = useMapUi().open;
  const sessionAgent = useSessionAgent(view?.path);

  const summary = useMemo(() => (view ? sessions.find((s) => s.path === view.path) : undefined), [sessions, view]);
  // Only the attribution persisted with this session is identity. In
  // particular, do not fill an older unattributed session from today's
  // default agent (which `useSessionAgent` intentionally does for grouping).
  const persistedAgent = view?.state.agent ?? summary?.agent;
  const parentPath = persistedAgent?.kind === "child" ? persistedAgent.parentPath : undefined;
  const parentTitle = useLaserState((s) => {
    if (parentPath === undefined) return undefined;
    const parentSummary = s.sessions.find((session) => session.path === parentPath);
    const parentView = s.open[parentPath];
    if (parentSummary) return sessionTitle(parentSummary, parentView);
    return parentView?.state.name ?? parentView?.title ?? "Parent session";
  });
  const status = sessionStatus(view, summary);
  const stateLabel = sessionStateLabel(view, meta.worker);
  const chip = workerChip(meta.worker);
  // One rule for what a session is called, everywhere (runtime/threadList.ts).
  const title = view ? (summary ? sessionTitle(summary, view) : (view.state.name ?? view.title ?? firstUserLine(view) ?? "New session")) : "New session";
  const untitled = view ? title === "New session" : false;
  // The fleet's own count — the open session's tree (M13-T51), plus work
  // whose session was deleted, which the fleet carries because nothing else can.
  const fleet = useFleet();
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
        "@container/topbar relative flex h-[calc(var(--spacing)*12+env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-bg px-2 pt-[env(safe-area-inset-top)] hairline-b",
      )}
    >
      <span ref={markerRef} data-slot="topbar-room-marker" aria-hidden="true" className="absolute hidden @3xl/topbar:block" />
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
        <BeamSessionMark path={view?.path} />

        {/* Agents leap (Lane U2): a child session an agent started shows where
            it came from — its parent's title, one press away — before its own. */}
        {view && !renaming && roomy && parentPath && parentTitle ? <ParentCrumb path={parentPath} title={parentTitle} /> : null}

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
        <SessionIdentity agentName={persistedAgent?.agentName} model={meta.model} />

        {/* The context ring (docs/ux-elements.md "Context display"); the
            composer carries the same element next to Send. */}
        <ContextRingButton side="bottom" className="me-1 hidden @3xl/topbar:inline-flex" />

        {/* The fleet, immediately left of the monitor, with the same grammar
            as its toggle: a count of what needs a person wins over a count of
            what is merely going. */}
        {roomy ? (
          <>
            <TooltipIconButton
              tooltip={shell.fleetOpen ? "Hide the fleet" : fleetTooltip(fleet)}
              shortcut="\\"
              aria-pressed={shell.fleetOpen}
              data-slot="fleet-toggle"
              onClick={shell.toggleFleet}
              className="relative"
            >
              <Radio />
              {!shell.fleetOpen && (fleet.needsYou > 0 || fleet.running > 0 || fleet.elsewhereNeedsYou > 0 || fleet.elsewhereRunning > 0) && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute end-1 top-1 size-1.5 rounded-full border border-bg",
                    fleet.needsYou > 0 || fleet.elsewhereNeedsYou > 0 ? "bg-attention motion-safe:animate-attention" : "bg-live",
                  )}
                />
              )}
            </TooltipIconButton>
            <TooltipIconButton
              tooltip={shell.telemetryOpen ? "Hide telemetry" : "Show telemetry"}
              shortcut="]"
              aria-pressed={shell.telemetryOpen}
              onClick={shell.toggleTelemetry}
            >
              <Activity />
            </TooltipIconButton>
          </>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip="More" className="pointer-coarse:size-11">
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-60">
            {!roomy && parentPath && parentTitle ? (
              <DropdownMenuItem onSelect={() => void actions.openSession(parentPath)} className="pointer-coarse:min-h-11">
                <CornerUpLeft />
                <span className="min-w-0 truncate">Open parent: {parentTitle}</span>
              </DropdownMenuItem>
            ) : null}
            {!roomy ? (
              <>
                <DropdownMenuItem onSelect={shell.toggleFleet} className="pointer-coarse:min-h-11">
                  <Radio />
                  {shell.fleetOpen ? "Hide the fleet" : fleetTooltip(fleet)}
                  <DropdownMenuShortcut>\\</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={shell.toggleTelemetry} className="pointer-coarse:min-h-11">
                  <Activity />
                  {shell.telemetryOpen ? "Hide telemetry" : "Show telemetry"}
                  <DropdownMenuShortcut>]</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem disabled={!view || renaming} onSelect={() => setRenaming(true)} className="pointer-coarse:min-h-11">
              <SquarePen />
              Rename session
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view} onSelect={() => openConversationFind()} className="pointer-coarse:min-h-11">
              <Search />
              Find in conversation
              <DropdownMenuShortcut>Ctrl+F</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!view} onSelect={() => mapUi.toggleOpen()} className="pointer-coarse:min-h-11" data-slot="agent-map-toggle">
              <Waypoints />
              {mapOpen ? "Show conversation" : "Show agent map"}
            </DropdownMenuItem>
            {view && sessionAgent?.kind === "chat" ? (
              <DropdownMenuItem onSelect={() => requestMoveSession({ path: view.path, title })} className="pointer-coarse:min-h-11">
                <FolderInput />
                Move chat to a project
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
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
              onValueChange={(level) => {
                if (!view || level === activityLevel) return;
                const viewport = document.querySelector<HTMLElement>('[data-slot="thread-viewport"]');
                if (viewport) preserveReadingPosition(viewport);
                setActivityDetailLevel(view.path, level as ActivityDetailLevel);
              }}
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

/** "{parent title} ›" before a child session's title when the container has room. */
function ParentCrumb({ path, title }: { path: string; title: string }) {
  const { actions } = useLaserStable();
  return (
    <span data-slot="parent-crumb" className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => void actions.openSession(path)}
        aria-label={`Open parent session: ${title}`}
        title={`Open ${title}\n${path}`}
        className={cn(
          "flex size-6 items-center justify-center rounded text-sm leading-5 text-ink-2 outline-none @3xl/topbar:size-auto @3xl/topbar:max-w-40 @3xl/topbar:px-1",
          "transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live motion-reduce:transition-none pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        )}
      >
        <CornerUpLeft aria-hidden="true" className="size-3.5 @3xl/topbar:hidden" />
        <span className="hidden min-w-0 truncate @3xl/topbar:inline">{title}</span>
      </button>
      <ChevronRight className="hidden size-3 shrink-0 text-ink-3 @3xl/topbar:block" aria-hidden="true" />
    </span>
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

/**
 * What the fleet's toggle says when it is closed: the loudest true thing about
 * the open session, and only then about work from a deleted session — named as
 * such, so a count never reads as this session's.
 */
function fleetTooltip(fleet: FleetView): string {
  const needs = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;
  if (fleet.needsYou > 0) return `Show the fleet — ${needs(fleet.needsYou)}`;
  if (fleet.running > 0) return `Show the fleet — ${fleet.running} going`;
  if (fleet.elsewhereNeedsYou > 0) return `Show the fleet — ${needs(fleet.elsewhereNeedsYou)}, from a deleted session`;
  if (fleet.elsewhereRunning > 0) return `Show the fleet — ${fleet.elsewhereRunning} going, from a deleted session`;
  return "Show the fleet";
}
