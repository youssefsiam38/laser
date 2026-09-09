"use client";
/**
 * Message queue — the waiting messages, directly above the composer
 * (docs/ux-elements.md "Messages", DESIGN.md "Composer", M1-T5, M13-T28).
 * Installed from `elements-message-queue` and restyled to DESIGN.md tokens.
 *
 * One row per message, in the order they were written. Leaving a row alone is
 * the default and the row says so; the three deliberate acts are on it —
 * **Steer** (interrupt with this one), the delete icon (drop just this one),
 * and **⋯** (edit it back into the composer, copy it, drop them all).
 *
 * Divergences from the registry copy:
 *   - Rows, not chips: a chip has room for a truncated line and nothing else,
 *     and every message here needs three controls and a sentence saying what
 *     happens if they are not used.
 *   - Two lanes, on purpose. A message already handed to the engine (steered
 *     here, or queued by the engine itself) is "Up next" with a solid `--live`
 *     rule and no controls: it is gone, and the engine has no verb to take one
 *     back. A message still in Laser's tray is "After this turn" and carries
 *     all three (docs/ux-fleet.md R4, capability honesty).
 *   - The "running" row is gone: the status line directly above the composer
 *     already says the session is working (D-20 §5).
 */
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { AlertTriangle, Copy, CornerDownRight, Ellipsis, ListEnd, ListX, PencilLine, Send, X } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { isSteerQueueItemId, pendingIdOfQueueItemId, useLaserStable, useLaserView } from "@/runtime";

export type QueueLane = "steer" | "waiting" | "sending" | "failed";

export interface QueuedMessage {
  id: string;
  text: string;
  lane: QueueLane;
}

export interface MessageQueueProps extends Omit<ComponentProps<"ul">, "children"> {
  /** Items to draw; when `children` is given they are drawn by the caller instead. */
  items?: readonly QueuedMessage[] | undefined;
  children?: ReactNode;
  count: number;
}

/** Nothing waiting draws nothing at all — not an empty shell with a count of 0. */
export function MessageQueue({ items, children, count, className, ...props }: MessageQueueProps) {
  if (count === 0) return null;
  return (
    <ul
      data-slot="message-queue"
      aria-label={`${count} message${count === 1 ? "" : "s"} waiting to go to the agent`}
      className={cn("@container/queue flex flex-col gap-1.5 px-1", className)}
      {...props}
    >
      {children ?? items?.map((item) => <QueuedRow key={item.id} text={item.text} lane={item.lane} />)}
    </ul>
  );
}

/**
 * What happens to this message if nobody touches it — on the row, not in a
 * legend. Two lengths of the same sentence, because the thread column is 230px
 * wide with the fleet open and 700px with it closed, and a note that eats the
 * message it describes is worse than a shorter one.
 */
const LANE_NOTE: Record<QueueLane, { short: string; long: string }> = {
  steer: { short: "Next", long: "Up next" },
  waiting: { short: "Waits", long: "After this turn" },
  sending: { short: "Sending", long: "Sending now" },
  failed: { short: "Didn’t send", long: "Didn’t send" },
};

const LANE_ICON = { steer: CornerDownRight, waiting: ListEnd, sending: Send, failed: AlertTriangle } as const;

/**
 * 44px of hit area around a 24px control, painted at 24px. On a 390px phone the
 * three controls plus the note already take most of the row, and three 44px
 * *boxes* left the message itself 30px wide — so the target grows past the
 * paint, not past the layout (DESIGN.md "Touch targets stay 44px"). Forcing the
 * height instead pushed one control off the others' baseline, which is why the
 * vertical half is a pseudo-element here too.
 */
const TOUCH_HIT = "relative after:absolute after:-inset-2.5 after:content-['']";
/** The same 44px of height for a control that is already wide enough. */
const TOUCH_HIT_Y = "relative after:absolute after:-inset-y-2.5 after:-inset-x-1 after:content-['']";

export interface QueuedRowProps {
  text: string;
  lane: QueueLane;
  /** The reason a `failed` row failed, in the words the worker used. */
  error?: string | undefined;
  /** Interrupt the run with this message. Absent when it is already on its way. */
  onSteer?: (() => void) | undefined;
  /** Drop just this one. */
  onRemove?: (() => void) | undefined;
  /** Put it back in the composer, out of the queue. */
  onEdit?: (() => void) | undefined;
  /** Drop every waiting message; offered only when there is more than one. */
  onClearAll?: (() => void) | undefined;
}

