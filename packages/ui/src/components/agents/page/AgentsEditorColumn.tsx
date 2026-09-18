"use client";

import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentWarning,
  AgentsSnapshot,
} from "@lasercode/protocol";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import { isBuiltinAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AgentEditor, type EditorFocus } from "./AgentEditor.js";
import { BuiltinPanel } from "./BuiltinPanel.js";
import { HarnessPanel } from "./HarnessPanel.js";
import { locationOfAgent, type AgentsScopeView, type AgentsSelection } from "./model.js";

export interface AgentsEditorColumnProps {
  environmentKey?: string | undefined;
  editorKey: string;
  mobile: boolean;
  selection: AgentsSelection;
  displayedAgent?: AgentDefinition | undefined;
  newSeed?: AgentDefinitionInput | undefined;
  snapshot: AgentsSnapshot;
  scopeView: AgentsScopeView;
  routeCwd?: string | undefined;
  settingsView: "global" | "effective";
  projectCwd?: string | undefined;
  warnings: readonly AgentWarning[];
  focus?: EditorFocus | undefined;
  canCreate: boolean;
  environmentWritable: boolean;
  inheritedGlobal: boolean;
  projectAlreadyHasName: boolean;
  editableDefinition: boolean;
  overview: ReactNode;
  onBack(): void;
  onStartOverride(agent: AgentDefinition): void;
  onDraftChange: Dispatch<SetStateAction<import("@/components/settings/ScopeDraftGuard").ScopeDraft | undefined>>;
  onMutationPending(operation: symbol, pending: boolean): void;
  onSaved(agent: AgentDefinition): void;
  onDeleted(): void;
  onStartChat(name: string): void;
}

/** The definition detail pane, isolated from scope and navigation ownership. */
export function AgentsEditorColumn(props: AgentsEditorColumnProps) {
  const {
    environmentKey,
    editorKey,
    mobile,
    selection,
    displayedAgent,
    newSeed,
    snapshot,
    scopeView,
    routeCwd,
    settingsView,
    projectCwd,
    warnings,
    focus,
    canCreate,
    environmentWritable,
    inheritedGlobal,
    projectAlreadyHasName,
    editableDefinition,
    overview,
    onBack,
    onStartOverride,
    onDraftChange,
    onMutationPending,
    onSaved,
    onDeleted,
    onStartChat,
  } = props;

  return (
    <div
      key={`${environmentKey ?? "inactive"}:${editorKey}`}
      data-slot="agents-editor-column"
      className={cn(
        "min-h-0 min-w-0 flex-1 overflow-y-auto",
        mobile
          && "animate-in fade-in-0 ltr:slide-in-from-right-2 rtl:slide-in-from-left-2 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none",
      )}
    >
      {selection === null ? overview : selection.kind === "harness" ? (
        <HarnessPanel snapshot={snapshot} writable={environmentWritable && scopeView === "global"} />
      ) : selection.kind === "new" ? (
        <AgentEditor
          agent={undefined}
          seed={newSeed}
          snapshot={snapshot}
          destination={selection.location}
          routeCwd={routeCwd}
          settingsView={settingsView}
          projectCwd={projectCwd}
          warnings={[]}
          focus={focus}
          writable={canCreate}
          onDirtyChange={() => undefined}
          onDraftChange={onDraftChange}
          onMutationPending={onMutationPending}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onStartChat={onStartChat}
        />
      ) : displayedAgent === undefined ? (
        <div className="p-4">
          <DefinitionGone name={selection.name} onBack={onBack} />
        </div>
      ) : isBuiltinAgent(displayedAgent) ? (
        <BuiltinPanel
          name={displayedAgent.name as "beam" | "chat" | "namer"}
          snapshot={snapshot}
          routeCwd={routeCwd}
          writable={environmentWritable && scopeView === "global"}
        />
      ) : (
        <>
          {inheritedGlobal ? (
            <div
              className="mx-auto flex w-full max-w-180 items-center justify-between gap-3 px-4 pt-5 md:px-6"
              data-slot="agent-inherited-notice"
            >
              <p className="text-sm text-ink-2">This project is using the read-only Global source.</p>
              {!projectAlreadyHasName && environmentWritable ? (
                <Button type="button" size="sm" onClick={() => onStartOverride(displayedAgent)}>
                  Create Project override
                </Button>
              ) : null}
            </div>
          ) : scopeView === "effective" ? (
            <ReadonlyIntro
              compact
              title="Resolved definition"
              detail="Effective is read-only. Choose Global or Project above to edit its source."
            />
          ) : null}
          <AgentEditor
            agent={displayedAgent}
            snapshot={snapshot}
            destination={locationOfAgent(displayedAgent)}
            routeCwd={routeCwd}
            settingsView={settingsView}
            projectCwd={projectCwd}
            warnings={warnings}
            focus={focus}
            writable={editableDefinition}
            onDirtyChange={() => undefined}
            onDraftChange={onDraftChange}
            onMutationPending={onMutationPending}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onStartChat={onStartChat}
          />
        </>
      )}
    </div>
  );
}

function DefinitionGone({ name, onBack }: { name: string; onBack(): void }) {
  return (
    <div role="alert" className="rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold text-ink">There is no agent named “{name}” at that location any more</h3>
      <p className="mt-1 text-sm text-ink-2">It may have been deleted from another view.</p>
      <Button type="button" variant="outline" className="mt-3" onClick={onBack}>Back to the list</Button>
    </div>
  );
}

export function ReadonlyIntro({ title, detail, compact = false }: { title: string; detail: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-180 flex-col gap-1",
        compact ? "px-4 pt-5 md:px-6" : "px-4 py-5 md:px-6",
      )}
      data-slot="agents-readonly-intro"
    >
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="text-sm leading-6 text-ink-2">{detail}</p>
    </div>
  );
}
