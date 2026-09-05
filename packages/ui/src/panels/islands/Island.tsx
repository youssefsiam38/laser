"use client";
/**
 * The island (docs/ux-panels.md "Panels are islands, not boxes"): ONE element
 * per panel that grows and shrinks through four sizes, keeping identity,
 * position, scroll and focus the whole way.
 *
 * Sizes and their fixed content budgets:
 *   minimal   28px · dot · name · exactly one live value
 *   compact   36px · dot · name · up to three values · one action, rest in a menu
 *   expanded  header 40px · the kind's body with its own scroll
 *   maximized the window; Esc restores
 *
 * The morph is a CSS transition of the island's rectangle (the dock lays
 * islands out absolutely) plus a WAAPI hop when the element switches between
 * the dock and the fixed, full-window frame. Under `prefers-reduced-motion`
 * everything happens, instantly. Type never goes below 12px; touch targets
 * reach 44px through the hit-area pseudo-element, not by growing the pill.
 */
import type { Action } from "@piorbit/protocol";
import { ChevronsDownUp, Ellipsis, ExternalLink, Maximize2, Minimize2, MoveDiagonal, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { StatusDot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useTick } from "@/components/thread/timing";
import { cn } from "@/lib/utils";
import { motionEase, motionMs, prefersReducedMotion } from "@/motion";
import type { IslandSize } from "../dock-state.js";
import type { Rect } from "../layout.js";
import { usePanelActions, usePanelsState } from "../PanelsProvider.js";
import { attentionOfEntry, openDecisionIds, panelKey, type PanelEntry } from "../store.js";
import { accessibleSummary, liveValues, type LiveValue } from "../values.js";
import { CollectionBody } from "./bodies/CollectionBody.js";
import { DecisionBody } from "./bodies/DecisionBody.js";
import { DocumentBody } from "./bodies/DocumentBody.js";
import { PlanBody } from "./bodies/PlanBody.js";
import { RunBody } from "./bodies/RunBody.js";
import { StreamBody } from "./bodies/StreamBody.js";

export interface IslandProps {
  entry: PanelEntry;
  size: IslandSize;
  /** Dock coordinates. Absent in a sheet or a popped-out page, where the island fills its parent. */
  rect?: Rect | undefined;
  /** Folded into the `+N` island; kept mounted so it keeps its state. */
  hidden?: boolean;
  poppedOut?: boolean;
  /** Where the island renders. Governs which controls make sense. */
  frame: "dock" | "sheet" | "popout";
  /** Newly registered: plays the arrival. */
  fresh?: boolean;
  /**
   * A close control in the header, for a frame that has no chrome of its own.
   * The phone's sheet passes it; the dock and the fleet list do not.
   */
  onClose?: (() => void) | undefined;
  /**
   * Growing out of `minimal` outside the dock. The phone's strip owns that
   * transition (it opens a sheet), so it says what "expand me" means here.
   */
  onExpand?: (() => void) | undefined;
}

function IslandImpl({ entry, size, rect, hidden = false, poppedOut = false, frame, fresh = false, onClose, onExpand }: IslandProps) {
  const actions = usePanelActions();
  const { path, panel } = entry;
  const key = panelKey(path, panel.id);
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  const attention = attentionOfEntry(entry, decisions);
  const live = panel.kind === "run" ? panel.lifecycle === "running" || panel.lifecycle === "queued" : panel.kind === "stream" ? panel.follow === true : false;
  useTick(live && !hidden, 1000);
  const now = Date.now();
  const values = liveValues(entry, now);
  const root = useRef<HTMLElement>(null);
  const [everExpanded, setEverExpanded] = useState(size === "expanded" || size === "maximized");
  useEffect(() => {
    if (size === "expanded" || size === "maximized") setEverExpanded(true);
  }, [size]);

  useMaximizeMorph(root, size === "maximized", rect);
  useArrival(root, fresh);
  useScrollMemory(root, expandedSize(size));

  // Keyboard on the island itself: Esc restores a maximized island.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && size === "maximized" && frame === "dock") {
      e.preventDefault();
      e.stopPropagation();
      actions.restore(path);
    }
  };

  const expanded = size === "expanded" || size === "maximized";
  const style: CSSProperties | undefined =
    size === "maximized" || frame !== "dock"
      ? undefined
      : rect
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : undefined;

  return (
    <section
      ref={root}
      data-island
      data-size={size}
      data-kind={panel.kind}
      data-attention={attention}
      aria-label={size === "minimal" ? accessibleSummary(panel.title, values) : panel.title}
      aria-hidden={hidden || undefined}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        if (frame !== "dock" || !expanded) return;
        if (!(e.target as HTMLElement).closest("[data-island-header]")) return;
        if ((e.target as HTMLElement).closest("button")) return;
        if (size === "maximized") actions.restore(path);
        else actions.maximize(path, key);
      }}
      onPointerDownCapture={() => actions.watched(path, key)}
      style={style}
      className={cn(
        "group/island @container flex flex-col overflow-hidden bg-surface text-ink",
        frame === "dock" && "absolute border border-line",
        frame === "dock" && size !== "maximized" && "shadow-none",
        frame === "dock" && size === "maximized" && "fixed inset-0 z-40 rounded-none border-0",
        frame !== "dock" && "relative h-full w-full border-0",
        size === "minimal" ? "rounded-[14px]" : "rounded-xl",
        attention === "waiting_for_input" && size !== "maximized" && frame === "dock" && "border-attention/60",
        attention === "error" && size !== "maximized" && frame === "dock" && "border-danger/50",
        hidden && "pointer-events-none opacity-0",
        // The morph: the rectangle, the radius and the border move together.
        "transition-[top,left,width,height,border-radius,opacity,border-color] duration-(--motion-morph) ease-morph motion-reduce:transition-none data-[morphing]:transition-none",
      )}
    >
      <IslandHeader
        entry={entry}
        attention={attention}
        size={size}
        values={values}
        poppedOut={poppedOut}
        frame={frame}
        onClose={onClose}
        onExpand={onExpand}
      />

      {/* The body stays mounted once it has been seen, so a collapse keeps its
          state. Its scrollers are laid out at height 0 while it is collapsed,
          which is exactly where a browser may drop `scrollTop`, so the offsets
          are recorded on the way down and put back on the way up
          (`useScrollMemory`) — "the panel returns to exactly the pane and
          scroll position it left", one size below maximize. */}
      {(expanded || everExpanded) && (
        <div
          data-island-body
          data-collapsed={!expanded || undefined}
          aria-hidden={!expanded || undefined}
          inert={!expanded}
          className={cn("flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1", !expanded && "invisible h-0 flex-none overflow-hidden p-0")}
        >
          <PanelBody entry={entry} size={size} now={now} decisions={decisions} />
        </div>
      )}
    </section>
  );
}

