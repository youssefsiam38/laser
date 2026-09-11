"use client";
/**
 * Tools (docs/mcp.md "Inspecting" → *Tools*): every tool the server
 * advertises, searchable, each with its description and its input schema as a
 * compact shape. Three choices per tool, in a person's words:
 *
 *   - **On** — the tool exists at all (`exclude`).
 *   - **Direct** — it is in the model's own list rather than reached through
 *     the server's search-and-call tool (`only`, and only when the server is
 *     set to direct).
 *   - **Ask first** — a call waits for the person (`approve`).
 *
 * Each change is one `mcp/save` of the whole configuration, applied straight
 * away in the page and rolled back if the write fails.
 */
import type { McpInspection, McpServerConfig, McpToolPolicy } from "@lasercode/protocol";
import { useMemo, useState } from "react";

import { JsonViewer } from "@/components/assistant-ui/elements/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { SearchInput } from "../SettingsScreen.js";

import {
  allToolsDirect,
  allToolsOff,
  allToolsOn,
  isToolApproved,
  isToolDirect,
  isToolEnabled,
  policyOf,
  schemaToShape,
  setToolApproved,
  setToolDirect,
  setToolEnabled,
  toolVisibilityNote,
} from "./model.js";

export function McpToolsPanel({
  config,
  inspection,
  busy,
  onPolicy,
}: {
  config: McpServerConfig;
  inspection: McpInspection;
  busy: boolean;
  /** One whole policy per change; the caller saves it and rolls back on failure. */
  onPolicy: (policy: McpToolPolicy) => void;
}) {
  const [filter, setFilter] = useState("");
  const policy = policyOf(config);
  const names = useMemo(() => inspection.tools.map((tool) => tool.originalName), [inspection.tools]);
  const query = filter.trim().toLowerCase();
  const shown = inspection.tools.filter(
    (tool) => !query || `${tool.originalName} ${tool.name} ${tool.description}`.toLowerCase().includes(query),
  );
  const onDemand = policy.exposure !== "direct";

  if (!inspection.tools.length) {
    return <p className="text-sm leading-6 text-ink-2">This server advertises no tools.</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SearchInput value={filter} onChange={setFilter} placeholder="Find a tool…" />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onPolicy(allToolsOn(policy))}>
          All on
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onPolicy(allToolsOff(policy, names))}>
          All off
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onPolicy(allToolsDirect(policy))}>
          All direct
        </Button>
      </div>

      {policy.approve === true && (
        <p className="text-sm leading-6 text-attention">This server asks before every call, so each tool below is set to ask.</p>
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((tool) => {
          const shape = schemaToShape(tool.inputSchema);
          const enabled = isToolEnabled(policy, tool.originalName);
          const note = toolVisibilityNote(policy, tool.originalName);
          return (
            <li
              key={tool.name}
              data-slot="mcp-tool-row"
              data-tool={tool.originalName}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface p-3"
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-ink">{tool.title ?? tool.originalName}</span>
                <span className="typed min-w-0 truncate text-ink-3" title={tool.name}>
                  {tool.name}
                </span>
                {tool.annotations?.readOnly && <Badge variant="outline">reads only</Badge>}
                {tool.annotations?.destructive && <Badge variant="attention">changes things</Badge>}
              </div>
              {tool.description && <p className="text-sm leading-6 text-ink-2">{tool.description}</p>}
              {shape ? (
                <p className="typed break-words text-ink-3">{shape}</p>
              ) : tool.inputSchema ? (
                <JsonViewer value={tool.inputSchema} expandedDepth={1} />
              ) : null}
              {note && <p className="text-xs leading-5 text-ink-3">{note}</p>}
              <div className="flex flex-wrap items-center gap-4">
                <ToolSwitch
                  label="On"
                  hint="The model can use it."
                  checked={enabled}
                  disabled={busy}
                  onChange={(next) => onPolicy(setToolEnabled(policy, tool.originalName, next))}
                  name={tool.originalName}
                />
                <ToolSwitch
                  label="Direct"
                  hint={onDemand ? "This server is set to on demand, so nothing is in the model’s list." : "In the model’s own list."}
                  checked={isToolDirect(policy, tool.originalName)}
                  disabled={busy || onDemand || !enabled}
                  onChange={(next) => onPolicy(setToolDirect(policy, tool.originalName, next, names))}
                  name={tool.originalName}
                />
                <ToolSwitch
                  label="Ask first"
                  hint={policy.approve === true ? "Every call asks" : "A call waits for you."}
                  checked={isToolApproved(policy, tool.originalName)}
                  disabled={busy || policy.approve === true}
                  onChange={(next) => onPolicy(setToolApproved(policy, tool.originalName, next))}
                  name={tool.originalName}
                />
              </div>
            </li>
          );
        })}
        {!shown.length && <li className="text-sm text-ink-2">No tool matches “{filter}”.</li>}
      </ul>
    </div>
  );
}

function ToolSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
  name,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  name: string;
}) {
  return (
    <span className="flex items-center gap-2" title={hint}>
      <SettingsSwitch checked={checked} disabled={disabled} aria-label={`${label} · ${name}`} onCheckedChange={onChange} />
      <span className={disabled ? "text-sm text-ink-3" : "text-sm text-ink-2"}>{label}</span>
    </span>
  );
}
