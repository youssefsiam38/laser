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

import { catalogStatusWords, toolCatalogFresh, useCatalogClock } from "./catalog.js";
import { failedAgoPhrase, rowKey, scopeLabel, scopeNote, toolCountLabel, transportSummary } from "./model.js";

export function toPanelRow(state: McpServerState, now = Date.now()): McpServerPanelRow {
  const fresh = toolCatalogFresh(state.toolCatalog, now);
  const status = catalogStatusWords(state.status, state.toolCatalog, state.toolCount !== undefined, now);
  const counts = toolCountLabel(state);
  // A project entry that only switches a global server off carries no
  // definition of its own; the row then says so instead of a command line.
  const transport = transportSummary(state.config.transport);
  const ago = state.status === "failed" ? failedAgoPhrase(state.failedAgoSeconds) : undefined;
  const detail = state.detail && ago ? `${state.detail} (${ago})` : (state.detail ?? (ago ? `It failed ${ago}.` : undefined));
  return {
    id: rowKey(state),
    name: state.config.label?.trim() || state.config.name,
    transport: transport?.text ?? "No definition of its own",
    transportKind: transport?.kind ?? "Switched off here",
    transportFull: transport?.full ?? "This entry only switches the every-project server off.",
    statusLabel: status.label,
    statusHelp: status.help,
    tone: status.tone,
    working: status.working,
    tools: counts === undefined ? undefined : fresh ? counts : `Last listed: ${counts}`,
    scope: scopeLabel(state.scope),
    note: scopeNote(state),
    detail,
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
  onSelect?: ((id: string) => void) | undefined;
  onSignIn?: ((id: string) => void) | undefined;
}) {
  const nextExpiry = Math.min(...servers.map(server => server.toolCatalog?.expiresAt ?? 0).filter(expiry => expiry > Date.now()));
  const now = useCatalogClock(nextExpiry);
  const groups: Array<{ scope: McpScope; rows: McpServerPanelRow[] }> = [
    { scope: "project", rows: servers.filter((entry) => entry.scope === "project").map(state => toPanelRow(state, now)) },
    { scope: "global", rows: servers.filter((entry) => entry.scope === "global").map(state => toPanelRow(state, now)) },
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
            {...(onSelect ? { onSelect } : {})}
            {...(onSignIn ? { onSignIn } : {})}
          />
        ))}
    </div>
  );
}