export const Island = memo(IslandImpl);

// ---------------------------------------------------------------------------
// The header — one element, three budgets
// ---------------------------------------------------------------------------

const VALUE_TONE: Record<NonNullable<LiveValue["tone"]>, string> = {
  attention: "text-attention",
  danger: "text-danger",
  muted: "text-ink-3",
};

function Value({ value, className }: { value: LiveValue; className?: string | undefined }) {
  return (
    <span
      className={cn("typed shrink-0 text-ink-2 tnum", value.tone && VALUE_TONE[value.tone], className)}
      title={`${value.label}: ${value.text}`}
      aria-label={`${value.label} ${value.text}`}
    >
      {value.text}
    </span>
  );
}

/**
 * One header for all four sizes.
 *
 * The island is one element for life, and so is its header: the same status
 * dot, the same title node and the same controls region are re-used across a
 * size change, so the dot's sweep does not restart, the title does not
 * re-mount, and focus does not fall to the body when a size is chosen from the
 * menu. Only the budget changes — minimal shows one value, compact up to
 * three, expanded none (R13).
 *
 * The whole leading region is one button (`data-island-toggle`) so a list that
 * owns its own expansion — the fleet sheet — can tell the island's own toggle
 * apart from a declared action. It stops being interactive when the island is
 * expanded, which is what leaves double-click-to-maximize a header to land on.
 */
