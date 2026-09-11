"use client";
/**
 * The inspector (docs/mcp.md "Inspecting"): a full-height sheet on a wide
 * screen, the whole screen on a phone. It connects when it opens — that is
 * what makes the answers real rather than remembered — and closes the
 * connection again on the way out, so a command it started is not left
 * running behind the page.
 *
 * Five tabs: what it is, what it can do, proof that it does it, and the
 * documents and prompts it offers besides tools.
 */
import type { McpInspection, McpScope, McpServerState, McpToolPolicy } from "@lasercode/protocol";
import { KeyRound, LogOut, Pencil, Power, RefreshCw, Trash2, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { McpRunPanel } from "./McpRunPanel.js";
import { McpToolsPanel } from "./McpToolsPanel.js";
import {
  EXPOSURE_LABEL,
  policyOf,
  scopeLabel,
  serverTitle,
  statusWords,
  transportSummary,
} from "./model.js";

type InspectorTab = "overview" | "tools" | "run" | "resources" | "prompts";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tools", label: "Tools" },
  { id: "run", label: "Run" },
  { id: "resources", label: "Resources" },
  { id: "prompts", label: "Prompts" },
];

export interface McpInspectorProps {
  cwd: string;
  /** The selected row; `undefined` keeps the sheet closed. */
  state: McpServerState | undefined;
  /** Bumped by `mcp/changed`, so the open inspector re-reads its status. */
  reloadToken: number;
  onOpenChange: (open: boolean) => void;
  onServers: (servers: McpServerState[]) => void;
  onEdit: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  /** The list's scope filter, so Remove can offer the project switch-off instead. */
  scopeFilter: McpScope | "all";
  onError: (message: string) => void;
}

