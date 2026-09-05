"use client";
/**
 * The settings form: sections on the left, fields on the right, one scope at a
 * time. Three views share it — the two scopes, and "Effective", which is the
 * read-only diff of what Pi will actually use and where each value came from.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { useId, useMemo, useState } from "react";
import { ChevronRight, FileJson, Info, RotateCcw, ShieldAlert, Terminal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SettingChange, SettingDescriptor, SettingsCatalog, SettingsScope, SettingsSnapshot } from "@piorbit/protocol";

import { SettingField } from "./fields.js";
import { JsonView } from "./JsonView.js";
import { effectiveDiff, getAtPath, rowFor, searchFields, sectionsWithFields, type FieldRow } from "./model.js";
import { OriginBadge, SearchInput } from "./SettingsScreen.js";

type View = SettingsScope | "effective";

export interface SettingsFormProps {
  catalog: SettingsCatalog;
  snapshot: SettingsSnapshot;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

export function SettingsForm({ catalog, snapshot, onApply }: SettingsFormProps) {
  const [view, setView] = useState<View>("global");
  const [section, setSection] = useState<string>(catalog.sections[0]?.id ?? "model");
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [json, setJson] = useState(false);

  const scope: SettingsScope = view === "project" ? "project" : "global";
  const searching = query.trim() !== "";

  const visible = useMemo(() => {
    let fields = catalog.fields.filter((field) => field.scopes.includes(scope));
    if (!showAdvanced) fields = fields.filter((field) => !field.advanced);
    return searchFields(fields, query);
  }, [catalog.fields, scope, showAdvanced, query]);

  const sections = useMemo(() => sectionsWithFields(catalog, visible), [catalog, visible]);
  const activeSection = sections.some((s) => s.id === section) ? section : (sections[0]?.id ?? "");
  const shown = searching ? visible : visible.filter((field) => field.section === activeSection);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 hairline-b">
        <ScopeSwitch view={view} onChange={setView} />
        {view !== "effective" && (
          <>
            <SearchInput value={query} onChange={setQuery} placeholder="Search settings" className="w-56" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-pressed={showAdvanced}
              className={cn(showAdvanced && "bg-surface-2 text-ink")}
            >
              Advanced
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setJson((v) => !v)}
              aria-pressed={json}
              className={cn("ms-auto gap-1.5", json && "bg-surface-2 text-ink")}
            >
              <FileJson /> JSON
            </Button>
          </>
        )}
      </div>

      {view === "project" && <ProjectTrustNotice snapshot={snapshot} />}

      {view === "effective" ? (
        <EffectiveView catalog={catalog} snapshot={snapshot} />
      ) : json ? (
        <JsonView catalog={catalog} snapshot={snapshot} scope={scope} onApply={onApply} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {!searching && (
            <nav aria-label="Setting sections" className="hidden w-56 shrink-0 hairline-r md:block">
              <ScrollArea className="h-full">
                <ul className="flex flex-col gap-0.5 p-2">
                  {sections.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => setSection(entry.id)}
                        aria-current={entry.id === activeSection ? "true" : undefined}
                        className={cn(
                          "flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-start text-sm",
                          "outline-none transition-colors duration-(--motion-instant)",
                          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                          entry.id === activeSection
                            ? "bg-surface-2 font-medium text-ink"
                            : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        <ChevronRight
                          className={cn("size-3.5 shrink-0 text-ink-3", entry.id !== activeSection && "opacity-0")}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </nav>
          )}

          <ScrollArea className="min-w-0 flex-1">
            <div className="mx-auto flex max-w-200 flex-col gap-1 px-4 py-4">
              {/* Under `md` the section rail is hidden, so the sections travel
                  as a scrolling chip row — without it a phone could only ever
                  see the first section. */}
              {!searching && sections.length > 1 && (
                <div className="-mx-4 mb-3 flex gap-1 overflow-x-auto px-4 pb-1 md:hidden scrollbar-none">
                  {sections.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSection(entry.id)}
                      aria-current={entry.id === activeSection ? "true" : undefined}
                      className={cn(
                        "shrink-0 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap outline-none",
                        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                        entry.id === activeSection
                          ? "border-transparent bg-surface-2 font-medium text-ink"
                          : "border-line text-ink-2",
                      )}
                    >
                      {entry.title}
                    </button>
                  ))}
                </div>
              )}
              {!searching && (
                <SectionHeading section={sections.find((s) => s.id === activeSection)} />
              )}
              {searching && (
                <p className="pb-2 text-xs text-ink-3">
                  {shown.length} setting{shown.length === 1 ? "" : "s"} match “{query.trim()}”
                </p>
              )}
              {shown.length === 0 && (
                <p className="py-8 text-center text-sm text-ink-2">
                  Nothing matches. {showAdvanced ? "" : "Advanced settings are hidden — turn them on to widen the search."}
                </p>
              )}
              {shown.map((field) => (
                <FieldRowView
                  key={field.path}
                  field={field}
                  snapshot={snapshot}
                  scope={scope}
                  showSection={searching}
                  catalog={catalog}
                  onApply={onApply}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function ScopeSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: Array<{ id: View; label: string; hint: string }> = [
    { id: "global", label: "Global", hint: "Your settings, in every project on this machine" },
    { id: "project", label: "Project", hint: "Settings that ship with this directory, and apply only here" },
    { id: "effective", label: "Effective", hint: "What the agent will use, and which file it came from" },
  ];
  return (
    <div role="tablist" aria-label="Settings scope" className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((option) => (
        <Tooltip key={option.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="tab"
              aria-selected={view === option.id}
              onClick={() => onChange(option.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium outline-none transition-colors duration-(--motion-instant)",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                view === option.id ? "bg-surface text-ink" : "text-ink-2 hover:text-ink",
              )}
            >
              {option.label}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{option.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function SectionHeading({ section }: { section: SettingsCatalog["sections"][number] | undefined }) {
  if (!section) return null;
  return (
    <header className="pb-3">
      <h2 className="text-sm font-semibold text-ink">{section.title}</h2>
      <p className="mt-0.5 max-w-140 text-xs leading-5 text-ink-2">{section.description}</p>
    </header>
  );
}

/**
 * Pi ignores a project settings file it has not been told to trust. When that
 * is the case the form still works — the file is real and editable — but says
 * plainly that nothing in it is taking effect, and offers the one fix piorbit
 * can make from here.
 */
function ProjectTrustNotice({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { trusted, writable, reason } = snapshot.projectTrust;
  // Always shown, because "this file exists and Pi ignores it" is exactly the
  // state a settings screen must never leave you guessing about — and the state
  // you land in the moment you create a project settings file.
  const tone = !writable ? "danger" : !trusted ? "attention" : "quiet";
  const title = !writable
    ? "This project's settings are read-only"
    : !trusted
      ? "This project's settings are not being used"
      : "Project settings and trust";
  return (
    <div
      className={cn(
        "mx-3 mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "danger" && "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
        tone === "attention" && "bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] text-attention",
        tone === "quiet" && "bg-surface-2 text-ink-2",
      )}
    >
      <ShieldAlert className={cn("mt-0.5 size-4 shrink-0", tone === "quiet" && "text-ink-3")} />
      <div className="min-w-0">
        <p className={cn("font-medium", tone === "quiet" && "text-ink")}>{title}</p>
        <p className="mt-0.5 leading-5 opacity-90">{reason}</p>
        <p className="mt-1 font-mono text-xs leading-4 opacity-80">{snapshot.project.path}</p>
      </div>
    </div>
  );
}

function FieldRowView({
  field,
  snapshot,
  scope,
  showSection,
  catalog,
  onApply,
}: {
  field: SettingDescriptor;
  snapshot: SettingsSnapshot;
  scope: SettingsScope;
  showSection: boolean;
  catalog: SettingsCatalog;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}) {
  const controlId = useId();
  const row = rowFor(field, snapshot);
  const scoped = scope === "global" ? row.global : row.project;
  const writable = !field.managed && (scope === "global" || snapshot.projectTrust.writable);
  const section = catalog.sections.find((s) => s.id === field.section);

  return (
    <div className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 sm:flex-row sm:gap-6">
      <div className="min-w-0 sm:w-72 sm:shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={controlId} className="text-sm font-medium text-ink">
            {field.label}
          </label>
          {field.managed && <Badge variant="outline">managed by the agent</Badge>}
          {field.terminalOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="default" className="gap-1">
                  <Terminal /> terminal
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                This setting only applies when the agent runs in a terminal. {PRODUCT_NAME} does not read it, so changing it
                will not change how this app looks.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="mt-0.5 font-mono text-xs text-ink-3">
          {showSection && section ? `${section.title} · ` : ""}
          {field.path}
        </p>
        <p className="mt-1 text-xs leading-5 text-ink-2">{field.description}</p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <SettingField
          field={field}
          id={controlId}
          value={scoped}
          disabled={!writable}
          onCommit={(value) =>
            void onApply(scope, [
              value === undefined ? { path: field.path, op: "unset" } : { path: field.path, op: "set", value },
            ])
          }
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {scoped === undefined ? (
            <span className="inline-flex items-center gap-1">
              <Info className="size-3" />
              not set here · effective: <ValueChip value={row.effective ?? field.default} /> <OriginBadge origin={row.origin} />
            </span>
          ) : (
            <>
              {scope === "global" && row.project !== undefined && (
                <span className="inline-flex items-center gap-1 text-attention">
                  the project file overrides this with <ValueChip value={row.project} />
                </span>
              )}
              {field.default !== undefined && (
                <span>
                  Default: <ValueChip value={field.default} />
                </span>
              )}
              {writable && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1"
                  onClick={() => void onApply(scope, [{ path: field.path, op: "unset" }])}
                >
                  <RotateCcw /> Unset
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ValueChip({ value }: { value: unknown }) {
  if (value === undefined) return <span className="font-mono text-ink-3">—</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <code className="rounded bg-surface-2 px-1 font-mono text-xs text-ink-2">
      {text.length > 60 ? `${text.slice(0, 59)}…` : text}
    </code>
  );
}

/** Read-only table: what Pi will use, and which file decided it. */
function EffectiveView({ catalog, snapshot }: { catalog: SettingsCatalog; snapshot: SettingsSnapshot }) {
  const rows = useMemo(() => effectiveDiff(catalog, snapshot), [catalog, snapshot]);
  const unknownKeys = useMemo(() => {
    const known = new Set(catalog.topLevelKeys);
    const seen = new Set([...Object.keys(snapshot.global.values), ...Object.keys(snapshot.project.values)]);
    return [...seen].filter((key) => !known.has(key));
  }, [catalog.topLevelKeys, snapshot]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-240 flex-col gap-3 px-4 py-4">
        <p className="text-xs leading-5 text-ink-2">
          Everything either file sets, and what the agent ends up using. Nested objects merge; arrays replace whole.
          {snapshot.projectTrust.trusted
            ? ""
            : " Project values are shown but greyed out — the agent is not loading that file (see the Project tab)."}
        </p>

        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-2">
            Neither settings file sets anything. The agent is running entirely on its defaults.
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-160 border-collapse text-sm">
              <thead>
                <tr className="eyebrow bg-surface-2 text-start">
                  <th className="px-3 py-2 text-start font-medium">Setting</th>
                  <th className="px-3 py-2 text-start font-medium">Global</th>
                  <th className="px-3 py-2 text-start font-medium">Project</th>
                  <th className="px-3 py-2 text-start font-medium">Effective</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <EffectiveRow key={row.field.path} row={row} trusted={snapshot.projectTrust.trusted} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {unknownKeys.length > 0 && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2">
            <p className="font-medium text-ink">Keys {PRODUCT_NAME} does not recognise</p>
            <p className="mt-0.5">
              These are in a settings file, but the agent ({catalog.piVersion}) does not define them. {PRODUCT_NAME} leaves
              them exactly as they are and never rewrites them:{" "}
              <span className="font-mono text-ink-2">{unknownKeys.join(", ")}</span>
            </p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function EffectiveRow({ row, trusted }: { row: FieldRow; trusted: boolean }) {
  const projectWins = row.project !== undefined && trusted;
  return (
    <tr className="border-t border-line align-top">
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-ink">{row.field.path}</span>
        <p className="mt-0.5 text-xs text-ink-3">{row.field.label}</p>
      </td>
      <td className={cn("px-3 py-2", projectWins && "opacity-50")}>
        <ValueChip value={row.global} />
      </td>
      <td className={cn("px-3 py-2", !trusted && "opacity-40")}>
        <ValueChip value={row.project} />
        {!trusted && row.project !== undefined && <p className="mt-0.5 text-xs text-ink-3">ignored (untrusted)</p>}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <ValueChip value={row.effective ?? row.field.default} />
          <OriginBadge origin={row.origin} />
        </div>
      </td>
    </tr>
  );
}

export { getAtPath };
