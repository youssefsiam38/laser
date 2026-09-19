import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * One telemetry section: a hairline, a 32px header row and its content.
 * There is no card inside it — a bordered box whose only job is to hold a row
 * spends two borders and 24px of a 288px column on nothing (redesign P1).
 * Where a group needs a ground it uses `--surface-2` flat, never border +
 * radius + padding.
 *
 * The header number stays visible while collapsed so the fold still informs
 * (leap §4.2).
 */
export function TelemetrySection({
  id,
  title,
  icon: Icon,
  number,
  open,
  onOpenChange,
  action,
  padded = true,
  children,
}: {
  id: string;
  title: string;
  /** Optional, and never inside a circle: it labels, it does not decorate. */
  icon?: LucideIcon | undefined;
  number?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action?: ReactNode;
  /** History paints its own gutter; other sections pad. */
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <section data-slot="telemetry-section" data-section={id} className="hairline-b">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div data-slot="telemetry-section-header" className="flex h-8 items-center gap-1 pe-2 ps-3 pointer-coarse:h-11">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-slot="telemetry-section-trigger"
              className="group -ms-1 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-1 text-start outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
            >
              <ChevronRight
                className="rtl:-scale-x-100 size-3 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90 group-aria-expanded:rtl:-rotate-90"
                aria-hidden="true"
              />
              {Icon ? <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" /> : null}
              <span className="eyebrow">{title}</span>
              {number ? (
                <span data-slot="telemetry-section-number" className="ms-auto min-w-0 truncate typed text-ink">
                  {number}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          {action}
        </div>
        <CollapsibleContent>
          <div className={padded ? "px-3 pb-3" : "pb-3"}>{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * A figure in a section: its name, and its value on the same baseline at the
 * end of the row. A definition list, not a tile (redesign P7).
 */
export function Datum({
  label,
  value,
  title,
  tone = "ink",
  meter,
  slot,
}: {
  label: ReactNode;
  value: string;
  title?: string | undefined;
  tone?: "ink" | "muted" | "danger";
  /** 0–1 share drawn as a quiet inline meter between the name and the value. */
  meter?: number | undefined;
  slot?: string | undefined;
}) {
  return (
    <div data-slot={slot} className="flex min-h-5 min-w-0 items-baseline gap-2">
      <dt
        className={cn(
          "min-w-0 truncate text-xs leading-xs",
          tone === "danger" ? "font-mono text-danger" : tone === "muted" ? "text-ink-3" : "text-ink-2",
        )}
        {...(title ? { title } : {})}
      >
        {label}
      </dt>
      {meter !== undefined ? (
        <dd className="ms-auto flex min-w-0 shrink items-baseline gap-2">
          <Meter share={meter} />
          <span className="min-w-6 shrink-0 text-end typed text-ink">{value}</span>
        </dd>
      ) : (
        <dd className="ms-auto shrink-0 typed text-ink">{value}</dd>
      )}
    </div>
  );
}

/** A quiet inline meter: ink on the ground, never the live accent (DESIGN.md). */
export function Meter({ share, className }: { share: number; className?: string | undefined }) {
  const width = Math.max(0, Math.min(1, share)) * 100;
  return (
    <span aria-hidden="true" className={cn("h-1 w-10 shrink-0 self-center overflow-hidden rounded-full bg-surface-2", className)}>
      <span className="block h-full rounded-full bg-ink-3" style={{ width: `${width}%` }} />
    </span>
  );
}

/** A sentence a figure says about itself: unknown, unavailable, empty. */
export function FigureNote({
  slot,
  kind,
  children,
}: {
  slot?: string | undefined;
  kind?: string | undefined;
  children: ReactNode;
}) {
  return (
    <p data-slot={slot} data-kind={kind} className="text-xs leading-xs text-ink-2">
      {children}
    </p>
  );
}

/**
 * What every figure below covers. It wraps rather than hiding the compaction
 * count behind an ellipsis (redesign P9).
 */
export function ScopeBar({ text }: { text: string }) {
  return (
    <p
      data-slot="telemetry-scope"
      className="min-w-0 text-balance px-3 py-1.5 typed leading-xs text-ink-2 hairline-b"
      title={text}
    >
      {text}
    </p>
  );
}
