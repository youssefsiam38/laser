"use client";
/**
 * The Design detail: canvas, inspector, prototype, full screen (M21-T11;
 * leap "Detail, by kind → Design"; `docs/design-phase.md`).
 *
 * The canvas is the body. Everything a person can do to a design happens on
 * it or in the inspector beside it, and both produce the same revision — one
 * draft body, written through `project/work/revise` with the revision the
 * person was reading as the fence. A conflict says so and offers the latest;
 * it never overwrites what this window never saw.
 *
 * What this window cannot do yet is drawn as a designed state that says why:
 * the Design Index panel's review and re-index, and "Ground it", both wait on
 * the wire M21-T17 lays between the worker's index and this window; the
 * hand-off ("Implement…") is the `/design implement @KEY` form of the same
 * task. None of them is a dead button.
 *
 * The phone gets the same canvas, read-only: pan, zoom, tap to inspect, and a
 * full-screen prototype. Editing needs a wider window, and it says so.
 */
import { Copy, Hammer, Layers, Maximize2, Play, RefreshCw, Save, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignBody, DesignIndex, DesignIndexEntry, DesignTokenGroup } from "@lasercode/protocol";
import { designAggregateFidelity, designIsSketchOnly, designTokenDocumentSchema, validateDesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DesignCanvas } from "@/components/design/DesignCanvas";
import { DesignIndexPanel, type DesignIndexAccess } from "@/components/design/DesignIndexPanel";
import { NodeInspector } from "@/components/design/NodeInspector";
import { PrototypeStage } from "@/components/design/PrototypeStage";
import { ScreenInspector, type GroundSketch } from "@/components/design/ScreenInspector";
import { FIDELITY_LABEL, FIDELITY_TONE, type SketchBytes } from "@/components/design/ScreenFrame";
import type { KitIndexEntry, KitRenderContext } from "@/components/design/kit/KitNode";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { KIT_NAMES } from "@/design/kit";
import { startPrototype, triggerPrototype, type PrototypeState } from "@/design/prototype";
import { SKETCH_GATE_REFUSAL } from "@/design/sketch";
import { frameTokens } from "@/design/tokens";
import { designIsEmpty, nodeOf, nudgeNode, reorderChild, screenOf, screenOfNode, setNodeText } from "@/design/tree-model";

import type { WorkBodyContext } from "./context.js";
import { EmptyBody, Prose, Section } from "./fields.js";

/** The sentence the Design Index panel shows until M21-T17 lays the wire. */
export const INDEX_PENDING_SENTENCE =
  "The design index is built and reviewed from a session: the model reads the project's source, and you accept, rename, merge or reject what it found. This window will read it once the model tools land; until then, open this design in a session and ask for the index.";

/** The sentence "Implement…" shows until the hand-off form exists (M21-T17). */
export const IMPLEMENT_PENDING_SENTENCE =
  "Hand-off pulls this exact revision — its screens, the index entries it uses, its fixtures and unresolved comments — into a session as the implementation context. That form of /design lands with the model tools; until then, copy the key and ask for it in a session on this project.";

interface BlobRequest {
  request: <M extends "project/work/blob/read">(
    method: M,
    params: { projectId: string; blobId: string; offset?: number; limit?: number },
  ) => Promise<{ data?: string; nextOffset?: number; bytes: number; released?: { detail: string } }>;
}

