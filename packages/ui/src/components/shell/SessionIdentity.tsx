import type { ModelRef } from "@lasercode/protocol";
import { useState } from "react";
import { Bot } from "lucide-react";

import { agentDisplayName } from "@/agents/model";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Persisted agent definition and model metadata; disclosure only, never a picker. */
export function SessionIdentity({ agentName, model }: { agentName: string | undefined; model: ModelRef | null }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const label = agentName === undefined ? undefined : agentDisplayName(agentName);
  if (label === undefined && model === null) return null;
  return (
    <div data-slot="session-identity" className={cn("me-1.5 flex min-w-0 items-center gap-1.5", label === undefined && "hidden @4xl/topbar:flex")}>
      {label !== undefined ? (
        <Tooltip open={detailOpen} onOpenChange={setDetailOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-slot="session-agent-identity"
              aria-label={`Session agent: ${label}. Show full name`}
              aria-expanded={detailOpen}
              onClick={() => setDetailOpen((open) => !open)}
              onPointerEnter={(event) => { if (event.pointerType !== "touch") setDetailOpen(true); }}
              onPointerLeave={(event) => { if (event.pointerType !== "touch") setDetailOpen(false); }}
              onFocus={() => setDetailOpen(true)}
              onBlur={() => setDetailOpen(false)}
              className="flex h-7 min-w-0 max-w-20 items-center gap-1 rounded-md font-mono text-xs text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11 @xl/topbar:max-w-40"
            >
              <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent data-slot="session-agent-detail" side="bottom" className="max-w-80 break-words">
            Agent: {label}
          </TooltipContent>
        </Tooltip>
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
