"use client";
/**
 * + Create — five purposeful first revisions behind one project-scoped dialog.
 *
 * Every kind still starts with only a title and its primary thought. The visible
 * structure below that pair is optional, but it is the actual closed body
 * schema rather than a generic note flattened into `brief` (D-352, D-355).
 */
import { Plus } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PROJECT_WORK_KEY_PREFIXES,
  PROJECT_WORK_KINDS,
  PROJECT_WORK_TEXT_MAX,
  PROJECT_WORK_TITLE_MAX,
  RESEARCH_QUESTION_MAX,
  parseProjectWorkKey,
  type ProjectWorkKind,
} from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  newCreateDrafts,
  validateCreateDraft,
  type CreateDraft,
  type CreateDrafts,
} from "@/project-work/create-draft";
import { useCapability, useLaserStable, useLaserState } from "@/runtime";
import { openWorkCreate, selectWork, setWorkspaceTab, useProjectWorkSnapshot, useWorkspaceUi, type ProjectWorkStore } from "@/project-work";
import { KIND_FIELD, KIND_ICON, KIND_LABEL, KIND_TEXT } from "@/project-work/vocabulary";

import { KindCreateFields } from "./CreateKindFields.js";
import {
  MarkdownAuthoringField,
  MarkdownEditorActivationProvider,
  type MarkdownAuthoringFieldHandle,
} from "./MarkdownAuthoringField.js";
import { WorkRefusal } from "./states.js";

export function nextKeyFor(kind: ProjectWorkKind, keys: readonly string[]): string {
  let highest = 0;
  for (const key of keys) {
    const parsed = parseProjectWorkKey(key);
    if (parsed?.kind === kind && parsed.number > highest) highest = parsed.number;
  }
  return `${PROJECT_WORK_KEY_PREFIXES[kind]}-${highest + 1}`;
}

const KIND_PURPOSE: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "Define the problem, intended outcomes, requirements, and acceptance contract.",
  research: "Frame an open question and the boundaries of an evidence-backed investigation.",
  design: "Set the experience intent and visual direction before a real screen or flow exists.",
  plan: "Describe delivery phases and a dependency graph, never a schedule.",
  task: "Name a concrete outcome, affected scope, dependencies, and proof of done.",
};

interface FieldErrors {
  title?: string;
  primary?: string;
  details?: string;
}