export function McpInspector({
  cwd,
  state,
  reloadToken,
  onOpenChange,
  onServers,
  onEdit,
  onSignIn,
  onSignOut,
  scopeFilter,
  onError,
}: McpInspectorProps) {
  const { client } = useLaserStable();
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [inspection, setInspection] = useState<McpInspection>();
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [ping, setPing] = useState<{ latencyMs?: number; detail?: string }>();
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<McpToolPolicy>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const generation = useRef(0);

  const scope = state?.scope;
  const name = state?.config.name;
  const stdio = state?.config.transport.kind === "stdio";

  const connect = useCallback(async () => {
    if (!scope || !name) return;
    const request = ++generation.current;
    setConnecting(true);
    setFailure(undefined);
    try {
      const result = await client.request("mcp/inspect", { cwd, scope, name });
      if (request !== generation.current) return;
      setInspection(result);
    } catch (error) {
      if (request === generation.current) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === generation.current) setConnecting(false);
    }
  }, [client, cwd, scope, name]);

  // Opening a row connects to it; switching rows starts again from Overview.
  useEffect(() => {
    if (!scope || !name) return;
    setTab("overview");
    setInspection(undefined);
    setPing(undefined);
    setPolicy(undefined);
    void connect();
  }, [scope, name, connect]);

  // `mcp/changed` while the sheet is open: read the status again.
  useEffect(() => {
    if (!reloadToken || !scope || !name) return;
    void connect();
    // The token is the trigger; `connect` is stable for one server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const close = () => {
    generation.current++;
    // A stdio server is a process this page started. Leaving without closing
    // it would leave it running for nobody.
    if (stdio && scope && name) void client.request("mcp/disconnect", { cwd, scope, name }).catch(() => undefined);
    onOpenChange(false);
  };

  const save = async (patch: Partial<McpServerState["config"]>, optimistic?: () => void, rollback?: () => void) => {
    if (!state || !scope) return;
    optimistic?.();
    setBusy(true);
    try {
      const { servers } = await client.request("mcp/save", { cwd, scope, server: { ...state.config, ...patch } });
      onServers(servers);
    } catch (error) {
      rollback?.();
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const changePolicy = (next: McpToolPolicy) => {
    const previous = policy;
    void save({ tools: next }, () => setPolicy(next), () => setPolicy(previous));
  };

  const runPing = async () => {
    if (!scope || !name) return;
    setBusy(true);
    try {
      const result = await client.request("mcp/ping", { cwd, scope, name });
      setPing({ ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}), ...(result.detail ? { detail: result.detail } : {}) });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!scope || !name) return;
    setBusy(true);
    try {
      await client.request("mcp/disconnect", { cwd, scope, name });
    } catch {
      /* it may not have been connected; the inspect below is what matters */
    } finally {
      setBusy(false);
    }
    await connect();
  };

  const remove = async () => {
    if (!scope || !name) return;
    setBusy(true);
    try {
      const { servers } = await client.request("mcp/remove", { cwd, scope, name });
      onServers(servers);
      setConfirmRemove(false);
      onOpenChange(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Switch it off here" for a server that lives in every project: the project
   * gets its own entry of the same name, switched off, and the global one is
   * left alone.
   */
  const disableHere = async () => {
    if (!state || state.scope !== "global") return;
    setBusy(true);
    try {
      const { servers } = await client.request("mcp/save", {
        cwd,
        scope: "project",
        server: { ...state.config, disabled: true },
      });
      onServers(servers);
      setConfirmRemove(false);
      onOpenChange(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const config = state ? { ...state.config, ...(policy ? { tools: policy } : {}) } : undefined;
  const status = statusWords(state?.status ?? "unknown");
  const transport = state ? transportSummary(state.config.transport) : undefined;

  return (
    <>
      <Sheet open={Boolean(state)} onOpenChange={(open) => (open ? onOpenChange(true) : close())}>
        <SheetContent
          data-slot="mcp-inspector"
          data-server={state ? `${state.scope}:${state.config.name}` : undefined}
          className="w-full sm:w-[min(96vw,44rem)] sm:max-w-none"
        >
          <SheetHeader>
            <SheetTitle>{state ? serverTitle(state.config) : "Server"}</SheetTitle>
            <SheetDescription>
              {transport ? `${transport.text} · ${transport.kind} · ${scopeLabel(state!.scope)}` : ""}
            </SheetDescription>
          </SheetHeader>

          <div role="tablist" aria-label="What to look at" className="flex shrink-0 items-center gap-1 overflow-x-auto px-4 pb-2">
            {TABS.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                variant="ghost"
                size="sm"
                onClick={() => setTab(entry.id)}
                className={cn("shrink-0", tab === entry.id && "bg-surface-2 text-ink")}
              >
                {entry.label}
              </Button>
            ))}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-w-0 flex-col gap-4 px-4 pb-6">
              {connecting && !inspection && <GenerationLoader label="Connecting to the server" layout="block" />}
              {failure && !inspection && (
                <ErrorState title="Could not reach this server" detail={failure} onRetry={() => void connect()} />
              )}

              {state && config && (
                <>
                  {tab === "overview" && (
                    <Overview
                      state={state}
                      inspection={inspection}
                      ping={ping}
                      busy={busy}
                      statusLabel={status.label}
                      statusHelp={status.help}
                      onPing={() => void runPing()}
                      onReconnect={() => void reconnect()}
                      onSignIn={onSignIn}
                      onSignOut={onSignOut}
                      onToggleDisabled={() => void save({ disabled: !state.config.disabled })}
                      onEdit={onEdit}
                      onRemove={() => setConfirmRemove(true)}
                    />
                  )}
                  {tab === "tools" &&
                    (inspection ? (
                      <McpToolsPanel config={config} inspection={inspection} busy={busy} onPolicy={changePolicy} />
                    ) : (
                      <WaitingForConnection connecting={connecting} />
                    ))}
                  {tab === "run" &&
                    (inspection ? (
                      <McpRunPanel cwd={cwd} scope={state.scope} name={state.config.name} inspection={inspection} />
                    ) : (
                      <WaitingForConnection connecting={connecting} />
                    ))}
                  {tab === "resources" &&
                    (inspection ? <Resources inspection={inspection} /> : <WaitingForConnection connecting={connecting} />)}
                  {tab === "prompts" &&
                    (inspection ? <Prompts inspection={inspection} /> : <WaitingForConnection connecting={connecting} />)}
                </>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent data-slot="mcp-remove-dialog">
          <DialogHeader>
            <DialogTitle>Remove {state ? serverTitle(state.config) : "this server"}?</DialogTitle>
            <DialogDescription>
              It disappears from {state ? scopeLabel(state.scope).toLowerCase() : "this list"}, together with anything secret you saved
              for it. Conversations already running keep the tools they started with.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            {state?.scope === "global" && scopeFilter !== "global" && (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void disableHere()}>
                Switch it off for this project instead
              </Button>
            )}
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
              <Trash2 aria-hidden="true" /> Remove it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WaitingForConnection({ connecting }: { connecting: boolean }) {
  return connecting ? (
    <GenerationLoader label="Connecting to the server" layout="block" />
  ) : (
    <p className="text-sm leading-6 text-ink-2">Nothing to show until the server answers. Try Reconnect on the Overview tab.</p>
  );
}

function Overview({
  state,
  inspection,
  ping,
  busy,
  statusLabel,
  statusHelp,
  onPing,
  onReconnect,
  onSignIn,
  onSignOut,
  onToggleDisabled,
  onEdit,
  onRemove,
}: {
  state: McpServerState;
  inspection: McpInspection | undefined;
  ping: { latencyMs?: number; detail?: string } | undefined;
  busy: boolean;
  statusLabel: string;
  statusHelp: string;
  onPing: () => void;
  onReconnect: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onToggleDisabled: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const transport = transportSummary(state.config.transport);
  const oauth = state.config.auth?.kind === "oauth";
  const latency = ping?.latencyMs ?? state.latencyMs ?? inspection?.latencyMs;
  const policy = policyOf(state.config);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex flex-wrap items-center gap-2">
        <Badge variant={state.status === "failed" ? "danger" : state.status === "needs-auth" ? "attention" : "live"}>{statusLabel}</Badge>
        {latency !== undefined && (
          <Badge variant="outline" className="tnum">
            {latency} ms
          </Badge>
        )}
        {inspection?.server?.name && <Badge variant="mono">{inspection.server.name}{inspection.server.version ? ` ${inspection.server.version}` : ""}</Badge>}
        {inspection?.protocolVersion && <Badge variant="outline">speaks {inspection.protocolVersion}</Badge>}
      </section>
      <p className="text-sm leading-6 text-ink-2">{statusHelp}</p>
      {(state.detail || inspection?.detail) && <p className="text-sm leading-6 text-ink-2">{state.detail ?? inspection?.detail}</p>}
      {inspection?.stderr?.length ? (
        <pre className="typed max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 whitespace-pre-wrap text-ink-2">{inspection.stderr.join("\n")}</pre>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onPing}>
          <Waves aria-hidden="true" /> Ping
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onReconnect}>
          <RefreshCw aria-hidden="true" /> Reconnect
        </Button>
        {oauth && (
          <>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onSignIn}>
              <KeyRound aria-hidden="true" /> Sign in
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSignOut}>
              <LogOut aria-hidden="true" /> Sign out
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onToggleDisabled}>
          <Power aria-hidden="true" /> {state.config.disabled ? "Turn on" : "Turn off"}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onEdit}>
          <Pencil aria-hidden="true" /> Edit
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
          <Trash2 aria-hidden="true" /> Remove
        </Button>
      </div>

      {state.config.transport.kind === "stdio" && (
        <p
          data-slot="mcp-inspector-connection-note"
          className="text-xs leading-5 text-ink-3"
          title="Looking at a command server starts it. Closing this panel stops it again, so nothing is left running for nobody."
        >
          Looking at this server started it. Closing this panel stops it again.
        </p>
      )}

      {inspection?.capabilities && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">What it offers</h3>
          <div className="flex flex-wrap gap-1.5">
            {inspection.capabilities.tools && <Badge variant="outline">tools</Badge>}
            {inspection.capabilities.resources && <Badge variant="outline">documents</Badge>}
            {inspection.capabilities.prompts && <Badge variant="outline">prompts</Badge>}
            {inspection.capabilities.logging && <Badge variant="outline">logs</Badge>}
            {inspection.capabilities.toolListChanged && <Badge variant="outline">tells us when its tools change</Badge>}
          </div>
        </section>
      )}

      {inspection?.instructions && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">What it says about itself</h3>
          <div className="max-h-56 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-sm leading-6 whitespace-pre-wrap text-ink-2">
            {inspection.instructions}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">How it is set up</h3>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">Reached by</dt>
          <dd className="min-w-0 break-words text-ink-2">
            {transport.kind} · <span className="typed">{transport.full}</span>
          </dd>
          <dt className="text-ink-3">Sign-in</dt>
          <dd className="text-ink-2">
            {state.config.auth?.kind === "bearer" ? "A token, kept in the app’s secret store" : oauth ? "Your account, through your browser" : "None"}
          </dd>
          <dt className="text-ink-3">Tools reach the model</dt>
          <dd className="text-ink-2">{EXPOSURE_LABEL[policy.exposure]}</dd>
          <dt className="text-ink-3">Saved for</dt>
          <dd className="text-ink-2">{scopeLabel(state.scope)}</dd>
        </dl>
      </section>
    </div>
  );
}

function Resources({ inspection }: { inspection: McpInspection }) {
  if (!inspection.resources.length) return <p className="text-sm leading-6 text-ink-2">This server offers no documents.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {inspection.resources.map((resource) => (
        <li key={resource.uri} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-3">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-ink">{resource.name}</span>
            {resource.template && <Badge variant="outline">a pattern</Badge>}
            {resource.mimeType && <Badge variant="mono">{resource.mimeType}</Badge>}
          </span>
          <span className="typed break-all text-ink-3">{resource.uri}</span>
          {resource.description && <span className="text-sm leading-6 text-ink-2">{resource.description}</span>}
        </li>
      ))}
    </ul>
  );
}

function Prompts({ inspection }: { inspection: McpInspection }) {
  if (!inspection.prompts.length) return <p className="text-sm leading-6 text-ink-2">This server offers no prompts.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {inspection.prompts.map((prompt) => (
        <li key={prompt.name} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface p-3">
          <span className="text-sm font-medium text-ink">{prompt.title ?? prompt.name}</span>
          {prompt.description && <span className="text-sm leading-6 text-ink-2">{prompt.description}</span>}
          {prompt.arguments.length > 0 && (
            <ul className="flex flex-col gap-0.5 pt-1">
              {prompt.arguments.map((argument) => (
                <li key={argument.name} className="text-xs leading-5 text-ink-3">
                  <span className="typed text-ink-2">{argument.name}</span>
                  {argument.required ? " (required)" : " (optional)"}
                  {argument.description ? ` — ${argument.description}` : ""}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
