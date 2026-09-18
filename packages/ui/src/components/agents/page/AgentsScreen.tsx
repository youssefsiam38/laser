"use client";
/**
 * Agents shares Settings' one explicit Global / Project / Effective target.
 * Definition mutations are anchored to exact source locations; Code/session
 * state never contributes a project.
 */
import type { AgentDefinition, AgentDefinitionInput, AgentLocation } from "@lasercode/protocol";
import { ChevronLeft, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import {
  agentDefinitionInputOf,
  agentDisplayName,
  useAgentsActions,
  useAgentsSnapshot,
  useAgentsStatus,
} from "@/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { CapabilityNotice } from "@/components/capability-gate";
import { ScopeDraftGuard, type ScopeDraft, type ScopeDraftNavigationGuard } from "@/components/settings/ScopeDraftGuard";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { SettingsScopeControls, useWorkbench, type AgentsTarget } from "@/components/workbench";
import { useIsMobile } from "@/hooks";
import { cn } from "@/lib/utils";
import { deviceStore } from "@/runtime/device-storage";
import { useCapability, useLaserStable } from "@/runtime";

import type { EditorFocus } from "./AgentEditor.js";
import { AgentsEditorColumn, ReadonlyIntro } from "./AgentsEditorColumn.js";
import { AgentList } from "./AgentList.js";
import { AgentsOverview } from "./Overview.js";
import {
  agentAtLocation,
  agentForWarning,
  agentsInScope,
  isFirstRun,
  sameSelection,
  selectionOfAgent,
  visibleAgentWarnings,
  type AgentsSelection,
} from "./model.js";
import { useSettingsScopeTarget } from "./useSettingsScopeTarget.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface AgentsScreenProps {
  target?: AgentsTarget | undefined;
}