export function CreateDialog({ store }: { store: ProjectWorkStore | undefined }) {
  const ui = useWorkspaceUi();
  const work = useProjectWorkSnapshot(store);
  const { actions } = useLaserStable();
  const agentDefinitions = useLaserState((state) => state.agents.snapshot?.agents);
  const agentNames = useMemo(() => agentDefinitions?.map((agent) => agent.name) ?? [], [agentDefinitions]);
  const create = useCapability("project/work/create", { presentation: "explained" });
  const [kind, setKind] = useState<ProjectWorkKind>("spec");
  const [drafts, setDrafts] = useState<CreateDrafts>(newCreateDrafts);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [hostError, setHostError] = useState<string | undefined>(undefined);
  const wasOpen = useRef(false);
  const primaryEditors = useRef<Partial<Record<ProjectWorkKind, MarkdownAuthoringFieldHandle>>>({});
  const busyRef = useRef(false);
  const scope = useRef(0);

  const open = ui.creating !== undefined;
  const projectId = work.projectId;

  useLayoutEffect(() => {
    scope.current += 1;
    busyRef.current = false;
    setBusy(false);
    if (open && !wasOpen.current) {
      setKind(ui.creating ?? "spec");
      setDrafts(newCreateDrafts());
      setDraftEpoch((current) => current + 1);
      setErrors({});
      setHostError(undefined);
    } else if (open && ui.creating !== undefined) {
      setKind(ui.creating);
    }
    wasOpen.current = open;
  }, [open, projectId, store, ui.creating]);

  const active = drafts[kind];
  const nextKey = useMemo(() => nextKeyFor(kind, work.items.map((item) => item.key)), [kind, work.items]);

  const updateDraft = (next: CreateDraft): void => {
    if (busyRef.current) return;
    setDrafts((current) => ({ ...current, [next.kind]: next }) as CreateDrafts);
    setErrors({});
  };

  const close = (): void => {
    if (busyRef.current) return;
    scope.current += 1;
    setDrafts(newCreateDrafts());
    setDraftEpoch((current) => current + 1);
    setErrors({});
    setHostError(undefined);
    openWorkCreate(undefined);
  };

  const submit = async (): Promise<void> => {
    if (busyRef.current || !store || create.state !== "available") return;
    const snapshot = drafts[kind];
    const checked = validateCreateDraft(snapshot, work.items);
    if (!checked.body) {
      const nextErrors: FieldErrors = {
        ...(checked.title !== undefined ? { title: checked.title } : {}),
        ...(checked.primary !== undefined ? { primary: checked.primary } : {}),
        ...(checked.details !== undefined ? { details: checked.details } : {}),
      };
      setErrors(nextErrors);
      const target = checked.title ? `${kind}-create-title` : checked.primary ? `${kind}-create-primary` : `${kind}-create-details`;
      requestAnimationFrame(() => {
        if (checked.primary) {
          primaryEditors.current[kind]?.focus();
          return;
        }
        document.getElementById(target)?.focus();
      });
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setErrors({});
    const requestScope = scope.current;
    const requestStore = store;
    const outcome = await requestStore.create({ title: snapshot.title.trim(), body: checked.body });
    if (requestScope !== scope.current || requestStore !== store) return;
    busyRef.current = false;
    setBusy(false);
    if (!outcome.ok) {
      setHostError(outcome.failure.message);
      return;
    }
    const { entity } = outcome.value;
    actions.toast("info", `${entity.key} created`);
    scope.current += 1;
    setDrafts(newCreateDrafts());
    setDraftEpoch((current) => current + 1);
    setHostError(undefined);
    openWorkCreate(undefined);
    setWorkspaceTab("work");
    selectWork({ entityId: entity.entityId, kind: entity.kind });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openWorkCreate(kind) : close())}>
      <DialogContent className="flex max-h-[calc(100dvh-var(--space-unit)*4)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-line p-4 pb-3">
          <DialogTitle>Create project work</DialogTitle>
          <DialogDescription>Start with the minimum, or write the useful structure now. Every kind can exist on its own.</DialogDescription>
        </DialogHeader>

        <fieldset className="flex shrink-0 flex-wrap gap-1.5 border-b border-line px-4 py-3" disabled={busy}>
          <legend className="sr-only">Kind</legend>
          {PROJECT_WORK_KINDS.map((candidate) => {
            const Icon = KIND_ICON[candidate];
            const on = candidate === kind;
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(candidate)}
                className={cn(
                  "flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm leading-5 outline-none",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                  on ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-3.5", KIND_TEXT[candidate])} />
                {KIND_LABEL[candidate]}
              </button>
            );
          })}
        </fieldset>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {PROJECT_WORK_KINDS.map((candidate) => {
            const draft = drafts[candidate];
            const field = KIND_FIELD[candidate];
            const shown = candidate === kind;
            return (
              <form
                key={`${draftEpoch}:${candidate}`}
                aria-hidden={!shown}
                className={cn(!shown && "hidden")}
                onSubmit={(event) => event.preventDefault()}
              >
                <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 border-0 p-0">
                <MarkdownEditorActivationProvider active={shown} readOnly={busy}>
                <div className="flex items-start gap-3 rounded-lg bg-surface-2 p-3">
                  {(() => { const Icon = KIND_ICON[candidate]; return <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", KIND_TEXT[candidate])} />; })()}
                  <div><p className="text-sm font-medium text-ink">{KIND_LABEL[candidate]}</p><p className="text-xs leading-xs text-ink-2">{KIND_PURPOSE[candidate]}</p></div>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="eyebrow">Title</span>
                    <span className="text-xs leading-xs text-ink-3">Next key <span className="typed text-ink-2">{shown ? nextKey : nextKeyFor(candidate, work.items.map((item) => item.key))}</span> · assigned when it is created</span>
                  </span>
                  <Input
                    id={`${candidate}-create-title`}
                    autoFocus={shown}
                    value={draft.title}
                    maxLength={PROJECT_WORK_TITLE_MAX}
                    aria-invalid={shown && errors.title ? true : undefined}
                    aria-describedby={shown && errors.title ? `${candidate}-title-error` : undefined}
                    onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                    onChange={(event) => updateDraft({ ...draft, title: event.target.value })}
                    placeholder={`What this ${KIND_LABEL[candidate].toLocaleLowerCase()} is called`}
                    disabled={busy}
                  />
                  {shown && errors.title ? <span id={`${candidate}-title-error`} className="text-xs text-danger">{errors.title}</span> : null}
                </label>

                <div id={`${candidate}-create-primary`} tabIndex={-1}>
                  <MarkdownAuthoringField
                    ref={(editor) => {
                      if (editor) primaryEditors.current[candidate] = editor;
                      else delete primaryEditors.current[candidate];
                    }}
                    label={field.label}
                    editorKey={`${candidate}:primary`}
                    value={draft.primary}
                    maxLength={candidate === "research" ? RESEARCH_QUESTION_MAX : PROJECT_WORK_TEXT_MAX}
                    placeholder={field.placeholder}
                    error={shown ? errors.primary : undefined}
                    onChange={(primary) => updateDraft({ ...draft, primary })}
                    onCreateShortcut={() => { void submit(); }}
                  />
                </div>

                <div id={`${candidate}-create-details`} tabIndex={-1}>
                  <KindCreateFields draft={draft} items={work.items} agentNames={agentNames} onChange={updateDraft} onCreateShortcut={() => { void submit(); }} />
                </div>
                {shown && errors.details ? <p role="alert" className="text-xs text-danger">{errors.details}</p> : null}
                </MarkdownEditorActivationProvider>
                </fieldset>
              </form>
            );
          })}
          {create.state === "explained" ? <p className="mt-3 text-xs leading-xs text-ink-2">{create.explanation}</p> : null}
          {hostError ? <div className="mt-3"><WorkRefusal message={hostError} /></div> : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-line bg-surface p-3 [padding-bottom:max(calc(var(--space-unit)*3),env(safe-area-inset-bottom))]">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button
            type="button"
            onClick={() => { void submit(); }}
            disabled={busy || !store || create.state !== "available" || active.title.trim() === "" || active.primary.trim() === ""}
          >
            <Plus />
            {busy ? "Creating…" : `Create ${KIND_LABEL[kind].toLocaleLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
