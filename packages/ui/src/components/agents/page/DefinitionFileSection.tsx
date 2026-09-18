"use client";
import type { AgentDefinition, AgentLocation } from "@lasercode/protocol";
import { Check, Clipboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useCopy } from "@/hooks/use-copy";
import { Hint } from "./fields.js";
import { projectFolderName } from "./model.js";

export function DefinitionDestination({ location }: { location: AgentLocation }) {
  return (
    <div data-slot="agent-definition-destination" className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="min-w-0">
        <span className="block min-w-0 truncate text-sm font-medium text-ink">
          {location.scope === "project" ? `Project · ${projectFolderName(location.projectCwd)}` : "Global"}
        </span>
        <span className="block text-xs leading-5 text-ink-3">
          {location.scope === "project" ? "This definition will belong to the selected project." : "This definition will be available in every project."}
        </span>
      </span>
      <Badge variant="outline" className="shrink-0">Fixed</Badge>
    </div>
  );
}

export function splitDefinitionPath(path: string): { start: string; end: string } {
  const tailLength = 22;
  if (path.length <= tailLength) return { start: "", end: path };
  return { start: path.slice(0, -tailLength), end: path.slice(-tailLength) };
}

export function DefinitionLocation({ agent }: { agent: AgentDefinition }) {
  const { copied, copy } = useCopy();
  const path = agent.path;
  const parts = path ? splitDefinitionPath(path) : undefined;
  return (
    <div data-slot="agent-definition-location" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
        <span className="min-w-0">
          <span className="block min-w-0 truncate text-sm font-medium text-ink">{agent.scope === "project" ? `This project · ${projectFolderName(agent.projectCwd ?? "Project")}` : "Global"}</span>
          <span className="block text-xs leading-5 text-ink-3">{agent.scope === "project" ? "Only this project can use it." : "Every project can use it."}</span>
        </span>
        <Badge variant="outline" className="shrink-0">Read only</Badge>
      </div>
      {path && parts ? (
        <div data-slot="agent-definition-path" className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <code
            dir="ltr"
            aria-label={`Definition file: ${path}`}
            className="typed flex min-w-0 flex-1 items-baseline overflow-hidden text-start text-ink-2 tnum"
          >
            {parts.start ? <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{parts.start}</span> : null}
            <span aria-hidden="true" className="shrink-0 whitespace-nowrap">{parts.end}</span>
          </code>
          <TooltipIconButton
            type="button"
            tooltip={copied ? "Definition path copied" : "Copy definition path"}
            size="icon-sm"
            onClick={() => void copy(path)}
          >
            {copied ? <Check /> : <Clipboard />}
          </TooltipIconButton>
        </div>
      ) : (
        <Hint>The definition file path is not available from this host yet.</Hint>
      )}
      <Hint>Editing the Markdown file is the same as saving changes here.</Hint>
    </div>
  );
}
