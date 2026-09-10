import type { ModelRef } from "@lasercode/protocol";
import { useRef, useState } from "react";
import { Bot } from "lucide-react";

import { agentDisplayName } from "@/agents/model";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Persisted agent definition and model metadata; disclosure only, never a picker. */
export function SessionIdentity({ agentName, model }: { agentName: string | undefined; model: ModelRef | null }) {
  const [detailOpen, setDetailOpen] = useState(false);
  // Pointer focus precedes click on touch. Do not let that focus pre-open the
  // disclosure and turn the same gesture into Radix's closing click.
  const pointerFocus = useRef(false);
  const label = agentName === undefined ? undefined : agentDisplayName(agentName);
  if (label === undefined && model === null) return null;
  return (
    <div data-slot="session-identity" className={cn("me-1.5 flex min-w-0 items-center gap-1.5", label === undefined && "hidden @4xl/topbar:flex")}>
      {label !== undefined ? (
        <Popover open={detailOpen} onOpenChange={setDetailOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-slot="session-agent-identity"
              aria-label={`Session agent: ${label}. Show full name`}
              aria-expanded={detailOpen}
              onPointerDown={() => { pointerFocus.current = true; }}
              onPointerCancel={() => { pointerFocus.current = false; }}
              onClick={() => { queueMicrotask(() => { pointerFocus.current = false; }); }}
              onPointerEnter={(event) => { if (event.pointerType === "mouse") setDetailOpen(true); }}
              onPointerLeave={(event) => { if (event.pointerType === "mouse") setDetailOpen(false); }}
              onFocus={() => { if (!pointerFocus.current) setDetailOpen(true); }}
              onBlur={() => setDetailOpen(false)}
              onKeyDown={(event) => { if (event.key === "Escape") setDetailOpen(false); }}
              className="flex h-7 min-w-0 max-w-20 items-center gap-1 rounded-md font-mono text-xs text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11 @xl/topbar:max-w-40"
            >
              <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            data-slot="session-agent-detail"
            side="bottom"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="w-auto max-w-80 break-words rounded-md px-2 py-1 text-xs font-medium leading-4"
          >
            Agent: {label}
          </PopoverContent>
        </Popover>
      ) : null}
      {label !== undefined && model !== null ? <span aria-hidden="true" className="hidden text-xs text-ink-3 @4xl/topbar:inline">·</span> : null}
      {model !== null ? (
        <span data-slot="session-model-identity" className="hidden max-w-40 truncate font-mono text-xs text-ink-3 @4xl/topbar:inline" title={`${model.provider}/${model.id}`}>
          {model.id}
        </span>
      ) : null}
    </div>
  );
}