export interface DesignDetailProps {
  body: DesignBody;
  context: WorkBodyContext;
  /** The reviewed index, when this window can read one. */
  index?: DesignIndex | undefined;
  indexAccess?: DesignIndexAccess | undefined;
  groundSketch?: GroundSketch | undefined;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function DesignDetail({ body, context, index, indexAccess, groundSketch }: DesignDetailProps) {
  const { actions, client } = useLaserStable() as { actions: { toast: (kind: "info" | "error", message: string) => void }; client?: BlobRequest };
  // The blob reads below depend on *having* a client, not on its identity: a
  // provider that hands out a fresh object must not restart every read.
  const clientRef = useRef<BlobRequest | undefined>(client);
  clientRef.current = client;
  const hasClient = client !== undefined;
  const { copy } = useCopy();
  const compact = context.compact === true;
  const projectId = context.detail.ref.projectId;

  // -- the draft ------------------------------------------------------------
  const [draft, setDraft] = useState<DesignBody>(body);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(body);
    setConflict(undefined);
  }, [body]);
  const dirty = draft !== body;
  const editable = context.editable && !compact;
  const readOnlyReason = compact ? "Editing a design needs a wider window. Here you can read it, inspect any node and play it." : context.readOnlyReason;

  const save = useCallback(async () => {
    if (!context.store) return;
    const validation = validateDesignBody(draft, { primitives: KIT_NAMES });
    if (!validation.ok) {
      actions.toast("error", validation.issues[0]?.message ?? "This design has a problem that has to be fixed first.");
      return;
    }
    setSaving(true);
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "design", design: draft },
      { note: "Edited on the canvas" },
    );
    setSaving(false);
    if (outcome.ok) {
      actions.toast("info", `${context.detail.entity.key} · revision ${outcome.value.revision.index} saved`);
      context.onChanged();
      return;
    }
    if (outcome.failure.kind === "conflict") {
      setConflict(outcome.failure.message);
      return;
    }
    actions.toast("error", outcome.failure.message);
  }, [actions, context, draft]);

  // -- selection ------------------------------------------------------------
  const [selectedScreenId, setSelectedScreenId] = useState<string | undefined>(() => body.screens[0]?.id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [editingNodeId, setEditingNodeId] = useState<string | undefined>(undefined);
  const selectedScreen = screenOf(draft, selectedScreenId) ?? draft.screens[0];
  const selectedNode = nodeOf(selectedScreen, selectedNodeId);

  const selectNode = useCallback(
    (nodeId: string) => {
      if (nodeId === "") {
        setSelectedNodeId(undefined);
        return;
      }
      const owner = screenOfNode(draft, nodeId);
      if (owner) setSelectedScreenId(owner.id);
      setSelectedNodeId(nodeId);
    },
    [draft],
  );

  // -- tokens and entries ---------------------------------------------------
  const [foundationTokens, setFoundationTokens] = useState<DesignTokenGroup | undefined>(undefined);
  useEffect(() => {
    const blobId = body.foundation?.tokensBlobId;
    const reader = clientRef.current;
    if (!blobId || !reader || index?.tokensDocument) return;
    let cancelled = false;
    void readBlob(reader, projectId, blobId).then((outcome) => {
      if (cancelled || !outcome.ok) return;
      try {
        const parsed = designTokenDocumentSchema.safeParse(JSON.parse(outcome.text));
        if (parsed.success) setFoundationTokens(parsed.data);
      } catch {
        // A foundation blob that is not a token document is not an error the
        // canvas needs to announce: the frame draws in this app's tokens and
        // the note under the canvas says so.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [body.foundation?.tokensBlobId, hasClient, index?.tokensDocument, projectId]);

  const tokens = useMemo(() => frameTokens(index?.tokensDocument ?? foundationTokens), [index?.tokensDocument, foundationTokens]);
  const entries = useMemo(() => {
    const map = new Map<string, KitIndexEntry>();
    for (const entry of index?.entries ?? []) {
      map.set(entry.id, { id: entry.id, name: entry.name, ...(entry.detail ? { detail: entry.detail } : {}), reviewed: entry.review.state !== "unreviewed" });
    }
    return map;
  }, [index?.entries]);
  const entryById = useMemo(() => new Map<string, DesignIndexEntry>((index?.entries ?? []).map((entry) => [entry.id, entry])), [index?.entries]);
  const usedEntryIds = useMemo(() => {
    const used = new Set<string>();
    for (const screen of draft.screens) {
      if (!("tree" in screen.content)) continue;
      for (const node of screen.content.tree.nodes) if ("indexEntryId" in node.component) used.add(node.component.indexEntryId);
    }
    return used;
  }, [draft.screens]);

  const access: DesignIndexAccess = indexAccess ?? {
    state: index ? { kind: "ready", index } : { kind: "unavailable", detail: INDEX_PENDING_SENTENCE },
    writeRefusal: index ? "Reviewing entries from this window lands with the model tools; until then, review in a session." : undefined,
  };

  // -- sketches -------------------------------------------------------------
  const [sketchBytes, setSketchBytes] = useState<Record<string, SketchBytes>>({});
  useEffect(() => {
    const reader = clientRef.current;
    if (!reader) return;
    let cancelled = false;
    for (const screen of body.screens) {
      const content = screen.content;
      if (!("sketchId" in content)) continue;
      const sketch = body.sketches.find((candidate) => candidate.id === content.sketchId);
      if (!sketch) continue;
      setSketchBytes((current) => ({ ...current, [screen.id]: { loading: true } }));
      void readBlob(reader, projectId, sketch.blobId).then((outcome) => {
        if (cancelled) return;
        setSketchBytes((current) => ({ ...current, [screen.id]: outcome.ok ? { document: outcome.text } : { error: outcome.message } }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [body.screens, body.sketches, hasClient, projectId]);

  // -- prototype ------------------------------------------------------------
  const [prototype, setPrototype] = useState<PrototypeState | undefined>(undefined);
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!fullScreen) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fullScreenRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullScreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus();
    };
  }, [fullScreen]);

  // -- render contexts ------------------------------------------------------
  const commentedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const comment of context.detail.comments ?? []) {
      if (comment.anchor.target === "node") ids.add(comment.anchor.nodeId);
    }
    return ids;
  }, [context.detail.comments]);

  const contextFor = useCallback(
    (screenId: string, mode: KitRenderContext["mode"]): KitRenderContext => {
      const screen = screenOf(draft, screenId);
      if (!screen) throw new Error(`no screen ${screenId}`);
      return {
        body: draft,
        screen,
        entries,
        mode,
        selectedNodeId: mode === "edit" ? selectedNodeId : undefined,
        editingNodeId: mode === "edit" ? editingNodeId : undefined,
        nodeStates: prototype?.nodeStates ?? {},
        nodeVariants: prototype?.nodeVariants ?? {},
        commentedNodeIds,
        onSelect: selectNode,
        onActivate: (nodeId, trigger) => setPrototype((current) => (current ? triggerPrototype(current, draft, { nodeId, trigger }) : current)),
        onBeginTextEdit: editable ? (nodeId) => setEditingNodeId(nodeId) : undefined,
        onCommitText: editable
          ? (nodeId, text) => {
              setEditingNodeId(undefined);
              setDraft((current) => setNodeText(current, screenId, nodeId, text));
            }
          : undefined,
        onReorder: editable ? (parentId, from, to) => setDraft((current) => reorderChild(current, screenId, parentId, from, to)) : undefined,
      };
    },
    [commentedNodeIds, draft, editable, editingNodeId, entries, prototype, selectNode, selectedNodeId],
  );
  const editContext = useCallback((screenId: string) => contextFor(screenId, "edit"), [contextFor]);
  const playContext = useCallback((screenId: string) => contextFor(screenId, "prototype"), [contextFor]);

  // Alt+Arrow on the selected node moves it among its siblings: the keyboard
  // form of drag-reorder, and the one the tests exercise.
  const onDetailKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!editable || !selectedScreen || !selectedNodeId || !event.altKey) return;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setDraft((current) => nudgeNode(current, selectedScreen.id, selectedNodeId, -1));
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setDraft((current) => nudgeNode(current, selectedScreen.id, selectedNodeId, 1));
      }
    },
    [editable, selectedNodeId, selectedScreen],
  );

  const aggregate = designAggregateFidelity(draft);
  const sketchOnly = designIsSketchOnly(draft);
  const validation = useMemo(() => validateDesignBody(draft, { primitives: KIT_NAMES }), [draft]);

  if (designIsEmpty(draft)) {
    return (
      <div data-slot="design-detail" className="flex flex-col gap-5">
        <Section title="Brief">
          <Prose text={draft.brief} />
        </Section>
        <EmptyBody
          what="This design has a brief and nothing drawn yet."
          next="Screens arrive as the model composes them from this project's design index — or as a sketch, when the ask is exploratory. Ask for either in the chat with this design open."
        />
        <DesignIndexPanel access={access} />
      </div>
    );
  }

  const canvas = (
    <DesignCanvas
      body={draft}
      tokenProperties={tokens.properties}
      contextFor={editContext}
      sketchBytes={sketchBytes}
      selectedScreenId={selectedScreen?.id}
      onSelectScreen={(screenId) => {
        setSelectedScreenId(screenId);
        setSelectedNodeId(undefined);
      }}
      onFlipScreen={(screenId) => {
        setSelectedScreenId(screenId);
        setSelectedNodeId(undefined);
      }}
      onOpenFullScreen={fullScreen ? undefined : () => setFullScreen(true)}
      interactive
      className={fullScreen ? "h-full" : "h-[32rem] min-h-80"}
    />
  );

  const stage = prototype ? (
    <PrototypeStage
      body={draft}
      state={prototype}
      onState={setPrototype}
      tokenProperties={tokens.properties}
      contextFor={playContext}
      sketchBytes={sketchBytes}
      onExit={() => {
        setPrototype(undefined);
        if (compact) setFullScreen(false);
      }}
      className={fullScreen ? "h-full" : "h-[32rem] min-h-80"}
    />
  ) : null;

  const inspector = (
    <aside aria-label="Inspector" className="flex min-w-0 flex-col gap-5">
      {selectedNode && selectedScreen ? (
        <NodeInspector
          body={draft}
          screen={selectedScreen}
          node={selectedNode}
          tokens={tokens.tokens}
          entry={"indexEntryId" in selectedNode.component ? entryById.get(selectedNode.component.indexEntryId) : undefined}
          editable={editable}
          readOnlyReason={readOnlyReason}
          onChange={setDraft}
          onSelect={selectNode}
        />
      ) : selectedScreen ? (
        <ScreenInspector body={draft} screen={selectedScreen} groundSketch={groundSketch} onGrounded={context.onChanged} />
      ) : null}
      <DesignIndexPanel access={access} usedEntryIds={usedEntryIds} />
    </aside>
  );

  return (
    <div data-slot="design-detail" className="flex min-w-0 flex-col gap-4" onKeyDown={onDetailKeyDown}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3 py-2">
        <Badge variant={FIDELITY_TONE[aggregate]}>{FIDELITY_LABEL[aggregate]}</Badge>
        {draft.strategy ? <Badge variant="outline">{draft.strategy.kind === "island" ? "Island" : "Conform"}</Badge> : null}
        {draft.hostPage ? <Badge variant="mono">{draft.hostPage.routeOrPath}</Badge> : null}
        <span className="text-xs leading-xs text-ink-3">
          {draft.screens.length} screen{draft.screens.length === 1 ? "" : "s"} · {draft.flows.length} flow{draft.flows.length === 1 ? "" : "s"}
          {draft.sketches.length > 0 ? ` · ${String(draft.sketches.length)} sketch${draft.sketches.length === 1 ? "" : "es"}` : ""}
          {tokens.tokens.length > 0 ? ` · ${String(tokens.tokens.length)} tokens` : ""}
        </span>
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          {prototype ? (
            <Button size="sm" variant="outline" onClick={() => setPrototype(undefined)}>
              <Layers />
              Design
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPrototype(startPrototype(draft, selectedScreen?.id));
                if (compact) setFullScreen(true);
              }}
            >
              <Play />
              Prototype
            </Button>
          )}
          {!fullScreen ? (
            <Button size="sm" variant="ghost" onClick={() => setFullScreen(true)}>
              <Maximize2 />
              Full screen
            </Button>
          ) : null}
          <ImplementControl workKey={context.detail.entity.key} sketchOnly={sketchOnly} onCopy={() => void copy(context.detail.entity.key).then((ok) => actions.toast(ok ? "info" : "error", ok ? `${context.detail.entity.key} copied` : "Could not copy the key"))} />
          {editable ? (
            <>
              <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(body)}>
                <Undo2 />
                Discard
              </Button>
              <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                <Save />
                {saving ? "Saving…" : "Save revision"}
              </Button>
            </>
          ) : null}
        </span>
      </div>

      {conflict ? (
        <div role="alert" data-slot="revision-conflict" className="flex flex-wrap items-center gap-2 rounded-lg border border-attention/40 bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-3 py-2">
          <p className="min-w-0 flex-1 text-xs leading-xs text-ink-2">{conflict} Your edits are still here; read the latest revision and apply them again.</p>
          <Button size="xs" variant="outline" onClick={context.onChanged}>
            <RefreshCw />
            Read the latest
          </Button>
        </div>
      ) : null}

      {readOnlyReason && !editable ? (
        <p role="status" className="text-xs leading-xs text-ink-3">
          {readOnlyReason}
        </p>
      ) : null}

      {sketchOnly ? (
        <p role="status" data-slot="sketch-only-notice" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
          {SKETCH_GATE_REFUSAL}
        </p>
      ) : null}

      {!validation.ok ? (
        <p role="alert" className="text-xs leading-xs text-danger">
          {validation.issues.length === 1 ? "One node has a problem" : `${String(validation.issues.length)} nodes have problems`} the inspector lists; the revision cannot be saved until they are fixed.
        </p>
      ) : null}

      {fullScreen ? (
        <div
          ref={fullScreenRef}
          role="dialog"
          aria-modal="true"
          aria-label={prototype ? "Prototype, full screen" : "Design canvas, full screen"}
          tabIndex={-1}
          data-slot="design-full-screen"
          className="fixed inset-0 z-50 flex flex-col gap-2 bg-bg p-3 outline-none"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium text-ink">{context.detail.revision.title}</span>
            {!prototype ? (
              <Button size="sm" variant="outline" onClick={() => setPrototype(startPrototype(draft, selectedScreen?.id))}>
                <Play />
                Prototype
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setFullScreen(false)}>
              <X />
              Exit full screen
              <kbd className="typed ms-1 text-ink-3">Esc</kbd>
            </Button>
          </div>
          <div className="flex min-h-0 flex-1">{stage ?? canvas}</div>
        </div>
      ) : null}

      <div className={cn("grid min-w-0 gap-4", compact ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]")}>
        <div className="flex min-w-0 flex-col gap-2">
          {!fullScreen ? (stage ?? canvas) : <p className="text-xs leading-xs text-ink-3">The canvas is open full screen. Esc brings it back here.</p>}
          {tokens.tokens.length === 0 ? (
            <p role="status" className="text-xs leading-xs text-ink-3">
              Drawn in this app's own tokens: this design has no token document to skin the kit with yet.
              {index ? " The index carries no tokens." : " The project's design index is not readable from this window yet."}
            </p>
          ) : tokens.skipped.length > 0 ? (
            <p role="status" className="text-xs leading-xs text-ink-3">
              {tokens.skipped.length} token{tokens.skipped.length === 1 ? " was" : "s were"} not applied: {tokens.skipped[0]?.path} {tokens.skipped[0]?.reason}.
            </p>
          ) : null}
        </div>
        {inspector}
      </div>

    </div>
  );
}

