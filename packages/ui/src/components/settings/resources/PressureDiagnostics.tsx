"use client";

import type { MemoryPressureInput, MemoryPressureLevelState, ResourceSnapshot } from "@lasercode/protocol";

import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { NumberTicker } from "@/components/assistant-ui/elements/number-ticker";
import { SpecSheet, type SpecRow } from "@/components/assistant-ui/elements/spec-sheet";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatElapsed } from "@/format";
import { useRendererPressure } from "@/runtime";

import {
  displayMetric,
  localPressureRole,
  measureCell,
  pressureActionView,
  pressureCoverage,
  pressureHostState,
  pressureInputLabel,
  PRESSURE_LEVEL_LABELS,
  PRESSURE_ROLE_LABELS,
  pressureRefusalViews,
  type PressureRoleView,
} from "./model.js";

function pressureBadgeVariant(level: MemoryPressureLevelState): "ok" | "attention" | "danger" | "outline" {
  if (level === "normal") return "ok";
  if (level === "warning") return "attention";
  if (level === "critical") return "danger";
  return "outline";
}

function pressureInputValue(input: MemoryPressureInput): string {
  const value = displayMetric(measureCell(input.value), true);
  if (input.value.status !== "available" || input.warningBytes === undefined || input.criticalBytes === undefined) return value;
  const direction = input.kind === "machine_available" ? "below" : "at";
  return `${value} · tight ${direction} ${formatBytes(input.warningBytes)} · critical ${direction} ${formatBytes(input.criticalBytes)}`;
}

function pressureRoleRows(role: PressureRoleView): SpecRow[] {
  return [
    { label: "Coverage", value: pressureCoverage(role), wrap: true },
    ...role.details.map((row) => ({ ...row, emphasis: row.label === "Local reading", wrap: true })),
    ...(role.sampleAgeMs === undefined ? [] : [{ label: "Newest reading", value: `${formatElapsed(role.sampleAgeMs)} old` }]),
    ...role.inputs.map((input) => ({
      label: pressureInputLabel(role.role, input.kind),
      value: pressureInputValue(input),
      typed: input.value.status === "available",
      wrap: true,
    })),
    ...(role.ceiling?.configuredBytes === undefined ? [] : [{ label: "Configured limit", value: formatBytes(role.ceiling.configuredBytes), typed: true }]),
    ...(role.ceiling?.measuredLimit === undefined ? [] : [{
      label: "Measured limit",
      value: displayMetric(measureCell(role.ceiling.measuredLimit), true),
      typed: role.ceiling.measuredLimit.status === "available",
      wrap: true,
    }]),
  ];
}

function PressureRoleCard({ role }: { role: PressureRoleView }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-pressure-role={role.role}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-ink">{PRESSURE_ROLE_LABELS[role.role]}</h4>
        <Badge variant={pressureBadgeVariant(role.level)}>{PRESSURE_LEVEL_LABELS[role.level]}</Badge>
      </div>
      <SpecSheet bare className="mt-3" rows={pressureRoleRows(role)} />
    </div>
  );
}

interface PressureActionRow {
  id: string;
  action: string;
  result: string;
  reason: string;
  age: string;
}

const PRESSURE_ACTION_COLUMNS: readonly DataTableColumn<PressureActionRow>[] = [
  { key: "action", label: "Action", render: (row) => <span className="font-medium text-ink">{row.action}</span> },
  { key: "result", label: "Result", render: (row) => <span>{row.result}</span> },
  { key: "reason", label: "Why", render: (row) => <span className="whitespace-normal text-ink-2">{row.reason}</span> },
  { key: "age", label: "When", align: "end", render: (row) => <span className="typed text-ink-2">{row.age}</span> },
];