function IslandHeader({
  entry,
  attention,
  size,
  values,
  poppedOut,
  frame,
  onClose,
  onExpand,
}: {
  entry: PanelEntry;
  attention: ReturnType<typeof attentionOfEntry>;
  size: IslandSize;
  values: LiveValue[];
  poppedOut: boolean;
  frame: IslandProps["frame"];
  onClose?: (() => void) | undefined;
  onExpand?: (() => void) | undefined;
}) {
  const actions = usePanelActions();
  const { path, panel } = entry;
  const key = panelKey(path, panel.id);
  const expanded = size === "expanded" || size === "maximized";
  const maximized = size === "maximized";
  const declared = "actions" in panel ? (panel.actions ?? []) : [];
  const primary = size === "compact" ? declared[0] : undefined;
  const menuActions = size === "compact" ? declared.slice(1) : declared;
  const shown = size === "minimal" ? values.slice(0, 1) : size === "compact" ? values.slice(0, 3) : [];
  const value = shown[0];

  const toggle = () => {
    if (size === "minimal" && poppedOut && actions.focusPoppedOut(key)) return;
    if (onExpand) {
      onExpand();
      return;
    }
    if (frame !== "dock") return;
    actions.setSize(path, key, "expanded");
  };

  return (
    <div
      data-island-header
      className={cn(
        "flex w-full min-w-0 shrink-0 items-center gap-2",
        "transition-[height,padding] duration-(--motion-morph) ease-morph motion-reduce:transition-none",
        size === "minimal" && "h-7 px-0",
        size === "compact" && "h-9 pe-1 ps-2.5",
        size === "expanded" && "h-10 pe-1.5 ps-3",
        maximized && "h-12 border-b border-line px-4",
      )}
    >
      <button
        type="button"
        data-island-toggle
        // Expanded, the title is not a control: it is taken out of the tab
        // order and stops swallowing pointer events, so double-click-to-
        // maximize has a header to land on. It is deliberately NOT
        // `aria-hidden` — the title is the one thing on screen a reader needs.
        tabIndex={expanded ? -1 : 0}
        onClick={toggle}
        title={
          size === "minimal" && poppedOut
            ? `${panel.title} — open in another tab`
            : size === "minimal" && value
              ? `${panel.title} · ${value.label}: ${value.text}`
              : panel.title
        }
        className={cn(
          "relative flex h-full min-w-0 flex-1 items-center gap-2 text-start outline-none",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          "transition-colors duration-(--motion-instant)",
          size === "minimal" && `rounded-full px-2.5 hover:bg-surface-2 ${PRESSED}`,
          size === "compact" && `rounded-md ${PRESSED}`,
          // Expanded: the title is not a control, so the header behind it is
          // what double-click-to-maximize lands on.
          expanded && "pointer-events-none cursor-default",
          entry.closed && size === "minimal" && "opacity-70",
          // 44px of hit area on a coarse pointer, without the pill growing.
          "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
        )}
      >
        <StatusDot status={attention} size={expanded ? "md" : "sm"} />
        {expanded && (
          <Badge variant="mono" className="hidden shrink-0 @[360px]:inline-flex" title={`From ${panel.source}`}>
            {panel.source}
          </Badge>
        )}
        <span
          className={cn(
            "min-w-0 truncate text-ink",
            size === "minimal" && "flex-1 text-xs font-medium leading-4",
            size === "compact" && "text-sm font-medium leading-5",
            expanded && "flex-1 text-sm font-semibold leading-5",
          )}
        >
          {panel.title}
        </span>
        {size === "minimal" && poppedOut ? (
          <ExternalLink className="size-3 shrink-0 text-ink-3" aria-label="Open in another tab" />
        ) : (
          <span className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
            {shown.map((v, i) => (
              <Value key={`${v.label}-${i}`} value={v} className={cn(v.ticking && "min-w-[3.5ch] text-end", size === "compact" && "truncate")} />
            ))}
          </span>
        )}
      </button>

      {maximized && (
        <span className="hidden items-center gap-1 text-xs text-ink-3 md:inline-flex" aria-hidden="true">
          <Kbd>Esc</Kbd> back
        </span>
      )}

      {primary && !entry.closed && (
        <Button
          size="xs"
          variant={primary.destructive ? "destructive-ghost" : "outline"}
          className="shrink-0 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2.5 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']"
          onClick={() => void actions.act(entry, primary.id)}
          title={primary.confirm}
        >
          {primary.label}
        </Button>
      )}

      {size !== "minimal" && (size === "compact" || frame === "dock") && (
        <IslandMenu entry={entry} size={size} extraActions={menuActions} frame={frame} />
      )}
      {expanded && frame === "dock" && (
        <>
          {/* Pop out and maximize hide in a narrow island and stay in the menu
              above, which already carries both. Four controls plus a dot leave
              a 180px island a two-character title, and dropping content is how
              an island shrinks (R13). Close never hides: it is the one control
              a person reaches for without thinking. */}
          <TooltipIconButton
            tooltip="Pop out to a new tab"
            size="icon-xs"
            className={cn("hidden text-ink-3 @[300px]:inline-flex", COARSE_HIT)}
            onClick={() => actions.popOut(path, key)}
          >
            <ExternalLink />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={maximized ? "Back to the dock" : "Maximize"}
            {...(maximized ? { shortcut: "Esc" } : {})}
            size="icon-xs"
            className={cn("hidden text-ink-3 @[300px]:inline-flex", COARSE_HIT)}
            onClick={() => (maximized ? actions.restore(path) : actions.maximize(path, key))}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </TooltipIconButton>
          {/* A panel its producer has closed can be taken away; a live one is
              only ever shrunk. Nothing is parked, and nothing that is still
              running leaves without saying so (R7). */}
          <TooltipIconButton
            tooltip={entry.closed ? "Close" : "Shrink to a pill"}
            size="icon-xs"
            className={cn("text-ink-3", COARSE_HIT)}
            onClick={() => (entry.closed ? actions.dismiss(path, key) : actions.setSize(path, key, "minimal"))}
          >
            <X />
          </TooltipIconButton>
        </>
      )}
      {onClose && (
        <TooltipIconButton tooltip="Done" size="icon-xs" className={cn("text-ink-3", COARSE_HIT)} onClick={onClose}>
          <X />
        </TooltipIconButton>
      )}
    </div>
  );
}