function ImplementControl({ workKey, sketchOnly, onCopy }: { workKey: string; sketchOnly: boolean; onCopy: () => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-haspopup="dialog">
          <Hammer />
          Implement…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 p-3">
        {sketchOnly ? (
          <p data-slot="implement-refusal" className="text-xs leading-xs text-ink-2">
            {SKETCH_GATE_REFUSAL}
          </p>
        ) : (
          <>
            <p className="text-xs leading-xs text-ink-2">{IMPLEMENT_PENDING_SENTENCE}</p>
            <Button size="xs" variant="outline" className="self-start" onClick={onCopy}>
              <Copy />
              Copy {workKey}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

async function readBlob(client: BlobRequest, projectId: string, blobId: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  // A sketch is at most `SKETCH_MAX_BYTES`, which is one page; the loop is for
  // a foundation token document that grew past a page.
  for (let page = 0; page < 8; page += 1) {
    try {
      const result = await client.request("project/work/blob/read", { projectId, blobId, offset });
      if (result.released) return { ok: false, message: result.released.detail };
      if (result.data === undefined) return { ok: false, message: "This content is not stored on this machine." };
      chunks.push(decodeBase64(result.data));
      if (result.nextOffset === undefined) break;
      offset = result.nextOffset;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "This content could not be read." };
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
