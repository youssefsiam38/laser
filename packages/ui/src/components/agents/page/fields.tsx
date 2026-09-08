"use client";
/**
 * The editor's building blocks: a titled section with an id a deep link can
 * land on, the two notices (a validation issue in danger, a periodic warning
 * in attention), and a checkbox row that keeps a 44px target on touch.
 */
import type { AgentWarning } from "@lasercode/protocol";
import { CircleAlert, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { sectionDomId } from "./model.js";

export interface SectionProps extends Omit<ComponentProps<"section">, "title" | "id"> {
  id: string;
  title: string;
  description?: string | undefined;
  /** Drawn between the heading and the body: warnings, then issues. */
  notices?: ReactNode;
  /** A control in the heading row (a switch, a link). */
  trailing?: ReactNode;
}

/** One field or one group of fields, with the DOM id `agent-field-<id>`. */
export function Section({ id, title, description, notices, trailing, children, className, ...props }: SectionProps) {
  const domId = sectionDomId(id);
  return (
    <section
      id={domId}
      data-slot="agent-section"
      data-field={id}
      aria-labelledby={`${domId}-title`}
      className={cn("flex scroll-mt-4 flex-col gap-2", className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${domId}-title`} className="text-sm font-semibold text-ink">
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-xs leading-5 text-ink-2">{description}</p> : null}
        </div>
        {trailing}
      </div>
      {notices}
      {children}
    </section>
  );
}

export function Hint({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs leading-5 text-ink-3", className)} {...props} />;
}

/** A validation problem at this field. Focusable so a deep link can land on it. */
export function IssueNotice({ id, messages, className }: { id?: string | undefined; messages: readonly string[]; className?: string | undefined }) {
  if (messages.length === 0) return null;
  return (
    <div
      id={id}
      role="alert"
      data-slot="agent-field-issue"
      className={cn("flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-sm text-danger", className)}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {messages.map((message, i) => (
          <p key={i}>{message}</p>
        ))}
      </div>
    </div>
  );
}

/**
 * A periodic-validation warning, anchored at the field it concerns. Focusable
 * (`tabIndex={-1}`) so `workbench.open("agents", { agent, field })` can put the
 * person exactly here.
 */
export function WarningNotice({
  warnings,
  action,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { warnings: readonly AgentWarning[]; action?: ReactNode }) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="status"
      tabIndex={-1}
      data-slot="agent-field-notice"
      className={cn(
        "flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] px-3 py-2 text-sm text-ink outline-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-attention",
        className,
      )}
      {...props}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
      <div className="min-w-0 flex-1">
        {warnings.map((warning, i) => (
          <p key={i}>
            {warning.target ? <span className="typed me-1.5 rounded-sm bg-surface px-1 text-ink">{warning.target}</span> : null}
            {warning.message}
          </p>
        ))}
        {action ? <div className="mt-1.5 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

export interface CheckRowProps extends Omit<ComponentProps<"input">, "type" | "children"> {
  label: ReactNode;
  detail?: ReactNode;
  /** The row is one a warning points at. */
  flagged?: boolean | undefined;
  trailing?: ReactNode;
}

/** A checkbox with its label and one line of detail; the whole row is the target. */
export function CheckRow({ label, detail, flagged = false, trailing, className, disabled, ...props }: CheckRowProps) {
  return (
    <label
      data-slot="agent-check-row"
      data-flagged={flagged || undefined}
      className={cn(
        "flex min-h-9 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 pointer-coarse:min-h-11",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2 has-focus-visible:outline-solid has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-live",
        flagged && "bg-[color-mix(in_oklab,var(--attention)_10%,transparent)]",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <input type="checkbox" disabled={disabled} className="mt-1 size-3.5 shrink-0 accent-live outline-none" {...props} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-ink">{label}</span>
        {detail ? (
          <span className="typed truncate text-ink-3" title={typeof detail === "string" ? detail : undefined}>
            {detail}
          </span>
        ) : null}
      </span>
      {trailing}
    </label>
  );
}