export function QueuedRow({ text, lane, error, onSteer, onRemove, onEdit, onClearAll }: QueuedRowProps) {
  // A message is one line at rest and the whole thing when asked. Toggling
  // rather than a tooltip is the one path that works with a mouse, a keyboard
  // and a finger, and it is how the person reads back what they wrote.
  const [open, setOpen] = useState(false);
  const touch = useIsTouch();
  const Icon = LANE_ICON[lane];
  const note = lane === "failed" ? { short: error ?? LANE_NOTE.failed.short, long: error ?? LANE_NOTE.failed.long } : LANE_NOTE[lane];
  const hasMenu = onEdit !== undefined || onClearAll !== undefined;
  return (
    <li
      data-slot="queued-row"
      data-lane={lane}
      className={cn(
        "flex min-h-8 items-start gap-1.5 rounded-lg border bg-surface ps-2 pe-1 text-sm text-ink",
        // The 44px hit areas below are pseudo-elements, so the row has to be
        // tall enough to hold them or two neighbours would share a few pixels.
        touch ? "py-2.5" : "py-1",
        lane === "steer" && "border-live",
        lane === "waiting" && "border-dashed border-[color-mix(in_oklab,var(--ink-3)_70%,transparent)]",
        lane === "sending" && "border-line",
        lane === "failed" && "border-danger",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-3.5 shrink-0",
          lane === "steer" ? "text-live" : lane === "failed" ? "text-danger" : "text-ink-3",
        )}
      />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "min-w-0 flex-1 cursor-text rounded-sm py-1 text-start outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          open ? "max-h-40 overflow-y-auto whitespace-pre-wrap break-words" : "truncate",
        )}
      >
        {text}
      </button>
      <span
        className={cn(
          "eyebrow mt-1.5 whitespace-nowrap",
          lane === "failed" ? "min-w-0 max-w-40 shrink truncate text-danger" : "shrink-0",
          lane === "steer" && "text-live",
        )}
      >
        {/* The two lengths are one fact, so only the sentence is announced;
            which of them is painted is a question about the column's width. */}
        <span aria-hidden="true" className="@[380px]/queue:hidden">{note.short}</span>
        <span aria-hidden="true" className="hidden @[380px]/queue:inline">{note.long}</span>
        <span className="sr-only">{note.long}</span>
      </span>
      {onSteer ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The whole point of the row: one click, no chord, no menu. */}
            <Button
              variant="ghost"
              size="xs"
              onClick={onSteer}
              className={cn("shrink-0 text-ink hover:text-live", touch && TOUCH_HIT_Y)}
            >
              Steer
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Send this now instead of waiting
          </TooltipContent>
        </Tooltip>
      ) : null}
      {onRemove ? (
        <TooltipIconButton
          tooltip="Drop this message"
          size="icon-xs"
          onClick={onRemove}
          className={cn("shrink-0 text-ink-3", touch && TOUCH_HIT)}
        >
          <X />
        </TooltipIconButton>
      ) : null}
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton
              tooltip="More"
              size="icon-xs"
              className={cn("shrink-0 text-ink-3", touch && TOUCH_HIT)}
            >
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {onEdit ? (
              <DropdownMenuItem onSelect={onEdit}>
                <PencilLine />
                Edit in the composer
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(text)}>
              <Copy />
              Copy text
            </DropdownMenuItem>
            {onClearAll ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onClearAll}>
                  <ListX />
                  Drop all waiting messages
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/**
 * The tray, bound to the open session. assistant-ui draws the steer lane first
 * and the waiting lane after it, which is also the order they reach the agent.
 */
export function ComposerQueue() {
  const aui = useAui();
  const { actions } = useLaserStable();
  const view = useLaserView();
  const count = useAuiState((s) => s.composer.queue.length);
  const waiting = view?.pending ?? [];

  /** Put text back where it can be read and rewritten, without losing a draft. */
  const intoComposer = (text: string) => {
    if (!text) return;
    const current = aui.composer.getState().text;
    aui.composer.setText(current ? `${current}\n${text}` : text);
  };

  const clearAll = () => {
    actions
      .clearQueue()
      .then(intoComposer)
      .catch(() => {
        /* the provider already toasted the failure */
      });
  };

  return (
    <MessageQueue count={count}>
      <ComposerPrimitive.Queue>
        {({ queueItem }) => {
          const item = aui.composer.queueItem({ id: queueItem.id });
          const pendingId = pendingIdOfQueueItemId(queueItem.id);
          const message = pendingId ? waiting.find((entry) => entry.id === pendingId) : undefined;
          // A row the engine already holds — steered, or queued by the engine
          // itself — has no id of ours and no verb behind any of the controls.
          if (!message) {
            return <QueuedRow text={queueItem.prompt} lane={isSteerQueueItemId(queueItem.id) ? "steer" : "waiting"} />;
          }
          if (message.state === "delivering") return <QueuedRow text={queueItem.prompt} lane="sending" />;
          return (
            <QueuedRow
              text={queueItem.prompt}
              lane={message.state === "failed" ? "failed" : "waiting"}
              {...(message.error ? { error: message.error } : {})}
              // Both go through the queue adapter, which is the one route to
              // the worker: an unanchored move into the steer lane, and the
              // per-item remove the tray exists to make possible.
              onSteer={() => item.move({ lane: "steer", insertAfter: null })}
              onRemove={() => item.remove()}
              onEdit={() => {
                intoComposer(message.text);
                item.remove();
              }}
              {...(count > 1 ? { onClearAll: clearAll } : {})}
            />
          );
        }}
      </ComposerPrimitive.Queue>
    </MessageQueue>
  );
}
