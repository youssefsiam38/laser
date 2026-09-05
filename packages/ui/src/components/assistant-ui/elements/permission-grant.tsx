"use client";
/**
 * Permission grant — "granting a capability rather than approving one action,
 * with the reach spelled out" (docs/ux-elements.md "Tool use": tool approval
 * with scope options). Installed from `elements-permission-grant`.
 * `DecisionBody` chooses it for a one-question `choice` whose options include
 * one that changes how the session asks from now on ("Always allow", "Allow
 * for this session"): the reach of each such option is said before it is
 * pressed, not explained after.
 *
 * Pi's project-trust prompt is the other surface this element is claimed for;
 * it lives in `components/shell/TrustDialog.tsx`, outside this lane.
 *
 * Divergences from the registry copy:
 *   - Scopes are the payload's own options (R12a), not a fixed
 *     Deny / This session / Always. Which ones widen scope is judged by
 *     `isModeChangingOption`, the one judgement the surface makes.
 *   - "This grants" lists what each scope-widening option does, in words.
 *   - No `scope` state after the answer: the decision closes.
 *   - No card chrome; the surface supplies it.
 */
import { KeyRound } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DecisionHeader, type DecisionHeaderProps } from "./approval-card.js";
import { mono } from "./surfaces.js";

export interface GrantOption {
  label: string;
  /** Answering with this changes how the session asks from now on. */
  modeChanging: boolean;
}

export type PermissionGrantProps = Omit<ComponentProps<"div">, "children" | "title"> &
  DecisionHeaderProps & {
    touch: boolean;
    busy: boolean;
    options: readonly GrantOption[];
    onGrant(option: string): void;
    /** The rejection's label; opens the reason field. Absent → a plain Cancel. */
    declineLabel?: string | undefined;
    onDecline?: (() => void) | undefined;
    onCancel(): void;
  };

export function PermissionGrant({
  titleId,
  eyebrow,
  title,
  message,
  secondsLeft,
  icon = KeyRound,
  large,
  touch,
  busy,
  options,
  onGrant,
  declineLabel,
  onDecline,
  onCancel,
  className,
  ...props
}: PermissionGrantProps) {
  const size = touch ? ("lg" as const) : ("sm" as const);
  const widening = options.filter((o) => o.modeChanging);
  return (
    <div data-slot="permission-grant" className={cn("flex flex-col gap-3", className)} {...props}>
      <DecisionHeader titleId={titleId} eyebrow={eyebrow} title={title} message={message} secondsLeft={secondsLeft} icon={icon} large={large} />

      {widening.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={cn(mono, "text-ink-3")}>this grants</span>
          {widening.map((o) => (
            <span key={o.label} className="flex items-baseline gap-2 text-xs leading-xs text-ink-2">
              <span aria-hidden="true" className="size-1 shrink-0 translate-y-[-1px] rounded-full bg-attention" />
              <span className="min-w-0">
                <span className="font-medium text-ink">{o.label}</span> — changes how this session asks from now on
              </span>
            </span>
          ))}
        </div>
      )}

      <div className={cn("flex gap-2", touch ? "flex-col" : "flex-wrap")} role="group" aria-label={title}>
        {options.map((o, i) => (
          <Button
            key={`${i}-${o.label}`}
            variant="outline"
            size={size}
            data-option
            disabled={busy}
            onClick={() => onGrant(o.label)}
            className={cn(
              o.modeChanging && "border-[color-mix(in_oklab,var(--attention)_45%,var(--line))]",
              touch && "h-auto min-h-12 w-full py-2.5 text-start text-base whitespace-normal",
            )}
          >
            <span className={cn(touch && "w-full wrap-break-word")}>{o.label}</span>
          </Button>
        ))}
        {/* Focus rests on the way out, never on a grant: on a security
            question Enter must not be the keystroke that says yes. Arrows walk
            into the options from here (`DecisionBody`'s roving handler). */}
        {declineLabel && onDecline ? (
          <Button variant="ghost" size={size} data-autofocus className={cn(touch && "h-11 text-base text-ink-2")} onClick={onDecline}>
            {declineLabel}
          </Button>
        ) : (
          <Button variant="ghost" size={size} data-autofocus className={cn(touch && "h-11 text-base text-ink-2")} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