export function PressureDiagnostics({ summary }: { summary: ResourceSnapshot["pressure"] }) {
  const windowState = useRendererPressure();
  const host = pressureHostState(summary);
  const windowRole = localPressureRole(windowState);
  const roles = [...host.roles, windowRole];
  const refusals = pressureRefusalViews(host.refusing, windowState.refusing);
  const actionRows = windowState.rows.slice(0, 8).map((row, index): PressureActionRow => {
    const view = pressureActionView(row);
    const released = view.released
      ? [view.released.count === undefined ? undefined : `${view.released.count.toLocaleString()} items`, view.released.bytes === undefined ? undefined : formatBytes(view.released.bytes)]
          .filter((part): part is string => part !== undefined)
          .join(" · ")
      : undefined;
    return {
      id: `${row.atMs}-${row.action}-${index}`,
      action: view.label,
      result: released ? `${view.outcome} · ${released}` : view.outcome,
      reason: view.reason,
      age: `${formatElapsed(Math.max(0, Date.now() - row.atMs))} ago`,
    };
  });

  return (
    <section data-section="memory-pressure" aria-labelledby="resource-pressure-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="resource-pressure-title" className="text-sm font-semibold text-ink">Memory pressure</h3>
          <p className="mt-0.5 max-w-180 text-xs leading-5 text-ink-2">
            The application state combines the host, this computer and project workers. This window measures and protects itself separately.
          </p>
          <p className="mt-0.5 max-w-180 text-xs leading-5 text-ink-3">
            Updates may be combined while this window catches up. Refresh reads the current state again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={pressureBadgeVariant(host.level)}>Application · {host.available ? PRESSURE_LEVEL_LABELS[host.level] : "Not available"}</Badge>
          <Badge variant={pressureBadgeVariant(windowState.effective)}>This window · {PRESSURE_LEVEL_LABELS[windowState.effective]}</Badge>
        </div>
      </div>

      {!host.available ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-5">
          <p className="text-sm font-medium text-ink">Application pressure is not available</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">This host did not include pressure state in its latest sample. It is not shown as normal.</p>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {roles.map((role) => <PressureRoleCard key={role.role} role={role} />)}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-3">
          <h4 className="text-sm font-medium text-ink">Retained host journal</h4>
          {host.totals ? (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <PressureTotal label="Actions" value={host.totals.events} />
              <PressureTotal label="Items released" value={host.totals.released.count} />
              <PressureTotal label="Bytes released" value={formatBytes(host.totals.released.bytes)} />
              <PressureTotal label="Refusals" value={host.totals.refusals} />
            </div>
          ) : (
            <p className="mt-2 text-xs leading-5 text-ink-2">Journal totals are not available from this host.</p>
          )}
          <p className="mt-3 text-xs leading-5 text-ink-3">Only totals are carried in each history sample; action rows are retained once in the host journal.</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <h4 className="text-sm font-medium text-ink">This window’s bounded history</h4>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PressureTotal label="Passes" value={windowState.totals.passes} />
            <PressureTotal label="Items released" value={windowState.totals.released.count} />
            <PressureTotal label="Bytes released" value={formatBytes(windowState.totals.released.bytes)} />
            <PressureTotal label="Refusals" value={windowState.totals.refusals} />
          </div>
          <p className="mt-3 text-xs leading-5 text-ink-3">The latest local action reasons stay only in this window and reset when its environment changes.</p>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface p-3">
        <h4 className="text-sm font-medium text-ink">Active protections</h4>
        {refusals.length > 0 ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {refusals.map((refusal) => (
              <div key={refusal.kind} className="rounded-lg bg-surface-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="attention">Paused</Badge>
                  <p className="text-sm font-medium text-ink">{refusal.label}</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-ink-2">{refusal.guidance}</p>
                <p className="mt-1 text-xs text-ink-3">Protected by {refusal.owners}.</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs leading-5 text-ink-2">No heavy reads or new work are paused for memory right now.</p>
        )}
      </div>

      {actionRows.length > 0 ? (
        <DataTable
          data-section="pressure-actions"
          columns={PRESSURE_ACTION_COLUMNS}
          rows={actionRows}
          rowKey={(row) => row.id}
          caption="Latest memory-pressure actions in this window"
          minWidth="38rem"
        />
      ) : (
        <div className="rounded-xl border border-line bg-surface px-4 py-5">
          <p className="text-sm font-medium text-ink">No local release actions yet</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">This window will record a reason here when it releases rebuildable state or pauses a heavy read.</p>
        </div>
      )}
    </section>
  );
}

function PressureTotal({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <NumberTicker value={typeof value === "number" ? value.toLocaleString() : value} label={label} className="typed mt-0.5 text-ink" />
    </div>
  );
}
