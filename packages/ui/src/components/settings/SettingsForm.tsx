"use client";
/**
 * The settings form: sections on the left, fields on the right, one scope at a
 * time. Three views share it — the two scopes, and "Effective", which is the
 * read-only diff of what Pi will actually use and where each value came from.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, ChevronsUpDown, FolderGit2, RotateCcw, ShieldAlert, Terminal, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProviderModelMultiPicker, ProviderModelPicker, ProviderPicker, modelProvenance, modelOptionId } from "@/components/assistant-ui/elements/model-selector";
import { narrowToConnected } from "@/components/assistant-ui/elements/connected-models";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { shortCwd } from "@/format";
import { useLaserStable } from "@/runtime";
import type { ModelCatalogEntry, SettingChange, SettingDescriptor, SettingsCatalog, SettingsScope, SettingsSnapshot, ThinkingLevel } from "@lasercode/protocol";

import { SettingField } from "./fields.js";
import { effectiveDiff, getAtPath, rowFor, searchFields, sectionsWithFields, type FieldRow } from "./model.js";
import { OriginBadge, SearchInput } from "./SettingsScreen.js";

type View = SettingsScope | "effective";

export interface SettingsFormProps {
  audience: "general" | "advanced";
  cwd: string;
  catalog: SettingsCatalog;
  snapshot: SettingsSnapshot;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

export function SettingsForm({ audience, cwd, catalog, snapshot, onApply }: SettingsFormProps) {
  const { client, projects, projectInfo, setCurrentProject } = useLaserStable();
  const [view, setView] = useState<View>("global");
  const [section, setSection] = useState<string>(catalog.sections[0]?.id ?? "model");
  const [query, setQuery] = useState("");
  const [showFull, setShowFull] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{ models: ModelCatalogEntry[]; connected: ModelCatalogEntry[]; defaultProvider?: string; defaultModel?: string }>({ models: [], connected: [] });
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState<string>();

  useEffect(() => {
    let live = true;
    setModelCatalogLoading(true);
    setModelCatalogError(undefined);
    void Promise.all([
      client.request("pi/models/catalog", { cwd }),
      // The pickers below choose a model to use, so they show connected
      // providers only (D-145). The enabled-models control keeps the whole
      // catalogue: that one curates it, including for a provider not yet
      // connected.
      client.request("pi/providers/list", { cwd }).then(({ providers }) => providers, () => undefined),
    ]).then(([result, providers]) => {
      if (!live) return;
      setModelCatalog({
        models: result.models,
        connected: narrowToConnected(result.models, providers).models,
        ...(result.defaultProvider ? { defaultProvider: result.defaultProvider } : {}),
        ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
      });
    }).catch((error) => {
      if (live) {
        setModelCatalog({ models: [], connected: [] });
        setModelCatalogError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (live) setModelCatalogLoading(false);
    });
    return () => { live = false; };
  }, [client, cwd]);

  const scope: SettingsScope = view === "project" ? "project" : "global";
  const searching = query.trim() !== "";

  const visible = useMemo(() => {
    let fields = catalog.fields.filter((field) => field.audience === audience && field.scopes.includes(scope));
    if (!showFull) fields = fields.filter((field) => !field.advanced);
    return searchFields(fields, query);
  }, [audience, catalog.fields, scope, showFull, query]);

  const audienceCatalog = useMemo(() => ({ ...catalog, fields: catalog.fields.filter((field) => field.audience === audience) }), [audience, catalog]);

  const sections = useMemo(() => sectionsWithFields(catalog, visible), [catalog, visible]);
  const activeSection = sections.some((s) => s.id === section) ? section : (sections[0]?.id ?? "");
  const shown = searching ? visible : visible.filter((field) => field.section === activeSection);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 hairline-b">
        <ScopeSwitch view={view} onChange={setView} />
        {view !== "global" && (
          <ProjectTarget
            cwd={cwd}
            projects={projects}
            names={projectInfo}
            mode={view}
            onChange={setCurrentProject}
          />
        )}
        {view !== "effective" && (
          <>
            <SearchInput value={query} onChange={setQuery} placeholder="Search settings" className="w-56" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFull((v) => !v)}
              aria-pressed={showFull}
              className={cn(showFull && "bg-surface-2 text-ink")}
            >
              Full configuration
            </Button>
          </>
        )}
      </div>

      {view === "project" && <ProjectTrustNotice snapshot={snapshot} />}

      {view === "effective" ? (
        <EffectiveView catalog={audienceCatalog} snapshot={snapshot} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {!searching && (
            <nav aria-label="Setting sections" className="hidden w-56 shrink-0 hairline-e md:block">
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
                          className={cn("rtl:-scale-x-100", "size-3.5 shrink-0 text-ink-3", entry.id !== activeSection && "opacity-0")}
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
                  Nothing matches. {showFull ? "" : "Turn on Full configuration to include specialist controls in this tab."}
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
                  modelCatalog={modelCatalog}
                  modelCatalogLoading={modelCatalogLoading}
                  modelCatalogError={modelCatalogError}
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

function ProjectTarget({
  cwd,
  projects,
  names,
  mode,
  onChange,
}: {
  cwd: string;
  projects: string[];
  names: Readonly<Record<string, { name: string }>>;
  mode: "project" | "effective";
  onChange: (cwd: string) => void;
}) {
  const name = names[cwd]?.name ?? shortCwd(cwd);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="eyebrow hidden lg:inline">{mode === "project" ? "Override" : "Resolve"} for</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-w-0 max-w-64 gap-1.5"
            aria-label={`${mode === "project" ? "Project settings target" : "Effective settings project"}: ${name}`}
            title={cwd}
          >
            <FolderGit2 className="shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
            <ChevronsUpDown className="shrink-0 text-ink-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-var(--spacing-6))]">
          <DropdownMenuLabel>
            {mode === "project" ? "Project settings to override" : "Project whose effective settings to inspect"}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={cwd} onValueChange={onChange}>
            {projects.map((project) => {
              const projectName = names[project]?.name ?? shortCwd(project);
              return (
                <DropdownMenuRadioItem key={project} value={project} className="items-start">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-ink">{projectName}</span>
                    <span className="font-mono text-xs leading-4 break-all text-ink-3">{project}</span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
 * plainly that nothing in it is taking effect, and offers the one fix laser
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
  modelCatalog,
  modelCatalogLoading,
  modelCatalogError,
  onApply,
}: {
  field: SettingDescriptor;
  snapshot: SettingsSnapshot;
  scope: SettingsScope;
  showSection: boolean;
  catalog: SettingsCatalog;
  /** `models` is the whole catalogue (curating it); `connected` is what a person can choose to use (D-145). */
  modelCatalog: { models: ModelCatalogEntry[]; connected: ModelCatalogEntry[]; defaultProvider?: string; defaultModel?: string };
  modelCatalogLoading: boolean;
  modelCatalogError: string | undefined;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}) {
  const controlId = useId();
  const row = rowFor(field, snapshot);
  const scoped = scope === "global" ? row.global : row.project;
  const displayed = scoped ?? row.effective ?? field.default;
  const writable = !field.managed && (scope === "global" || snapshot.projectTrust.writable);
  const section = catalog.sections.find((s) => s.id === field.section);
  const provider = String(getAtPath(snapshot.effective, "defaultProvider") ?? modelCatalog.defaultProvider ?? "");

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
        {showSection && section && <p className="mt-0.5 text-xs text-ink-3">{section.title}</p>}
        <p className="mt-1 text-xs leading-5 text-ink-2">{field.description}</p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {field.path === "defaultProvider" ? (
          <ProviderPicker
            models={modelCatalog.connected}
            {...((typeof displayed === "string" ? displayed : modelCatalog.defaultProvider) ? { value: typeof displayed === "string" ? displayed : modelCatalog.defaultProvider } : {})}
            disabled={!writable || modelCatalogLoading}
            loading={modelCatalogLoading}
            {...(modelCatalogError ? { error: modelCatalogError } : {})}
            onValueChange={(value) => void onApply(scope, [{ path: field.path, op: "set", value }])}
          />
        ) : field.path === "defaultModel" ? (
          <ProviderModelPicker
            models={modelCatalog.connected}
            {...((typeof displayed === "string" ? displayed : modelCatalog.defaultModel) && provider
              ? { value: `${provider}/${typeof displayed === "string" ? displayed : modelCatalog.defaultModel}` }
              : {})}
            disabled={!writable || modelCatalogLoading}
            loading={modelCatalogLoading}
            {...(modelCatalogError ? { error: modelCatalogError } : {})}
            onValueChange={(value) => {
              const slash = value.indexOf("/");
              const nextProvider = value.slice(0, slash);
              const nextModel = value.slice(slash + 1);
              void onApply(scope, [
                { path: "defaultProvider", op: "set", value: nextProvider },
                { path: "defaultModel", op: "set", value: nextModel },
              ]);
            }}
          />
        ) : field.path === "enabledModels" ? (
          <ProviderModelMultiPicker
            models={modelCatalog.models}
            values={Array.isArray(displayed) ? displayed.filter((value): value is string => typeof value === "string") : []}
            disabled={!writable || modelCatalogLoading}
            loading={modelCatalogLoading}
            {...(modelCatalogError ? { error: modelCatalogError } : {})}
            onValuesChange={(value) => void onApply(scope, [value.length === 0 ? { path: field.path, op: "unset" } : { path: field.path, op: "set", value }])}
          />
        ) : field.path === "modelThinkingLevels" ? (
          <ModelThinkingMapField
            models={modelCatalog.connected}
            value={displayed}
            disabled={!writable}
            onCommit={(value) => void onApply(scope, [value === undefined ? { path: field.path, op: "unset" } : { path: field.path, op: "set", value }])}
          />
        ) : (
          <SettingField
            field={field}
            id={controlId}
            value={displayed}
            disabled={!writable}
            onCommit={(value) =>
              void onApply(scope, [
                value === undefined ? { path: field.path, op: "unset" } : { path: field.path, op: "set", value },
              ])
            }
          />
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <>
              {scoped === undefined && row.origin !== "unset" && <OriginBadge origin={row.origin} />}
              {scope === "global" && row.project !== undefined && (
                <span className="inline-flex items-center gap-1 text-attention">
                  the project file overrides this with <ValueChip value={row.project} />
                </span>
              )}
              {writable && scoped !== undefined && (
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
        </div>
      </div>
    </div>
  );
}

function ModelThinkingMapField({ models, value, disabled, onCommit }: { models: readonly ModelCatalogEntry[]; value: unknown; disabled: boolean; onCommit(value: unknown): void }) {
  const map = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const entries = Object.entries(map);
  const replace = (next: Record<string, unknown>) => onCommit(Object.keys(next).length === 0 ? undefined : next);
  return (
    <div className="flex max-w-140 flex-col gap-1.5">
      {entries.map(([key, level]) => {
        const slash = key.indexOf("/");
        const provider = slash > 0 ? key.slice(0, slash) : "";
        const model = models.find((entry) => modelOptionId(entry) === key);
        const provenance = model ? modelProvenance(model) : undefined;
        const levels = model?.thinkingLevels.length ? model.thinkingLevels : (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]);
        return (
          <div key={key} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5">
            <ProviderLogo provider={provider} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate typed" title={key}>{provenance?.modelId ?? key}</span>
            <select
              aria-label={`Thinking level for ${key}`}
              value={String(level)}
              disabled={disabled}
              onChange={(event) => replace({ ...map, [key]: event.target.value })}
              className="h-7 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus-visible:border-live"
            >
              {levels.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${key}`} disabled={disabled} onClick={() => { const next = { ...map }; delete next[key]; replace(next); }}>
              <X />
            </Button>
          </div>
        );
      })}
      <ProviderModelPicker
        key={entries.length}
        models={models.filter((model) => !Object.prototype.hasOwnProperty.call(map, modelOptionId(model)))}
        disabled={disabled}
        placeholder="Add a model override"
        onValueChange={(key) => replace({ ...map, [key]: "medium" })}
      />
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

/** Read-only table: what Laser will use, and which scope decided it. */
function EffectiveView({ catalog, snapshot }: { catalog: SettingsCatalog; snapshot: SettingsSnapshot }) {
  const rows = useMemo(() => effectiveDiff(catalog, snapshot).filter((row) => row.field.section !== "tools"), [catalog, snapshot]);
  const unknownKeys = useMemo(() => {
    const known = new Set(catalog.topLevelKeys);
    const seen = new Set([...Object.keys(snapshot.global.values), ...Object.keys(snapshot.project.values)]);
    return [...seen].filter((key) => !known.has(key));
  }, [catalog.topLevelKeys, snapshot]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-240 flex-col gap-3 px-4 py-4">
        <p className="text-xs leading-5 text-ink-2">
          Every setting in this tab and the value {PRODUCT_NAME} will use. Nested objects merge; arrays replace whole.
          {snapshot.projectTrust.trusted
            ? ""
            : " Project values are shown but greyed out because this project is not trusted."}
        </p>

        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-2">
            No value in this tab is overridden. {PRODUCT_NAME} is using its defaults.
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
              These values are not part of this {PRODUCT_NAME} version. {PRODUCT_NAME} leaves them exactly as they are and never rewrites them:{" "}
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
