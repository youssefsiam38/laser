"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { WorkBodyContext } from "./bodies/context.js";
import { MarkdownEditorActivationProvider } from "./MarkdownAuthoringField.js";

export interface WorkEditOwner<Body> {
  id: number;
  store: NonNullable<WorkBodyContext["store"]>;
  projectId: string;
  entityId: string;
  selectionRevisionId: string | undefined;
  baseRevisionId: string;
  baseRevisionIndex: number;
  baseTitle: string;
  baseBody: Body;
}

type SubmitResult<Value> =
  | { kind: "settled"; value: Value }
  | { kind: "blocked" }
  | { kind: "ignored" };

const sameOwner = (owner: WorkEditOwner<unknown>, context: WorkBodyContext): boolean =>
  context.store === owner.store &&
  context.detail.ref.projectId === owner.projectId &&
  context.detail.entity.entityId === owner.entityId &&
  context.selectionRevisionId === owner.selectionRevisionId;

/**
 * Owns the lifetime around a kind-specific draft.
 *
 * The body remains kind-specific. This hook owns only identity, admission and
 * settlement: the base fence is captured once; a synchronous ref admits one
 * submit; and a late answer may settle only the exact owner that sent it.
 */
export function useWorkEditSession<Body>(context: WorkBodyContext) {
  const [owner, setOwner] = useState<WorkEditOwner<Body>>();
  const [pending, setPending] = useState(false);
  const ownerRef = useRef<WorkEditOwner<Body> | undefined>(undefined);
  const contextRef = useRef(context);
  const submitting = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  contextRef.current = context;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      ownerRef.current = undefined;
      submitting.current = false;
    };
  }, []);

  const matches = owner !== undefined && sameOwner(owner, context);

  useEffect(() => {
    if (!owner || matches) return;
    generation.current += 1;
    ownerRef.current = undefined;
    submitting.current = false;
    setPending(false);
    setOwner(undefined);
  }, [matches, owner]);

  const begin = useCallback((body: Body): WorkEditOwner<Body> | undefined => {
    const current = contextRef.current;
    if (!current.store || !current.editable) return undefined;
    const next: WorkEditOwner<Body> = {
      id: ++generation.current,
      store: current.store,
      projectId: current.detail.ref.projectId,
      entityId: current.detail.entity.entityId,
      selectionRevisionId: current.selectionRevisionId,
      baseRevisionId: current.detail.revision.revisionId,
      baseRevisionIndex: current.detail.revision.index,
      baseTitle: current.detail.revision.title,
      baseBody: structuredClone(body),
    };
    ownerRef.current = next;
    submitting.current = false;
    setPending(false);
    setOwner(next);
    return next;
  }, []);

  const ensure = useCallback((body: Body): WorkEditOwner<Body> | undefined => {
    const current = ownerRef.current;
    return current && sameOwner(current, contextRef.current) ? current : begin(body);
  }, [begin]);

  // An accepted save can keep a canvas open on the exact body the host just
  // accepted, while moving the next fence to the returned child revision.
  const rebase = useCallback((body: Body, baseTitle: string, baseRevisionId: string, baseRevisionIndex: number): WorkEditOwner<Body> | undefined => {
    const current = contextRef.current;
    if (!current.store) return undefined;
    const next: WorkEditOwner<Body> = {
      id: ++generation.current,
      store: current.store,
      projectId: current.detail.ref.projectId,
      entityId: current.detail.entity.entityId,
      selectionRevisionId: current.selectionRevisionId,
      baseRevisionId,
      baseRevisionIndex,
      baseTitle,
      baseBody: structuredClone(body),
    };
    ownerRef.current = next;
    submitting.current = false;
    setPending(false);
    setOwner(next);
    return next;
  }, []);

  const cancel = useCallback((): boolean => {
    if (submitting.current) return false;
    generation.current += 1;
    ownerRef.current = undefined;
    setOwner(undefined);
    setPending(false);
    return true;
  }, []);

  const submit = useCallback(async <Value,>(run: (base: WorkEditOwner<Body>) => Promise<Value>): Promise<SubmitResult<Value>> => {
    const base = ownerRef.current;
    const current = contextRef.current;
    if (submitting.current || !base || !sameOwner(base, current) || !current.editable) return { kind: "blocked" };
    submitting.current = true;
    setPending(true);
    const ownerId = base.id;
    let value: Value;
    try {
      value = await run(base);
    } finally {
      const latest = ownerRef.current;
      const ownsSettlement = mounted.current && latest?.id === ownerId && sameOwner(latest, contextRef.current);
      if (ownsSettlement) {
        submitting.current = false;
        setPending(false);
      }
    }
    const latest = ownerRef.current;
    if (!mounted.current || latest?.id !== ownerId || !sameOwner(latest, contextRef.current)) return { kind: "ignored" };
    return { kind: "settled", value };
  }, []);

  return {
    owner,
    matches,
    pending,
    locked: pending || !context.editable || !matches,
    canSubmit: matches && context.editable && !pending,
    newerRevision: matches && owner.selectionRevisionId === undefined && context.detail.revision.index > owner.baseRevisionIndex,
    begin,
    ensure,
    rebase,
    cancel,
    submit,
  };
}

/** One freeze mechanism for native controls and the real CodeMirror editor. */
export function WorkEditFields({ locked, children }: { locked: boolean; children: ReactNode }) {
  return (
    <fieldset disabled={locked} className="contents">
      <MarkdownEditorActivationProvider active readOnly={locked}>
        {children}
      </MarkdownEditorActivationProvider>
    </fieldset>
  );
}

export function WorkEditFooter({
  compact,
  pending,
  canSave,
  saveLabel,
  onCancel,
  onSave,
}: {
  compact: boolean | undefined;
  pending: boolean;
  canSave: boolean;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!compact) return null;
  return (
    <footer
      data-slot="work-edit-footer"
      className="sticky bottom-0 z-10 -mx-3 flex items-center justify-end gap-1.5 border-t border-line bg-bg px-3 py-2 pb-[max(var(--spacing)*2,env(safe-area-inset-bottom))]"
    >
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
      <Button size="sm" disabled={!canSave} onClick={onSave}>{pending ? "Saving…" : saveLabel}</Button>
    </footer>
  );
}

export function WorkEditNewerNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p role="status" data-slot="newer-revision-notice" className="rounded-lg border border-attention/40 bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] p-3 text-sm leading-5 text-ink-2">
      A newer revision is available. Your draft still belongs to the revision you started from; saving will keep that original fence and may be refused. Cancel to read the newer revision.
    </p>
  );
}
