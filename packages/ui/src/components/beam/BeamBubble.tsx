import { CircleAlert, Maximize2, Sparkles, SquarePen, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { useAgentsSnapshot } from "@/agents";
import { Thread } from "@/components/thread/Thread";
import { useShell } from "@/components/shell/shell-context";
import { sessionsList } from "@/components/shell/session-groups";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";
import { LaserThreadScope, useLaserStable, useLaserState, useThreadScopeRefusal, type ScopedSessionShape } from "@/runtime";
import type { AppState } from "@/store";

import { BeamEmptyState } from "./BeamEmptyState.js";
import { BEAM_BUBBLE_ID } from "./BeamSpark.js";
import { beamStore, useBeam } from "./beam-store.js";
import { BEAM_FOLLOW_UPS, BEAM_NAME, BEAM_TAGLINE, BEAM_UNAVAILABLE, beamWorkspace, bubbleOrigin, isBeamSession, startBeamSession } from "./beam-model.js";

/**
 * The bubble (docs/agents.md "Beam"): the ordinary chat — composer, tool
 * rows, approvals, attachments, the status line — for the current Beam
 * session, in a second thread that leaves the main view where it is
 * (`LaserThreadScope`). On desktop and tablet it is a floating card that grows
 * out of the spark; on a phone it is a full-height sheet.
 *
 * Motion: scale and opacity from the spark's position over `--motion-morph`
 * with `--motion-ease`; under reduced motion it appears in place. Escape
 * closes it when focus is inside and nothing else (a popover, a dialog) is
 * using Escape; focus lands in its composer on open and returns to the spark
 * on close. Mounted once, by the shell.
 */
export function BeamBubble() {
  const { open } = useBeam();
  const shell = useShell();
  if (shell.layout === "mobile") return <BeamSheet open={open} />;
  return <BeamCard open={open} />;
}

/**
 * The remembered session, once the catalog can vouch for it. Before the
 * catalog has answered the path is withheld rather than tried, so a session
 * that turns out to be gone never becomes the thread for a moment.
 */
function useBeamPath(): string | undefined {
  const { path } = useBeam();
  const { archive } = useLaserStable();
  const known = useLaserState(
    useCallback((s: AppState) => {
      if (path === undefined) return "none" as const;
      if (s.open[path] !== undefined) return "open" as const;
      if (!s.sessionsLoaded) return "pending" as const;
      return s.sessions.some((session) => session.path === path) ? "listed" : "gone";
    }, [path]),
  );
  useEffect(() => {
    if (known === "gone" || (path !== undefined && archive.has(path))) beamStore.setPath(undefined);
  }, [archive, known, path]);
  if (path === undefined || known === "pending" || known === "gone" || archive.has(path)) return undefined;
  return path;
}

/** The second thread, scoped to Beam's sessions, with the header above it. */
function BeamPanel({ onClose }: { onClose: () => void }) {
  const path = useBeamPath();
  const { path: requestedPath } = useBeam();
  const [startError, setStartError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const { actions } = useLaserStable();
  const snapshot = useAgentsSnapshot();
  const filter = useCallback((session: ScopedSessionShape, state: AppState) => isBeamSession(session, state.agents.snapshot), []);
  const createIn = useCallback((state: AppState) => beamWorkspace(state.agents.snapshot), []);
  const ready = snapshot !== null;

  useEffect(() => {
    if (!ready || requestedPath !== undefined) return;
    let live = true;
    setStartError(undefined);
    void startBeamSession(actions, snapshot, { select: false }).then(
      (created) => { if (live) beamStore.setPath(created); },
      (error: unknown) => { if (live) setStartError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { live = false; };
  }, [actions, ready, requestedPath, retry, snapshot]);

  /** Maximize the very same prepared session, whether or not it has messages. */
  const openInFullView = async (): Promise<void> => {
    if (!path) return;
    try {
      sessionsList.setTab("code");
      await actions.openSession(path);
      onClose();
    } catch (error) {
      // The bubble stays open: the chat is still here to try again from.
      actions.toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1.5 ps-3.5 pe-2 hairline-b">
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-live" />
        <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{BEAM_NAME}</h2>
        <span className="flex-1" />
        <TooltipIconButton tooltip="New chat" side="bottom" disabled={!path} onClick={() => beamStore.newChat()} data-slot="beam-new-chat">
          <SquarePen />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Open in full view" side="bottom" disabled={!path} onClick={() => void openInFullView()} data-slot="beam-open-full">
          <Maximize2 />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Close" shortcut="Esc" side="bottom" onClick={onClose} data-slot="beam-close">
          <X />
        </TooltipIconButton>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {path ? (
          <LaserThreadScope path={path} onPathChange={beamStore.setPath} filter={filter} createIn={createIn} unavailable={BEAM_UNAVAILABLE}>
            <BeamRefusal />
            <Thread emptyState={<BeamEmptyState />} followUps={BEAM_FOLLOW_UPS} />
          </LaserThreadScope>
        ) : startError ? (
          <div role="alert" className="px-4 py-3 text-sm text-ink-2">
            <p>Beam couldn’t start this chat. {startError}</p>
            <button type="button" onClick={() => setRetry((n) => n + 1)} className="mt-2 rounded-md px-2 py-1 text-sm text-ink underline underline-offset-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-live">Try again</button>
          </div>
        ) : (
          <p role="status" className="px-4 py-3 text-sm text-ink-3">{ready ? "Starting Beam…" : BEAM_UNAVAILABLE}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The host would not start the chat (no model Beam can call, the workspace
 * not ready): its sentence, where the person is looking, with the message
 * handed back to the composer underneath. Goes when the person types again
 * or dismisses it.
 */
function BeamRefusal() {
  const { refusal, dismissRefusal } = useThreadScopeRefusal();
  useEffect(() => {
    if (refusal === undefined) return;
    const onInput = (event: Event) => {
      if (event.target instanceof HTMLTextAreaElement) dismissRefusal();
    };
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
  }, [dismissRefusal, refusal]);
  if (refusal === undefined) return null;
  return (
    <div
      role="alert"
      data-slot="beam-refusal"
      className="flex shrink-0 items-start gap-2 border-s-2 border-danger bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] py-2 ps-3 pe-1 text-sm leading-sm text-ink"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Beam couldn’t start this chat.</span> {refusal}
      </p>
      <TooltipIconButton tooltip="Dismiss" size="icon-xs" side="bottom" className="text-ink-3" onClick={dismissRefusal}>
        <X />
      </TooltipIconButton>
    </div>
  );
}

/** Focus the composer once the bubble is up; give focus back to the spark when it goes. */
function useBubbleFocus(open: boolean, panel: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const textarea = panel.current?.querySelector<HTMLElement>("textarea");
      (textarea ?? panel.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, panel]);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) beamStore.anchor()?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
}

/**
 * Escape inside the bubble closes it — unless a popover or dialog inside it
 * already took the key (they mark the event), or the key came from one of
 * them (they sit in portals, but React bubbles through the owner tree).
 */
function escapeCloses(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('[role="dialog"], [data-radix-popper-content-wrapper], [role="listbox"]')) return;
  event.preventDefault();
  close();
}

// ---------------------------------------------------------------------------
// Desktop and tablet: the floating card
// ---------------------------------------------------------------------------

type Phase = "closed" | "opening" | "open" | "closing";

function BeamCard({ open }: { open: boolean }) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const panel = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState<string | undefined>(undefined);

  // Open mounts and plays the arrival; close plays the departure and unmounts
  // after it. A timer backs the animation end up: under reduced motion the
  // tokens are 0ms and no animation ever ends.
  useEffect(() => {
    if (open) {
      setPhase((current) => (current === "open" ? current : "opening"));
      return;
    }
    setPhase((current) => (current === "closed" ? current : "closing"));
  }, [open]);
  useEffect(() => {
    if (phase !== "opening" && phase !== "closing") return;
    const timer = setTimeout(() => setPhase(phase === "opening" ? "open" : "closed"), motionMs("--motion-morph") + 40);
    return () => clearTimeout(timer);
  }, [phase]);

  // The bubble grows out of the spark: measure both before the first paint.
  useLayoutEffect(() => {
    if (phase !== "opening") return;
    const spark = beamStore.anchor()?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (box) setOrigin(bubbleOrigin(spark, box));
  }, [phase]);

  useBubbleFocus(open, panel);

  const close = useCallback(() => beamStore.close(), []);
  if (phase === "closed") return null;

  return (
    <section
      ref={panel}
      id={BEAM_BUBBLE_ID}
      aria-label={BEAM_NAME}
      data-slot="beam-bubble"
      data-state={phase === "closing" ? "closed" : "open"}
      tabIndex={-1}
      onKeyDown={(event) => escapeCloses(event, close)}
      onAnimationEnd={(event) => {
        if (event.target !== panel.current) return;
        setPhase((current) => (current === "opening" ? "open" : current === "closing" ? "closed" : current));
      }}
      style={origin ? { transformOrigin: origin } : undefined}
      className={cn(
        // Above the workbench (z-30), below dialogs and sheets (z-50).
        "fixed bottom-2 start-16 z-40 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-float outline-none",
        "h-160 w-105 max-h-[calc(100dvh-var(--spacing)*4)] max-w-[calc(100vw-var(--spacing)*18)]",
        "fill-mode-both duration-(--motion-morph) ease-morph motion-reduce:animate-none",
        phase === "closing" ? "animate-out fade-out-0 zoom-out-50" : "animate-in fade-in-0 zoom-in-50",
      )}
    >
      <BeamPanel onClose={close} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phone: the full-height sheet
// ---------------------------------------------------------------------------

function BeamSheet({ open }: { open: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useBubbleFocus(open, panel);
  const close = useCallback(() => beamStore.close(), []);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent
        ref={panel}
        id={BEAM_BUBBLE_ID}
        side="bottom"
        showCloseButton={false}
        data-slot="beam-bubble"
        className="h-dvh max-h-none gap-0 rounded-none border-0 p-0"
      >
        <SheetTitle className="sr-only">{BEAM_NAME}</SheetTitle>
        <SheetDescription className="sr-only">{BEAM_TAGLINE}</SheetDescription>
        <BeamPanel onClose={close} />
      </SheetContent>
    </Sheet>
  );
}
