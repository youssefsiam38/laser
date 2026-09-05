"use client";
/**
 * Approval card — "human in the loop: the agent asks before it runs anything
 * with side effects" (docs/ux-elements.md "Agents": a `decision` panel with an
 * approval, rendered in its tool row). Installed from `elements-approval-card`.
 * `DecisionBody` is the controller — state, keyboard, timeout, submit — and
 * hands this element a one-question decision: a `confirm` field, or a `choice`
 * whose options are plain one-offs. A choice that changes how the session asks
 * from now on goes to `PermissionGrant` instead; anything with fields to fill
 * goes to `ElicitationForm`.
 *
 * Divergences from the registry copy:
 *   - No fixed "Deny / Always allow / Allow once": the buttons are the
 *     payload's options, or Yes and the rejection label (R12a). "Always allow"
 *     is a scope, which is the permission grant's job.
 *   - No `state` after the answer: an answered decision closes (R7 says why as
 *     it goes); the element does not fake a "running" line.
 *   - "No" is never a dead end: `onDecline` opens the rejection field.
 *   - Renders without card chrome; the tool row, the composer card and the
 *     sheet each supply their own (one question, three places, one look).
 *   - Touch: 48px full-width controls with the primary nearest the thumb.
 */
import { ShieldQuestionMark, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface DecisionHeaderProps {
  titleId: string;
  /** `source · blocks this turn` */
  eyebrow: string;
  title: string;
  message?: string | undefined;
  secondsLeft?: number | undefined;
  icon?: LucideIcon | undefined;
  /** The sheet's larger title. */
  large?: boolean | undefined;
}

/** The header the three decision elements share: eyebrow, title, message, countdown. */
export function DecisionHeader({ titleId, eyebrow, title, message, secondsLeft, icon: Icon, large = false }: DecisionHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      {Icon && (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3" aria-hidden="true">
          <Icon className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="eyebrow mb-1">{eyebrow}</p>
        <p id={titleId} className={cn("font-medium text-ink", large ? "text-base" : "text-sm")}>
          {title}
        </p>
        {message && <p className="mt-1 text-sm whitespace-pre-wrap text-ink-2">{message}</p>}
      </div>
      {secondsLeft !== undefined && (
        <span className={cn(mono, "shrink-0 pt-0.5", secondsLeft <= 5 ? "text-attention" : "text-ink-3")} aria-live="polite">
          {secondsLeft}s
        </span>
      )}
    </div>
  );
}

export type ApprovalCardProps = Omit<ComponentProps<"div">, "children" | "title"> &
  DecisionHeaderProps & {
    touch: boolean;
    busy: boolean;
    /**
     * A `choice` field's options, each its own answer. Absent for a `confirm`,
     * which answers Yes or declines.
     */
    choices?: readonly string[] | undefined;
    onChoose?: ((option: string) => void) | undefined;
    onAllow?: (() => void) | undefined;
    /** The rejection's label, or "No". */
    declineLabel: string;
    onDecline(): void;
    /** Shown when declining is not a rejection field: the plain way out. */
    onCancel?: (() => void) | undefined;
    /** Marks an option as mode-changing before it is pressed, not after. */
    modeChanging?: ((option: string) => boolean) | undefined;
    /** Keyboard hint, drawn by the caller in its own words. */
    hint?: ReactNode;
  };

export function ApprovalCard({
  titleId,
  eyebrow,
  title,
  message,
  secondsLeft,
  icon = ShieldQuestionMark,
  large,
  touch,
  busy,
  choices,
  onChoose,
  onAllow,
  declineLabel,
  onDecline,
  onCancel,
  modeChanging,
  hint,
  className,
  ...props
}: ApprovalCardProps) {
  const size = touch ? ("lg" as const) : ("sm" as const);
  const tall = touch ? "h-12 text-base" : "";
  return (
    <div data-slot="approval-card" className={cn("flex flex-col gap-3", className)} {...props}>
      <DecisionHeader titleId={titleId} eyebrow={eyebrow} title={title} message={message} secondsLeft={secondsLeft} icon={icon} large={large} />

      {choices ? (
        // One choice field: the options are the answer.
        <div className={cn("flex gap-2", touch ? "flex-col" : "flex-wrap")} role="group" aria-label={title}>
          {choices.map((option, i) => {
            const changes = modeChanging?.(option) ?? false;
            return (
              <Button
                key={`${i}-${option}`}
                variant="outline"
                size={size}
                data-option
                disabled={busy}
                onClick={() => onChoose?.(option)}
                className={cn(
                  changes && "border-[color-mix(in_oklab,var(--attention)_45%,var(--line))]",
                  touch && "h-auto min-h-12 w-full flex-col items-start gap-0.5 py-2.5 text-start text-base whitespace-normal",
                )}
              >
                <span className={cn(touch && "w-full wrap-break-word")}>{option}</span>
                {changes && <span className={cn("font-normal text-attention", touch ? "text-xs" : "sr-only")}>Changes how this session asks from now on</span>}
              </Button>
            );
          })}
          {/* Autofocused on purpose: Enter is never the key that approves. */}
          <Button variant="ghost" size={size} data-autofocus className={cn(touch && "h-11 text-base text-ink-2")} onClick={onCancel ?? onDecline}>
            {onCancel ? "Cancel" : declineLabel}
          </Button>
        </div>
      ) : (
        // On a phone the primary sits on the right, wider, where the thumb is.
        <div className={cn("flex gap-2", touch ? "" : "flex-wrap items-center")}>
          <Button variant="outline" size={size} data-autofocus className={cn(tall, touch && "flex-1")} disabled={busy} onClick={onDecline}>
            {declineLabel}
          </Button>
          <Button size={size} disabled={busy} className={cn(tall, touch && "flex-[1.6]")} onClick={onAllow}>
            Yes
          </Button>
          {hint}
        </div>
      )}
    </div>
  );
}
