"use client";
/**
 * Adding a server, and editing one (docs/mcp.md "Adding"). Two doors, one
 * dialog: the curated gallery, and a definition typed by hand. Both end in
 * **Test** — `mcp/inspect` with the unsaved definition — so the person sees
 * the server's name, its tools and their descriptions before anything is
 * saved, and then chooses how those tools reach the model.
 *
 * Saving without testing is allowed; it is simply not the way the dialog
 * leads. `mcp/save` never connects, so an untested definition costs nothing
 * but a row that says "Not seen yet".
 */
import {
  MCP_DIRECT_EXPOSURE_MAX_TOOLS,
  type McpCatalogEntry,
  type McpInspection,
  type McpScope,
  type McpServerConfig,
  type McpServerState,
  type McpToolExposure,
} from "@lasercode/protocol";
import { AlertTriangle, Check, KeyRound, Plug, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RadioGroup } from "radix-ui";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { McpServerForm, ScopeChoice } from "./McpServerForm.js";
import {
  catalogForm,
  catalogOptionReason,
  configToForm,
  defaultCatalogOptions,
  defaultExposure,
  EXPOSURE_LABEL,
  exposureExplanation,
  emptyForm,
  formIssues,
  formToConfig,
  hasIssues,
  schemaToShape,
  type ServerForm,
} from "./model.js";

export interface McpAddDialogProps {
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A gallery card was clicked: its definition is already composed. */
  entry?: McpCatalogEntry | undefined;
  /** Editing an existing server rather than adding one. */
  edit?: { scope: McpScope; config: McpServerConfig } | undefined;
  /** Which scope a new server lands in by default. */
  defaultScope?: McpScope;
  /** False with no project open: only the every-project scope exists. */
  allowProject?: boolean;
  onSaved: (servers: McpServerState[], saved: { scope: McpScope; name: string; needsAuth: boolean }) => void;
}