export function AgentsScreen({ target }: AgentsScreenProps) {
  const snapshot = useAgentsSnapshot();
  const status = useAgentsStatus();
  const agents = useAgentsActions();
  const { actions, projects } = useLaserStable();
  const workbench = useWorkbench();
  const mobile = useIsMobile();
  const device = useSyncExternalStore(deviceStore.subscribe, deviceStore.status, deviceStore.status);
  const write = useCapability("agents/save", { presentation: "explained" });
  const environmentWritable = write.state === "available";
  const { settingsScope } = workbench;
  const scoped = useSettingsScopeTarget(settingsScope, projects);
  const [selection, setSelection] = useState<AgentsSelection>(null);
  const [focus, setFocus] = useState<EditorFocus>();
  const [editorDraft, setEditorDraft] = useState<ScopeDraft>();
  const [editorMutation, setEditorMutation] = useState<{
    operation: symbol;
    identity: string;
    agent: AgentDefinition;
  }>();
  const [newSeed, setNewSeed] = useState<AgentDefinitionInput>();
  const [newToken, setNewToken] = useState(0);
  const guardRef = useRef<ScopeDraftNavigationGuard | undefined>(undefined);
  const localNavigation = useRef(0);
  const focusSeq = useRef(0);

  useEffect(() => {
    if (!status.loaded && !status.loading) void agents.refresh();
  }, [agents, status.loaded, status.loading]);

  const scopeTarget = scoped.target;
  const scopeView = scopeTarget?.view ?? settingsScope.view;
  const projectCwd = scopeTarget?.projectCwd;
  const routeCwd = scopeTarget?.routeCwd;
  const settingsView = scopeView === "global" ? "global" as const : "effective" as const;
  const destination: AgentLocation | undefined = scopeView === "global"
    ? { scope: "global" }
    : scopeView === "project" && projectCwd
      ? { scope: "project", projectCwd }
      : undefined;
  const scopeKey = `${scopeView}:${projectCwd ?? ""}`;
  const previousScopeKey = useRef(scopeKey);

  // The shared scope guard has already settled before this commit. A scope
  // change starts at the scoped overview rather than carrying local identity.
  useLayoutEffect(() => {
    if (previousScopeKey.current === scopeKey) return;
    previousScopeKey.current = scopeKey;
    localNavigation.current += 1;
    setSelection(null);
    setFocus(undefined);
    setEditorDraft(undefined);
    setEditorMutation(undefined);
    setNewSeed(undefined);
  }, [scopeKey]);

  const apply = useCallback((next: AgentsSelection, field?: string, seed?: AgentDefinitionInput) => {
    setSelection(next);
    setEditorMutation(undefined);
    setNewSeed(next?.kind === "new" ? seed : undefined);
    setFocus(field ? { field, seq: ++focusSeq.current } : undefined);
  }, []);

  /** One local path for list selection, phone back and ordinary local links. */
  const select = useCallback(async (next: AgentsSelection, field?: string, seed?: AgentDefinitionInput) => {
    if (sameSelection(next, selection)) {
      if (field) setFocus({ field, seq: ++focusSeq.current });
      return true;
    }
    const request = ++localNavigation.current;
    const guard = guardRef.current;
    if (guard && !(await guard())) return false;
    if (request !== localNavigation.current) return false;
    apply(next, field, seed);
    return true;
  }, [apply, selection]);

  const setGuard = useCallback((guard: ScopeDraftNavigationGuard | undefined) => {
    guardRef.current = guard;
  }, []);

  // Workbench already guarded and, for exact links, committed the matching
  // Settings scope. A name-only link deliberately resolves Global only.
  useEffect(() => {
    if (!target) return;
    const location = target.location ?? { scope: "global" as const };
    apply({ kind: "agent", name: target.agent, location }, target.field);
  }, [apply, target]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!mobile || !selection || event.key !== "Escape" || event.defaultPrevented) return;
    const inLayer = (event.target as HTMLElement | null)?.closest("[role='dialog'],[data-radix-popper-content-wrapper]");
    if (inLayer) return;
    event.preventDefault();
    void select(null);
  };

  const warnings = useMemo(
    () => visibleAgentWarnings(snapshot, scopeView, projectCwd, projects),
    [projectCwd, projects, scopeView, snapshot],
  );
  const selectedAgent = useMemo(
    () => selection?.kind === "agent" ? agentAtLocation(snapshot, selection.name, selection.location) : undefined,
    [snapshot, selection],
  );
  const selectedIdentity = selection?.kind === "agent"
    ? `${selection.location.scope}:${selection.location.scope === "project" ? selection.location.projectCwd : ""}:${selection.name}`
    : undefined;
  const displayedAgent = selectedAgent ?? (
    editorMutation && editorMutation.identity === selectedIdentity ? editorMutation.agent : undefined
  );
  const onMutationPending = useCallback((operation: symbol, pending: boolean) => {
    if (pending) {
      if (selectedAgent && selectedIdentity) {
        setEditorMutation({ operation, identity: selectedIdentity, agent: selectedAgent });
      }
      return;
    }
    setEditorMutation((current) => current?.operation === operation ? undefined : current);
  }, [selectedAgent, selectedIdentity]);
  const selectedWarnings = useMemo(() => displayedAgent
    ? warnings.filter((warning) => agentForWarning(snapshot, warning, scopeView, projectCwd) === displayedAgent)
    : [], [displayedAgent, projectCwd, scopeView, snapshot, warnings]);

  const onSaved = useCallback((saved: AgentDefinition) => {
    setEditorDraft(undefined);
    setSelection(selectionOfAgent(saved));
    setNewSeed(undefined);
    actions.toast("info", `${agentDisplayName(saved.name)} saved.`);
  }, [actions]);
  const onDeleted = useCallback(() => {
    const name = selection?.kind === "agent" ? selection.name : undefined;
    setEditorDraft(undefined);
    setSelection(null);
    if (name) actions.toast("info", `${agentDisplayName(name)} deleted.`);
  }, [actions, selection]);
  const startChat = useCallback(async (name: string) => {
    if (!projectCwd) return;
    const navigationGuard = guardRef.current;
    if (navigationGuard && !(await navigationGuard())) return;
    const environmentKey = device.environmentKey;
    try {
      await actions.newSession(projectCwd, { agentName: name });
      if (
        previousScopeKey.current === scopeKey
        && deviceStore.status().environmentKey === environmentKey
      ) {
        workbench.close();
      }
    } catch (error) {
      actions.toast("error", messageOf(error));
    }
  }, [actions, device.environmentKey, projectCwd, scopeKey, workbench]);

  const startNew = useCallback(() => {
    if (!destination) return;
    const token = newToken + 1;
    setNewToken(token);
    void select({ kind: "new", location: destination, token });
  }, [destination, newToken, select]);

  const startOverride = useCallback((source: AgentDefinition) => {
    if (!projectCwd) return;
    const targetLocation: AgentLocation = { scope: "project", projectCwd };
    const seed = { ...agentDefinitionInputOf(source), scope: "project" as const, projectCwd };
    const token = newToken + 1;
    setNewToken(token);
    void select({ kind: "new", location: targetLocation, token }, undefined, seed);
  }, [newToken, projectCwd, select]);

  if (!snapshot) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-slot="agents-screen" data-state={status.error ? "error" : "loading"}>
        <Header count={undefined} warnings={0} mobile={mobile} editing={false} canCreate={false} onNew={() => undefined} onBack={() => undefined} />
        {status.error ? <div className="p-4"><ErrorState title="Couldn’t load your agents" detail={status.error} onRetry={() => void agents.refresh()} /></div> : <PageSkeleton mobile={mobile} />}
      </div>
    );
  }

  if (!scopeTarget) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-slot="agents-screen" data-state={scoped.error ? "error" : "loading"}>
        <Header count={undefined} warnings={0} mobile={mobile} editing={false} canCreate={false} onNew={() => undefined} onBack={() => undefined} />
        <div className="flex shrink-0 items-center px-3 py-2 hairline-b"><SettingsScopeControls /></div>
        <RouteError error={scoped.error} onRetry={scoped.reload} />
      </div>
    );
  }

  const scopeMissing = scopeView !== "global" && !projectCwd;
  const editing = selection !== null;
  const showList = !mobile || !editing;
  const showEditor = !mobile || editing;
  const canCreate = environmentWritable && destination !== undefined && scopeView !== "effective";
  const visibleCustom = agentsInScope(snapshot, scopeView, projectCwd).custom;
  const editorKey = selection === null
    ? "overview"
    : selection.kind === "new"
      ? `new:${selection.token}:${selection.location.scope}:${selection.location.scope === "project" ? selection.location.projectCwd : ""}`
      : selection.kind === "harness"
        ? "harness"
        : `agent:${selection.location.scope}:${selection.location.scope === "project" ? selection.location.projectCwd : ""}:${selection.name}`;
  const inheritedGlobal = scopeView === "project" && displayedAgent?.kind === "custom" && displayedAgent.scope === "global";
  const editableDefinition = environmentWritable && scopeView !== "effective" && !inheritedGlobal;
  const projectAlreadyHasName = displayedAgent?.scope === "global" && projectCwd
    ? snapshot.agents.some((candidate) => candidate.kind === "custom" && candidate.scope === "project" && candidate.projectCwd === projectCwd && candidate.name === displayedAgent.name)
    : false;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-slot="agents-screen"
      data-state="ready"
      data-settings-view={scopeView}
      onKeyDown={onKeyDown}
    >
      <ScopeDraftGuard drafts={editorDraft ? [editorDraft] : []} onGuardChange={setGuard} />
      <Header
        count={visibleCustom.length}
        warnings={warnings.length}
        mobile={mobile}
        editing={editing}
        title={selection?.kind === "agent" ? agentDisplayName(selection.name) : selection?.kind === "new" ? (newSeed ? "Project override" : "New agent") : selection?.kind === "harness" ? "Harness" : undefined}
        canCreate={canCreate}
        onNew={startNew}
        onBack={() => void select(null)}
      />
      <div className="flex shrink-0 items-center px-3 py-2 hairline-b"><SettingsScopeControls /></div>
      {write.state === "explained" ? <div className="px-4 pt-4 md:px-6"><CapabilityNotice explanation={write.explanation} /></div> : null}
      {scopeMissing ? (
        <ScopeEmpty
          unavailable={settingsScope.projectCwd !== undefined}
          view={scopeView === "effective" ? "effective" : "project"}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {showList ? (
            <ScrollArea className={cn("min-h-0 shrink-0", mobile ? "w-full" : "w-72 hairline-e")}>
              <AgentList
                snapshot={snapshot}
                view={scopeView}
                projectCwd={projectCwd}
                warnings={warnings}
                selection={selection}
                onSelect={(next) => void select(next)}
                lead={mobile && canCreate && isFirstRun(snapshot, scopeView, projectCwd) ? (
                  <AgentsOverview
                    compact
                    snapshot={snapshot}
                    view={scopeView}
                    projectCwd={projectCwd}
                    warnings={warnings}
                    onNew={startNew}
                    onOpen={(next, field) => void select(next, field)}
                  />
                ) : undefined}
              />
            </ScrollArea>
          ) : null}
          {showEditor ? (
            <AgentsEditorColumn
              environmentKey={device.environmentKey}
              editorKey={editorKey}
              mobile={mobile}
              selection={selection}
              displayedAgent={displayedAgent}
              newSeed={newSeed}
              snapshot={snapshot}
              scopeView={scopeView}
              routeCwd={routeCwd}
              settingsView={settingsView}
              projectCwd={projectCwd}
              warnings={selectedWarnings}
              focus={focus}
              canCreate={canCreate}
              environmentWritable={environmentWritable}
              inheritedGlobal={inheritedGlobal}
              projectAlreadyHasName={projectAlreadyHasName}
              editableDefinition={editableDefinition}
              overview={scopeView === "effective" ? (
                <ReadonlyIntro
                  title="Effective agents"
                  detail="This is the resolved catalog for the selected project. Choose a definition to inspect it, or choose Global or Project above to edit its source."
                />
              ) : (
                <AgentsOverview
                  snapshot={snapshot}
                  view={scopeView}
                  projectCwd={projectCwd}
                  warnings={warnings}
                  onNew={startNew}
                  onOpen={(next, field) => void select(next, field)}
                />
              )}
              onBack={() => void select(null)}
              onStartOverride={startOverride}
              onDraftChange={setEditorDraft}
              onMutationPending={onMutationPending}
              onSaved={onSaved}
              onDeleted={onDeleted}
              onStartChat={(name) => void startChat(name)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ScopeEmpty({ unavailable, view }: { unavailable: boolean; view: "project" | "effective" }) {
  return <ReadonlyIntro title={unavailable ? "This project is unavailable" : `Choose a project for ${view === "effective" ? "Effective" : "Project"} agents`} detail={unavailable ? "The selected project is no longer in this environment. Choose another project above. Nothing will be read or written until you do." : "Use the project picker above. Agents never borrow the project open in Code or choose the first project for you."} />;
}

function RouteError({ error, onRetry }: { error: string | undefined; onRetry(): void }) {
  return <div className="p-4">{error ? <ErrorState title="Couldn’t open the Global settings service" detail={error} onRetry={onRetry} /> : <p className="text-sm text-ink-2" role="status">Loading Global agent details…</p>}</div>;
}

function Header({ count, warnings, mobile, editing, title, canCreate, onNew, onBack }: { count: number | undefined; warnings: number; mobile: boolean; editing: boolean; title?: string | undefined; canCreate: boolean; onNew(): void; onBack(): void }) {
  const summary = count === undefined ? undefined : `${count} agent${count === 1 ? "" : "s"}${warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-3 hairline-b">
      {mobile && editing ? <><TooltipIconButton tooltip="Back to agents" side="bottom" onClick={onBack} data-slot="agents-back"><ChevronLeft className="rtl:-scale-x-100" /></TooltipIconButton><h2 className="min-w-0 truncate text-sm font-semibold text-ink">{title ?? "Agents"}</h2></> : <><h2 className="text-sm font-semibold text-ink">Agents</h2>{summary ? <span className="typed truncate text-ink-3">{summary}</span> : null}</>}
      {canCreate && !(mobile && editing) ? <Button type="button" size="sm" variant="secondary" className="ms-auto" onClick={onNew} data-slot="agents-new"><Plus />New agent</Button> : null}
    </div>
  );
}

function PageSkeleton({ mobile }: { mobile: boolean }) {
  return <div className="flex min-h-0 flex-1" aria-busy="true" aria-label="Loading agents" role="status"><div className={cn("flex shrink-0 flex-col gap-2 px-3 py-4", mobile ? "w-full" : "w-72 hairline-e")}>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>{!mobile ? <div className="mx-auto flex w-full max-w-180 flex-col gap-4 px-6 py-5"><Skeleton className="h-36 w-full rounded-xl" />{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div> : null}</div>;
}
