"use client";
/**
 * The list (docs/mcp.md "The list"): one row per server visible to this
 * project, the project's own first, drawn by the restyled `mcp-server-panel`
 * element. The rows say everything a person asked at a glance — what it is,
 * whether it works, how much of it the model sees, and which scope it lives
 * in — and open the inspector for everything else.
 */
import type { McpScope, McpServerState } from "@lasercode/protocol";

import { McpServerPanel, type McpServerPanelRow } from "@/components/assistant-ui/elements/mcp-server-panel";

import { rowKey, scopeLabel, scopeNote, statusWords, toolCountLabel, transportSummary } from "./model.js";

export function toPanelRow(state: McpServerState): McpServerPanelRow {
  const status = statusWords(state.status);
  const transport = transportSummary(state.config.transport);
  return {
    id: rowKey(state),
    name: state.config.label?.trim() || state.config.name,
    transport: transport.text,
    transportKind: transport.kind,
    transportFull: transport.full,
    statusLabel: status.label,
    statusHelp: status.help,
    tone: status.tone,
    working: status.working,
    tools: toolCountLabel(state),
    scope: scopeLabel(state.scope),
    note: scopeNote(state),
    detail: state.detail,
    needsAuth: state.status === "needs-auth",
    dimmed: state.shadowed || state.status === "off",
  };
}

export function McpServerList({
  servers,
  selectedId,
  onSelect,
  onSignIn,
}: {
  servers: readonly McpServerState[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
  onSignIn: (id: string) => void;
}) {
  const groups: Array<{ scope: McpScope; rows: McpServerPanelRow[] }> = [
    { scope: "project", rows: servers.filter((entry) => entry.scope === "project").map(toPanelRow) },
    { scope: "global", rows: servers.filter((entry) => entry.scope === "global").map(toPanelRow) },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <McpServerPanel
            key={group.scope}
            data-scope={group.scope}
            heading={scopeLabel(group.scope)}
            rows={group.rows}
            selectedId={selectedId}
            onSelect={onSelect}
            onSignIn={onSignIn}
          />
        ))}
    </div>
  );
}