/**
 * The pressed state every hand-rolled control in the panel system shares
 * ("hover and focus and pressed states on everything interactive"). Same
 * mix `buttonVariants` uses, so a pill and a Button feel the same under a
 * finger.
 */
export const PRESSED = "active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]";

/** 44px of hit area on a coarse pointer around a 24px control (R13). */
const COARSE_HIT =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']";

/**
 * The rest of the controls. Every entry is hidden when it would do nothing
 * here (R2: hide the control, never disable it) — no "Maximize" on something
 * already maximized, no "Pop out" from a window that is already the pop-out.
 */
function IslandMenu({
  entry,
  size,
  extraActions = [],
  frame,
}: {
  entry: PanelEntry;
  size: IslandSize;
  extraActions?: readonly Action[];
  frame: IslandProps["frame"];
}) {
  const actions = usePanelActions();
  const { path, panel } = entry;
  const key = panelKey(path, panel.id);
  const declared = size === "compact" ? extraActions : "actions" in panel ? (panel.actions ?? []) : [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip="More" size="icon-xs" className={cn("text-ink-3", COARSE_HIT)}>
          <Ellipsis />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {declared.length > 0 && !entry.closed && (
          <>
            {declared.map((action) => (
              <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onSelect={() => void actions.act(entry, action.id)}>
                {action.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {frame === "dock" && size !== "expanded" && size !== "maximized" && (
          <DropdownMenuItem onSelect={() => actions.setSize(path, key, "expanded")}>
            <MoveDiagonal />
            Expand
          </DropdownMenuItem>
        )}
        {frame === "dock" && size !== "compact" && (
          <DropdownMenuItem onSelect={() => actions.setSize(path, key, "compact")}>
            <ChevronsDownUp />
            Collapse to a row
          </DropdownMenuItem>
        )}
        {frame === "dock" && size !== "minimal" && (
          <DropdownMenuItem onSelect={() => actions.setSize(path, key, "minimal")}>
            <ChevronsDownUp />
            Shrink to a pill
          </DropdownMenuItem>
        )}
        {frame === "dock" && <DropdownMenuSeparator />}
        {frame === "dock" && (
          <DropdownMenuItem onSelect={() => actions.popOut(path, key)}>
            <ExternalLink />
            Pop out
          </DropdownMenuItem>
        )}
        {frame === "dock" && (
          <DropdownMenuItem onSelect={() => (size === "maximized" ? actions.restore(path) : actions.maximize(path, key))}>
            {size === "maximized" ? <Minimize2 /> : <Maximize2 />}
            {size === "maximized" ? "Back to the dock" : "Maximize"}
          </DropdownMenuItem>
        )}
        {/* Close takes a panel away only once its producer has closed it. While
            it is live, the smallest it goes is a pill that keeps ticking (R7). */}
        {frame === "dock" && (
          <DropdownMenuItem onSelect={() => (entry.closed ? actions.dismiss(path, key) : actions.setSize(path, key, "minimal"))}>
            <X />
            {entry.closed ? "Close" : "Shrink to a pill"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * The kind's body, and the "ended" notice above it. Exported because the
 * inline surface draws the same six bodies inside a transcript card: a
 * `collection` looks the same wherever the placement table sends it, which is
 * the whole point of piorbit owning presentation.
 */
export function PanelBody({ entry, size, now, decisions }: { entry: PanelEntry; size: IslandSize; now: number; decisions: ReadonlySet<string> }) {
  const actions = usePanelActions();
  const { path, panel } = entry;
  const act = (actionId: string, value?: string) => actions.act(entry, actionId, value);
  const openRef = (ref: string, label: string) => actions.openRefAsDocument(path, ref, label, panel.source);
  const openRun = (runId: string) => {
    const key = panelKey(path, runId);
    actions.setSize(path, key, "expanded");
  };
  let body: ReactNode;
  switch (panel.kind) {
    case "run":
      body = <RunBody entry={entry} panel={panel} now={now} onAct={act} onOpenRef={openRef} />;
      break;
    case "plan":
      body = <PlanBody entry={entry} panel={panel} maximized={size === "maximized"} openDecisions={decisions} onAct={act} onOpenRun={openRun} />;
      break;
    case "document":
      body = <DocumentBody entry={entry} panel={panel} onAct={act} />;
      break;
    case "stream":
      body = <StreamBody entry={entry} panel={panel} onAct={act} />;
      break;
    case "collection":
      body = <CollectionBody entry={entry} panel={panel} onAct={act} onOpenRef={openRef} />;
      break;
    case "decision":
      body = <DecisionBody panel={panel} onAnswer={(values) => actions.answerDecision(entry, values)} autoFocus={false} />;
      break;
  }
  return (
    <>
      {entry.closed && (
        <p className="mb-2 rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2" role="status">
          Ended · {entry.closed.reason}
        </p>
      )}
      {body}
    </>
  );
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * The hop between the dock's coordinate system and the fixed full-window
 * frame cannot be a CSS transition (the containing block changes), so it is
 * one Web Animation from the last rectangle to the new one. Reduced motion:
 * no animation, the frame simply changes.
 */
function useMaximizeMorph(root: React.RefObject<HTMLElement | null>, maximized: boolean, rect: Rect | undefined) {
  const previous = useRef<{ maximized: boolean; box: DOMRect | undefined }>({ maximized, box: undefined });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const was = previous.current;
    previous.current = { maximized, box: el.getBoundingClientRect() };
    if (was.maximized === maximized) return;
    // The frame flip is one motion (the animation below), so the rectangle's
    // own CSS transition sits out for its duration or the two would fight.
    const morphMs = motionMs("--motion-morph");
    el.dataset["morphing"] = "";
    const release = setTimeout(() => delete el.dataset["morphing"], morphMs + 20);
    if (!was.box || prefersReducedMotion() || typeof el.animate !== "function") return () => clearTimeout(release);
    const from = was.box;
    const to = el.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    // Animate in the element's own coordinate space: translate + scale from where it was.
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    el.animate(
      [
        { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: maximized ? "12px" : "0px" },
        { transformOrigin: "top left", transform: "none", borderRadius: maximized ? "0px" : "12px" },
      ],
      { duration: morphMs, easing: motionEase(), fill: "none" },
    );
    return () => clearTimeout(release);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rect only so a layout change re-measures
  }, [maximized, rect?.top, rect?.left, rect?.width, rect?.height]);
}

/**
 * Scroll survives a collapse.
 *
 * The body stays mounted, but while it is collapsed its scrollers are laid out
 * at height 0, and an element whose client height is zero is where a browser is
 * free to drop `scrollTop`. So every scroller under the body is recorded on the
 * way down and restored in a layout effect on the way up, before anything is
 * painted.
 */
function useScrollMemory(root: React.RefObject<HTMLElement | null>, expanded: boolean) {
  const saved = useRef<number[]>([]);
  const was = useRef(expanded);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || was.current === expanded) return;
    const scrollers = Array.from(el.querySelectorAll<HTMLElement>("[data-island-scroll]"));
    if (expanded) {
      scrollers.forEach((node, i) => {
        const top = saved.current[i];
        if (top !== undefined && top > 0) node.scrollTop = top;
      });
    } else {
      saved.current = scrollers.map((node) => node.scrollTop);
    }
    was.current = expanded;
  }, [root, expanded]);
}

const expandedSize = (size: IslandSize): boolean => size === "expanded" || size === "maximized";

/** A new island fades and settles in; nothing pops. */
function useArrival(root: React.RefObject<HTMLElement | null>, fresh: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!el || !fresh || prefersReducedMotion() || typeof el.animate !== "function") return;
    el.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], {
      duration: motionMs("--motion-slow"),
      easing: motionEase(),
      fill: "none",
    });
  }, [root, fresh]);
}