export function McpAddDialog({ cwd, open, onOpenChange, entry, edit, defaultScope = "global", allowProject = true, onSaved }: McpAddDialogProps) {
  const { client } = useLaserStable();
  const [form, setForm] = useState<ServerForm>(() => emptyForm());
  const [scope, setScope] = useState<McpScope>(defaultScope);
  const [options, setOptions] = useState<Set<string>>(() => new Set());
  const [showIssues, setShowIssues] = useState(false);
  const [testing, setTesting] = useState(false);
  const [inspection, setInspection] = useState<McpInspection>();
  const [exposure, setExposure] = useState<McpToolExposure>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // Opening resets everything: a half-finished definition from last time is
  // never what the person meant this time.
  useEffect(() => {
    if (!open) return;
    setShowIssues(false);
    setInspection(undefined);
    setExposure(undefined);
    setError(undefined);
    setTesting(false);
    setSaving(false);
    if (edit) {
      setForm(configToForm(edit.config));
      setScope(edit.scope);
      setOptions(new Set());
      return;
    }
    if (entry) {
      const chosen = defaultCatalogOptions(entry);
      setOptions(chosen);
      setForm(catalogForm(entry, chosen));
      setScope(defaultScope);
      return;
    }
    setForm(emptyForm());
    setOptions(new Set());
    setScope(defaultScope);
  }, [open, entry, edit, defaultScope]);

  const chooseOption = (id: string, on: boolean, group?: string) => {
    if (!entry) return;
    const next = new Set(options);
    if (group) for (const value of next) if (value.startsWith(`${group}:`)) next.delete(value);
    if (on) next.add(id);
    else next.delete(id);
    setOptions(next);
    // The command line is composed from the catalog's definition, so the
    // options stay honest even after the person opened the full settings.
    setForm((current) => ({ ...current, commandLine: catalogForm(entry, next).commandLine }));
    setInspection(undefined);
  };

  const issues = formIssues(form);
  const title = edit ? `Edit ${form.label || form.name}` : entry ? `Add ${entry.name}` : "Add a server";

  const test = async () => {
    setShowIssues(true);
    if (hasIssues(issues)) return;
    setTesting(true);
    setError(undefined);
    setInspection(undefined);
    try {
      const result = await client.request("mcp/inspect", { cwd, scope, server: formToConfig(form) });
      setInspection(result);
      setExposure(defaultExposure(result.tools.length));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setShowIssues(true);
    if (hasIssues(issues)) return;
    setSaving(true);
    setError(undefined);
    const chosen = exposure ?? form.exposure;
    try {
      const { servers } = await client.request("mcp/save", {
        cwd,
        scope,
        server: formToConfig({ ...form, exposure: chosen }),
        ...(edit && edit.config.name !== form.name.trim() ? { originalName: edit.config.name } : {}),
      });
      onSaved(servers, { scope, name: form.name.trim(), needsAuth: inspection?.status === "needs-auth" || form.authKind === "oauth" });
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const exposureChoice = exposure ?? form.exposure;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog itself is bounded and scrolls inside: on a short phone the
          header must not be pushed off the top where nothing can reach it. */}
      <DialogContent data-slot="mcp-add-dialog" className="flex max-h-[90dvh] min-h-0 flex-col sm:max-w-160">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {edit
              ? "Changes apply to conversations started after you save."
              : "Test it first: you will see what it can do before it is saved."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-4 pe-3">
            {entry && !edit && (
              <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3" aria-label={`${entry.name} options`}>
                <p className="text-sm leading-6 text-ink-2">{entry.description}</p>
                {entry.requires && <p className="text-xs leading-5 text-ink-3">Needs: {entry.requires}</p>}
                {(entry.options ?? []).map((option) => option.kind === "choice" ? (
                  <div key={option.id} className="flex min-w-0 flex-col gap-2">
                    <p className="text-sm font-medium text-ink">{option.label}</p>
                    <RadioGroup.Root
                      aria-label={option.label}
                      value={option.choices.find((choice) => options.has(`${option.id}:${choice.id}`))?.id ?? ""}
                      onValueChange={(value) => chooseOption(`${option.id}:${value}`, true, option.id)}
                      disabled={testing || saving}
                      className="flex min-w-0 flex-col gap-1"
                    >
                      {option.choices.map((choice) => (
                        <RadioGroup.Item key={choice.id} value={choice.id} aria-label={choice.label}
                          className="group flex min-w-0 items-start gap-3 rounded-lg p-2 text-start outline-none hover:bg-surface focus-visible:outline-2 focus-visible:outline-live data-[state=checked]:bg-surface disabled:opacity-60 pointer-coarse:min-h-11">
                          <span aria-hidden="true" className="mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border border-line group-data-[state=checked]:border-live">
                            <RadioGroup.Indicator className="size-2 rounded-full bg-live" />
                          </span>
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="text-sm font-medium text-ink">{choice.label}</span>
                            <span className="text-xs leading-5 text-ink-2 [overflow-wrap:anywhere]">{choice.description}</span>
                          </span>
                        </RadioGroup.Item>
                      ))}
                    </RadioGroup.Root>
                    {entry.id === "playwright" && options.has("browser:extension") && (
                      <a href="https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm" target="_blank" rel="noreferrer"
                        className="rounded-sm text-xs leading-5 text-live underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-live">
                        Get the Playwright Extension from the Chrome Web Store
                      </a>
                    )}
                  </div>
                ) : catalogOptionReason(option, options) ? (
                  <p key={option.id} className="text-xs leading-5 text-ink-3">{catalogOptionReason(option, options)}</p>
                ) : (
                  <div key={option.id} className="flex items-start gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm text-ink">{option.label}</span>
                      <span className="text-xs leading-5 text-ink-3">{option.description}</span>
                    </span>
                    <SettingsSwitch
                      checked={options.has(option.id)}
                      disabled={testing || saving}
                      aria-label={option.label}
                      onCheckedChange={(on) => chooseOption(option.id, on)}
                    />
                  </div>
                ))}
              </section>
            )}

            <ScopeChoice scope={scope} onChange={setScope} disabled={Boolean(edit)} allowProject={allowProject} />

            {entry && !edit ? (
              <Collapsible className="min-w-0">
                <CollapsibleTrigger className="text-start text-sm text-live underline-offset-4 hover:underline">All settings</CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <McpServerForm form={form} onChange={setForm} showIssues={showIssues} disabled={testing || saving} />
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <McpServerForm form={form} onChange={setForm} showIssues={showIssues} disabled={testing || saving} />
            )}

            {form.catalogId === "playwright" && <p className="text-xs leading-5 text-ink-3">Test opens about:blank in the selected browser tab, then checks that tabs can be listed.</p>}
            {testing && <GenerationLoader label={form.catalogId === "playwright" ? "Connecting and checking the browser" : "Connecting to the server — this can take up to half a minute"} layout="block" />}

            {error && (
              <p role="alert" className="text-sm leading-6 text-danger">
                {error}
              </p>
            )}

            {inspection && <TestResult inspection={inspection} />}

            {inspection && inspection.status !== "failed" && (
              <ExposureChoice
                exposure={exposureChoice}
                toolCount={inspection.tools.length}
                onChange={(next) => setExposure(next)}
              />
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="secondary" onClick={() => void test()} disabled={testing || saving}>
            <Plug aria-hidden="true" /> {inspection ? "Test again" : "Test"}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={testing || saving}>
            <Check aria-hidden="true" />
            {edit ? "Save changes" : inspection?.status === "needs-auth" ? "Add and sign in" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TestResult({ inspection }: { inspection: McpInspection }) {
  if (inspection.status === "failed") {
    return (
      <section data-slot="mcp-test-result" data-status="failed" className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3">
        <p className="flex items-center gap-2 text-sm font-medium text-danger">
          <AlertTriangle aria-hidden="true" className="size-4" /> {inspection.detail?.startsWith("Connected, but") ? "The browser test failed" : "It did not answer"}
        </p>
        {/* A failure names paths (the executable, the PATH it looked in): let them break anywhere so the card holds them on a phone. */}
        {inspection.detail && <p className="text-sm leading-6 text-ink-2 break-words [overflow-wrap:anywhere]">{inspection.detail}</p>}
        {inspection.stderr?.length ? (
          <pre dir="ltr" className="typed max-h-40 overflow-auto rounded-lg bg-surface p-2 whitespace-pre-wrap text-ink-2">
            {inspection.stderr.join("\n")}
          </pre>
        ) : null}
      </section>
    );
  }
  return (
    <section data-slot="mcp-test-result" data-status={inspection.status} className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">{inspection.server?.title ?? inspection.server?.name ?? inspection.name}</p>
        {inspection.server?.version && <Badge variant="mono">{inspection.server.version}</Badge>}
        {inspection.latencyMs !== undefined && <Badge variant="outline" className="tnum">{inspection.latencyMs} ms</Badge>}
        <Badge variant={inspection.status === "needs-auth" ? "attention" : "live"}>
          {inspection.status === "needs-auth" ? (
            <>
              <KeyRound aria-hidden="true" /> Needs sign-in
            </>
          ) : (
            <>
              <Wrench aria-hidden="true" /> {inspection.tools.length} tools
            </>
          )}
        </Badge>
      </div>
      {inspection.status === "needs-auth" && (
        <p className="text-sm leading-6 text-ink-2">
          Add it and sign in; the browser opens and the row turns connected when you come back.
        </p>
      )}
      {inspection.tools.length > 0 && (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {inspection.tools.map((tool) => (
            <li key={tool.name} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-ink">{tool.title ?? tool.originalName}</span>
                <span className="typed truncate text-ink-3">{tool.name}</span>
              </span>
              {tool.description && <span className="text-xs leading-5 text-ink-2">{tool.description}</span>}
              {schemaToShape(tool.inputSchema) && (
                <span className="typed truncate text-ink-3" title={schemaToShape(tool.inputSchema)}>
                  {schemaToShape(tool.inputSchema)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExposureChoice({
  exposure,
  toolCount,
  onChange,
}: {
  exposure: McpToolExposure;
  toolCount: number;
  onChange: (exposure: McpToolExposure) => void;
}) {
  const chosen = useMemo(() => defaultExposure(toolCount), [toolCount]);
  return (
    <section data-slot="mcp-exposure" className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-sm font-medium text-ink">How the model reaches these tools</p>
      <div role="group" aria-label="How the model reaches these tools" className="flex flex-wrap gap-2">
        {(["direct", "on-demand"] as const).map((option) => (
          <Button
            key={option}
            type="button"
            aria-pressed={exposure === option}
            variant="ghost"
            size="sm"
            onClick={() => onChange(option)}
            className={cn("border border-line", exposure === option && "border-live text-ink")}
          >
            {EXPOSURE_LABEL[option]}
          </Button>
        ))}
      </div>
      <p className="text-xs leading-5 text-ink-3">
        {exposureExplanation(exposure, toolCount)}
        {exposure === chosen
          ? ` Chosen for you because ${toolCount <= MCP_DIRECT_EXPOSURE_MAX_TOOLS ? `${toolCount} tools fit comfortably in the model’s list` : `more than ${MCP_DIRECT_EXPOSURE_MAX_TOOLS} tools would crowd every turn`}.`
          : ""}
      </p>
    </section>
  );
}
