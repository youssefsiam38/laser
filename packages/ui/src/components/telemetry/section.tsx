import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function InstrumentCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-line bg-surface-2/70 p-3", className)}>{children}</div>;
}

/**
 * One telemetry section. The header number stays visible while collapsed so
 * the fold still informs (leap §4.2).
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
  icon: LucideIcon;
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
        <div className="flex min-h-11 items-center gap-1 pe-3 ps-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-slot="telemetry-section-trigger"
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenChange(!open);
              }}
              className="group -ms-1 flex h-full min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md ps-1 text-start outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
            >
              <ChevronRight
                className="rtl:-scale-x-100 size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90 group-aria-expanded:rtl:-rotate-90"
                aria-hidden="true"
              />
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="eyebrow">{title}</span>
              {number ? (
                <span data-slot="telemetry-section-number" className="ms-auto min-w-0 truncate font-mono text-xs text-ink-3 tnum">
                  {number}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          {action}
        </div>
        <CollapsibleContent>
          <div className={padded ? "px-4 pb-3" : "pb-3"}>{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function ScopeBar({ text }: { text: string }) {
  return (
    <p
      data-slot="telemetry-scope"
      className="min-w-0 truncate px-4 py-2 font-mono text-xs leading-4 text-ink-2 tnum hairline-b"
      title={text}
    >
      {text}
    </p>
  );
}
