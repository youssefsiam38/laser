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
 * The tab is the five sections of `docs/design-phase.md`: **Index** (the
 * project's own design system, with its review), **Foundation** (Case A,
 * M21-T14's, drawn here as the slot it is), **Screens**, **Flows** and
 * **Review** (anchored comments and the before/after of two revisions). The
 * in-context frame — host outline, insertion region, Conform/Island — sits
 * above the canvas when this design changes an existing page (M21-T13).
 *
 * The phone gets the same canvas, read-only: pan, zoom, tap to inspect, and a
 * full-screen prototype. Editing needs a wider window, and it says so.
 */
import { Copy, Hammer, Layers, Maximize2, MessageSquare, Play, RefreshCw, Save, Send, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientRequests, DesignBody, DesignIndex, DesignIndexEntry, DesignTokenGroup } from "@lasercode/protocol";
import { designAggregateFidelity, designIsSketchOnly, designTokenDocumentSchema, validateDesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectClass } from "@/components/settings/fields";
import { DesignCanvas } from "@/components/design/DesignCanvas";
import { DesignIndexPanel, type DesignIndexAccess } from "@/components/design/DesignIndexPanel";
import { HostContextPanel, type GroundHostPage } from "@/components/design/HostContextPanel";
import { useDesignAccess } from "@/components/design/use-design-access";
import { FoundationWizard } from "@/components/design/FoundationWizard";
import { NodeInspector } from "@/components/design/NodeInspector";
import { PrototypeStage } from "@/components/design/PrototypeStage";
import { ScreenInspector, type GroundSketch } from "@/components/design/ScreenInspector";
import { FIDELITY_LABEL, FIDELITY_TONE, type SketchBytes } from "@/components/design/ScreenFrame";
import type { KitIndexEntry, KitRenderContext } from "@/components/design/kit/KitNode";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { KIT_NAMES } from "@/design/kit";
import { implementCommandFor, routeFromBrief } from "@/design/host-context";
import { startPrototype, triggerPrototype, type PrototypeState } from "@/design/prototype";
import { designDiff, designPins, diffSummary, pinsForScreen, type DesignPin } from "@/design/review";
import { SKETCH_GATE_REFUSAL } from "@/design/sketch";
import { frameTokens } from "@/design/tokens";
import { designIsEmpty, nodeOf, nudgeNode, reorderChild, screenOf, screenOfNode, setNodeText } from "@/design/tree-model";
import { quoteIntoComposer } from "../quote.js";

import type { WorkBodyContext } from "./context.js";
import { EmptyBody, Prose, Section } from "./fields.js";

/** What "Implement…" does, said before it is done. */
export const IMPLEMENT_SENTENCE =
  "Hand-off pulls this exact revision — its screens, the index entries it uses, its fixtures and unresolved comments — into the conversation as the implementation context. The command goes into the composer, so you send it when you are ready.";

/** The Foundation section: M21-T14's, and drawn as the slot it is. */
export const FOUNDATION_PENDING_SENTENCE =
  "A foundation is what a project with no UI code starts from: principles, then tokens, themes, type, spacing, motion, icons and the core component contracts, each one proposed and edited before anything is built. It is not part of this design yet — start one from the chat with this design open, and it will appear here with everything it proposes.";

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
  /** Ground an existing page. Injected in tests; read from the wire otherwise. */
  groundHost?: GroundHostPage | undefined;
}

/** The five sections of the Design tab (`docs/design-phase.md`). */
export const DESIGN_SECTIONS = ["index", "foundation", "screens", "flows", "review"] as const;
export type DesignSection = (typeof DESIGN_SECTIONS)[number];

const SECTION_LABEL: Readonly<Record<DesignSection, string>> = {
  index: "Index",
  foundation: "Foundation",
  screens: "Screens",
  flows: "Flows",
  review: "Review",
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function DesignDetail({ body, context, index, indexAccess, groundSketch, groundHost }: DesignDetailProps) {
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

  // The wire (M21-T13). Props win, so a test injects what it wants and the
  // window otherwise reads the project's own worker through the host.
  const wire = useDesignAccess(indexAccess ? "" : projectId);
  const access: DesignIndexAccess = indexAccess ?? wire.access;
  const liveIndex = index ?? wire.index;
  const groundPage = groundHost ?? wire.ground;
  const wireGroundSketch = wire.groundSketchDocument;

  // -- tokens and entries ---------------------------------------------------
  const [foundationTokens, setFoundationTokens] = useState<DesignTokenGroup | undefined>(undefined);
  useEffect(() => {
    const blobId = body.foundation?.tokensBlobId;
    const reader = clientRef.current;
    if (!blobId || !reader || liveIndex?.tokensDocument) return;
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
  }, [body.foundation?.tokensBlobId, hasClient, liveIndex?.tokensDocument, projectId]);

  // Built source wins over the proposed foundation's blob or inline tokens.
  const tokens = useMemo(
    () => frameTokens(liveIndex?.tokensDocument ?? foundationTokens ?? draft.foundation?.tokens),
    [liveIndex?.tokensDocument, foundationTokens, draft.foundation?.tokens],
  );
  const entries = useMemo(() => {
    const map = new Map<string, KitIndexEntry>();
    for (const entry of liveIndex?.entries ?? []) {
      map.set(entry.id, { id: entry.id, name: entry.name, ...(entry.detail ? { detail: entry.detail } : {}), reviewed: entry.review.state !== "unreviewed" });
    }
    return map;
  }, [liveIndex?.entries]);
  const entryById = useMemo(() => new Map<string, DesignIndexEntry>((liveIndex?.entries ?? []).map((entry) => [entry.id, entry])), [liveIndex?.entries]);
  const usedEntryIds = useMemo(() => {
    const used = new Set<string>();
    for (const screen of draft.screens) {
      if (!("tree" in screen.content)) continue;
      for (const node of screen.content.tree.nodes) if ("indexEntryId" in node.component) used.add(node.component.indexEntryId);
    }
    return used;
  }, [draft.screens]);


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

  // -- grounding a sketch ---------------------------------------------------
  // The bytes never leave the sandboxed frame except through this call, and
  // what comes back is a tree the worker already validated. It lands in the
  // draft beside its sketch, which stays on the revision as provenance
  // (`docs/design-phase.md`, "Ground it"), and the person saves the revision.
  const [grounded, setGrounded] = useState<ClientRequests["design/sketch/ground"]["result"] | undefined>(undefined);
  const groundFromWire: GroundSketch = useCallback(
    async (sketchId) => {
      const sketch = draft.sketches.find((candidate) => candidate.id === sketchId);
      const screen = draft.screens.find((candidate) => "sketchId" in candidate.content && candidate.content.sketchId === sketchId);
      const document = screen ? sketchBytes[screen.id]?.document : undefined;
      if (!wireGroundSketch) return { ok: false, message: "This connection cannot ground a sketch in this project." };
      if (!sketch || document === undefined) {
        return { ok: false, message: "This sketch has not finished loading yet, so there is nothing to rebuild. Try again in a moment." };
      }
      try {
        const answer = await wireGroundSketch({ document, screenName: `${screen?.name ?? sketch.title}, grounded` });
        setGrounded(answer);
        setDraft((current) => ({
          ...current,
          screens: [...current.screens, answer.screen],
          sketches: current.sketches.map((candidate) => (candidate.id === sketchId ? { ...candidate, groundedIntoScreenId: answer.screen.id } : candidate)),
          fidelity: designAggregateFidelity({ screens: [...current.screens, answer.screen] }),
        }));
        setSelectedScreenId(answer.screen.id);
        setSection("screens");
        return { ok: true, screenId: answer.screen.id };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "That sketch could not be rebuilt from the index." };
      }
    },
    [draft.screens, draft.sketches, sketchBytes, wireGroundSketch],
  );
  const ground = groundSketch ?? (wireGroundSketch ? groundFromWire : undefined);

  // -- sections, pins and the reference image -------------------------------
  const [section, setSection] = useState<DesignSection>("screens");
  const [reference, setReference] = useState<ClientRequests["design/host/ground"]["result"]["referenceImage"] | undefined>(undefined);
  const pins = useMemo(() => designPins(draft, context.detail.comments), [draft, context.detail.comments]);
  const inContext = draft.hostPage !== undefined || routeFromBrief(draft.brief) !== undefined;

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

  const unresolvedPins = useMemo(() => pins.filter((pin) => !pin.resolved), [pins]);
  const aggregate = designAggregateFidelity(draft);
  const sketchOnly = designIsSketchOnly(draft);
  const validation = useMemo(() => validateDesignBody(draft, { primitives: KIT_NAMES }), [draft]);

  // The Foundation slot (M21-T14): a greenfield design is its foundation
  // until it has screens, so the wizard is the body rather than a panel
  // beside an empty canvas.
  const foundation = draft.foundation;
  if (foundation) {
    return (
      <div data-slot="design-detail" className="flex min-w-0 flex-col gap-5">
        <Section title="Brief">
          <Prose text={draft.brief} />
        </Section>
        <FoundationWizard
          body={draft}
          foundation={foundation}
          context={context}
          editable={editable}
          dirty={dirty}
          onChange={(next) => setDraft((current) => ({ ...current, foundation: next }))}
          onSave={save}
          index={liveIndex}
        />
        {dirty && editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(body)}>
              <Undo2 />
              Discard
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              <Save />
              {saving ? "Saving…" : "Save revision"}
            </Button>
          </div>
        ) : null}
        {conflict ? (
          <p role="alert" className="text-xs leading-xs text-ink-2">
            {conflict} Your edits are still here; read the latest revision and apply them again.
          </p>
        ) : null}
        {!designIsEmpty(draft) ? <DesignCanvas body={draft} tokenProperties={tokens.properties} contextFor={editContext} sketchBytes={sketchBytes} className="h-[32rem] min-h-80" /> : null}
        <DesignIndexPanel access={access} />
      </div>
    );
  }

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
        {inContext ? (
          <HostContextPanel
            body={draft}
            brief={draft.brief}
            editable={editable}
            ground={groundPage}
            onChange={setDraft}
            reference={reference}
            onReference={setReference}
            compact={compact}
          />
        ) : null}
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
      pinsFor={(screenId) => pinsForScreen(pins, screenId)}
      onSelectPin={(pin) => {
        setSection("review");
        if (pin.nodeId !== undefined && !pin.orphaned) selectNode(pin.nodeId);
      }}
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
        <ScreenInspector body={draft} screen={selectedScreen} groundSketch={ground} onGrounded={groundSketch ? context.onChanged : undefined} />
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
          <ImplementControl
            workKey={context.detail.entity.key}
            sketchOnly={sketchOnly}
            onCopy={() => void copy(context.detail.entity.key).then((ok) => actions.toast(ok ? "info" : "error", ok ? `${context.detail.entity.key} copied` : "Could not copy the key"))}
            onSend={() => {
              quoteIntoComposer({ text: implementCommandFor(context.detail.entity.key), workKey: context.detail.entity.key });
              actions.toast("info", `${implementCommandFor(context.detail.entity.key)} is in the composer — send it when you are ready.`);
            }}
          />
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

      <nav aria-label="Design sections" className="flex min-w-0 flex-wrap items-center gap-1.5">
        {DESIGN_SECTIONS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={section === candidate}
            onClick={() => setSection(candidate)}
            className={cn(
              "h-7 rounded-full border px-2.5 text-xs leading-none outline-none transition-colors duration-(--motion-instant) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              section === candidate ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
            )}
          >
            {SECTION_LABEL[candidate]}
            {candidate === "review" && unresolvedPins.length > 0 ? ` · ${String(unresolvedPins.length)}` : ""}
            {candidate === "flows" && draft.flows.length > 0 ? ` · ${String(draft.flows.length)}` : ""}
          </button>
        ))}
      </nav>

      {section === "index" ? (
        <DesignIndexPanel access={access} usedEntryIds={usedEntryIds} />
      ) : section === "foundation" ? (
        <FoundationSection body={draft} />
      ) : section === "review" ? (
        <ReviewSection
          body={draft}
          context={context}
          pins={pins}
          grounded={grounded}
          onSelectNode={(nodeId) => {
            setSection("screens");
            selectNode(nodeId);
          }}
        />
      ) : (
        <div className={cn("grid min-w-0 gap-4", compact ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]")}>
          <div className="flex min-w-0 flex-col gap-2">
            {inContext ? (
              <HostContextPanel
                body={draft}
                brief={draft.brief}
                editable={editable}
                ground={groundPage}
                onChange={setDraft}
                reference={reference}
                onReference={setReference}
                compact={compact}
              />
            ) : null}
            {section === "flows" ? <FlowsSection body={draft} onSelectScreen={(screenId) => setSelectedScreenId(screenId)} /> : null}
            {!fullScreen ? (stage ?? canvas) : <p className="text-xs leading-xs text-ink-3">The canvas is open full screen. Esc brings it back here.</p>}
            {tokens.tokens.length === 0 ? (
              <p role="status" className="text-xs leading-xs text-ink-3">
                Drawn in this app's own tokens: this design has no token document to skin the kit with yet.
                {liveIndex ? " The index carries no tokens." : " This project has no design index yet."}
              </p>
            ) : tokens.skipped.length > 0 ? (
              <p role="status" className="text-xs leading-xs text-ink-3">
                {tokens.skipped.length} token{tokens.skipped.length === 1 ? " was" : "s were"} not applied: {tokens.skipped[0]?.path} {tokens.skipped[0]?.reason}.
              </p>
            ) : null}
          </div>
          {inspector}
        </div>
      )}

    </div>
  );
}

/** Case A's slot: designed, honest, and M21-T14's to fill. */
function FoundationSection({ body }: { body: DesignBody }) {
  const foundation = body.foundation;
  if (!foundation) {
    return (
      <div role="status" data-slot="design-foundation" className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line p-3">
        <p className="text-sm font-medium text-ink">This design has no foundation</p>
        <p className="text-xs leading-xs text-ink-2">{FOUNDATION_PENDING_SENTENCE}</p>
      </div>
    );
  }
  return (
    <section data-slot="design-foundation" aria-label="Foundation" className="flex min-w-0 flex-col gap-3">
      <h3 className="eyebrow">Foundation</h3>
      {foundation.principles.length > 0 ? (
        <ul role="list" className="flex flex-col gap-1">
          {foundation.principles.map((principle) => (
            <li key={principle} className="text-sm leading-5 text-ink-2">
              {principle}
            </li>
          ))}
        </ul>
      ) : null}
      {foundation.notes ? <Prose text={foundation.notes} /> : null}
      <p className="text-xs leading-xs text-ink-3">
        Everything a foundation proposes stays <Badge variant="live">Proposed</Badge> until it is built: the repository is unchanged before Build.
      </p>
    </section>
  );
}

/** The flows, read as sentences: what starts them and what they do. */
function FlowsSection({ body, onSelectScreen }: { body: DesignBody; onSelectScreen: (screenId: string) => void }) {
  const screenName = (screenId: string): string => body.screens.find((screen) => screen.id === screenId)?.name ?? screenId;
  if (body.flows.length === 0) {
    return (
      <div role="status" data-slot="design-flows" className="rounded-lg border border-dashed border-line p-3 text-xs leading-xs text-ink-2">
        This design has no flows yet. A flow is one declarative step — a click that opens a screen, a submit that shows the loading state, a tab that switches a variant. The canvas
        draws them between frames as soon as there are some.
      </div>
    );
  }
  return (
    <section data-slot="design-flows" aria-label="Flows" className="flex min-w-0 flex-col gap-1.5">
      <h3 className="eyebrow">Flows</h3>
      <ul role="list" className="flex flex-col gap-1">
        {body.flows.map((flow) => (
          <li key={flow.id} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs leading-xs text-ink-2">
            <Badge variant="mono">{flow.trigger}</Badge>
            <button
              type="button"
              className="rounded text-ink underline-offset-4 outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              onClick={() => onSelectScreen(flow.fromScreenId)}
            >
              {screenName(flow.fromScreenId)}
            </button>
            <span aria-hidden="true">→</span>
            <span>{flowActionLabel(flow.action, screenName)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function flowActionLabel(action: DesignBody["flows"][number]["action"], screenName: (screenId: string) => string): string {
  switch (action.type) {
    case "navigate":
      return `go to ${screenName(action.screenId)}${action.transition ? ` (${action.transition})` : ""}`;
    case "overlay":
      return `open ${screenName(action.screenId)} over it`;
    case "close":
      return "close the overlay";
    case "setState":
      return `put ${action.nodeId} into its ${action.state} state`;
    case "setVariant":
      return `switch ${action.nodeId} to ${action.variant}`;
    case "switchTheme":
      return `switch the theme to ${action.theme}`;
    case "switchViewport":
      return `switch the viewport to ${action.viewport}`;
  }
}

/**
 * Review: the pins as a list, and the before/after of two revisions.
 *
 * Comments are written and answered in the workspace inspector (M21-T8); what
 * belongs *here* is the design's own view of them — where each one is pinned,
 * which ones lost their node, and what actually changed between the revision
 * being read and any earlier one.
 */
function ReviewSection({
  body,
  context,
  pins,
  grounded,
  onSelectNode,
}: {
  body: DesignBody;
  context: WorkBodyContext;
  pins: readonly DesignPin[];
  grounded: ClientRequests["design/sketch/ground"]["result"] | undefined;
  onSelectNode: (nodeId: string) => void;
}) {
  const history = context.detail.history ?? [];
  const earlier = history.filter((revision) => revision.revisionId !== context.detail.revision.revisionId);
  const [againstId, setAgainstId] = useState<string | undefined>(() => earlier[0]?.revisionId);
  const [against, setAgainst] = useState<{ revisionId: string; body: DesignBody } | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const store = context.store;

  useEffect(() => {
    if (!store || againstId === undefined) return;
    let cancelled = false;
    setReading(true);
    setError(undefined);
    void store.get({ entityId: context.detail.entity.entityId, revisionId: againstId, body: { mode: "full" } }).then((outcome) => {
      if (cancelled) return;
      setReading(false);
      if (!outcome.ok) {
        setError(outcome.failure.message);
        return;
      }
      const read = outcome.value.body?.body;
      if (read?.kind !== "design") {
        setError("That revision's content is no longer stored on this machine, so it cannot be compared.");
        return;
      }
      setAgainst({ revisionId: againstId, body: read.design });
    });
    return () => {
      cancelled = true;
    };
  }, [againstId, context.detail.entity.entityId, store]);

  const diff = useMemo(() => (against ? designDiff(against.body, body) : undefined), [against, body]);
  const orphaned = pins.filter((pin) => pin.orphaned);

  return (
    <div data-slot="design-review" className="flex min-w-0 flex-col gap-5">
      <section aria-label="Pinned comments" className="flex min-w-0 flex-col gap-2">
        <h3 className="eyebrow">Pinned comments</h3>
        {pins.length === 0 ? (
          <p role="status" className="rounded-lg border border-dashed border-line p-3 text-xs leading-xs text-ink-2">
            Nothing is pinned on this design yet. Comment on a node or a screen from the inspector and the pin appears on the canvas, numbered, where it belongs.
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1.5">
            {pins.map((pin) => (
              <li
                key={pin.commentId}
                data-slot="design-pin"
                data-orphaned={pin.orphaned ? "true" : undefined}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-2"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge variant={pin.orphaned ? "attention" : pin.blocking ? "danger" : "outline"}>{pin.number}</Badge>
                  <span className="text-xs leading-xs text-ink-3">{pin.author}</span>
                  {pin.blocking ? <Badge variant="danger">blocking</Badge> : null}
                  {pin.resolved ? <Badge variant="ok">resolved</Badge> : null}
                  {pin.orphaned ? <Badge variant="attention">anchor gone</Badge> : null}
                  {!pin.orphaned && pin.nodeId ? (
                    <Button size="xs" variant="ghost" className="ms-auto" onClick={() => onSelectNode(pin.nodeId ?? "")}>
                      <MessageSquare />
                      Show it
                    </Button>
                  ) : null}
                </span>
                <p className="text-xs leading-xs text-ink-2">{pin.text}</p>
                {pin.orphaned ? (
                  <p className="text-xs leading-xs text-ink-3">
                    The node this was written on is not in this revision. The comment is kept exactly as it was written, and nothing was re-pinned for you.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {orphaned.length > 0 ? (
          <p role="status" className="text-xs leading-xs text-ink-3">
            {orphaned.length === 1 ? "One comment lost" : `${String(orphaned.length)} comments lost`} the node it was pinned to when this design changed.
          </p>
        ) : null}
      </section>

      {grounded ? (
        <section aria-label="What grounding could not map" className="flex min-w-0 flex-col gap-2">
          <h3 className="eyebrow">From the sketch</h3>
          <p className="text-xs leading-xs text-ink-2">
            {grounded.unmapped.length === 0
              ? "Everything in that sketch mapped onto this project's index."
              : `${String(grounded.unmapped.length)} part${grounded.unmapped.length === 1 ? "" : "s"} of that sketch had nothing in the index to draw ${grounded.unmapped.length === 1 ? "it" : "them"} with, so ${grounded.unmapped.length === 1 ? "it is" : "they are"} proposed:`}
          </p>
          <ul role="list" className="flex flex-col gap-1">
            {grounded.unmapped.slice(0, 20).map((part) => (
              <li key={`${part.what}:${part.why}`} className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs leading-xs text-ink-2">
                <Badge variant="live">{part.what}</Badge>
                <span className="min-w-0">{part.why}</span>
                {part.primitive ? <span className="typed text-ink-3">drawn as {part.primitive}</span> : null}
              </li>
            ))}
          </ul>
          {grounded.notes.map((note) => (
            <p key={note} role="status" className="text-xs leading-xs text-ink-3">
              {note}
            </p>
          ))}
        </section>
      ) : null}

      <section aria-label="Before and after" className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="eyebrow">Before and after</h3>
          {earlier.length > 0 ? (
            <select
              aria-label="Compare with"
              className={cn(selectClass, "h-7 w-auto py-0 text-xs")}
              value={againstId ?? ""}
              onChange={(event) => setAgainstId(event.target.value === "" ? undefined : event.target.value)}
            >
              <option value="">Pick a revision</option>
              {earlier.map((revision) => (
                <option key={revision.revisionId} value={revision.revisionId}>
                  Revision {revision.index}
                  {revision.note ? ` · ${revision.note}` : ""}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {earlier.length === 0 ? (
          <p role="status" className="text-xs leading-xs text-ink-2">
            This is the first revision of this design, so there is nothing to compare it with yet.
          </p>
        ) : reading ? (
          <p role="status" className="text-xs leading-xs text-ink-3">
            Reading that revision…
          </p>
        ) : error ? (
          <p role="alert" className="text-xs leading-xs text-danger">
            {error}
          </p>
        ) : diff ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs leading-xs text-ink-2">{diffSummary(diff)}</p>
            <ul role="list" className="flex flex-col gap-1">
              {diff.screens.map((change) => (
                <li key={`${change.kind}:${change.screenId}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-2">
                  <Badge variant={change.kind === "added" ? "ok" : "danger"}>screen {change.kind}</Badge>
                  <span className="min-w-0 truncate">{change.screenName}</span>
                </li>
              ))}
              {diff.nodes.slice(0, 60).map((change) => (
                <li
                  key={`${change.kind}:${change.screenId}:${change.nodeId}`}
                  data-slot="design-diff-row"
                  className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface px-2 py-1.5"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs">
                    <Badge variant={change.kind === "added" ? "ok" : change.kind === "removed" ? "danger" : "live"}>{change.kind}</Badge>
                    <span className="typed min-w-0 truncate text-ink-3">{change.nodeId}</span>
                    <span className="text-ink-3">in {change.screenName}</span>
                    {change.fields ? <span className="text-ink-3">· {change.fields.join(", ")}</span> : null}
                  </span>
                  {change.before ? (
                    <span className="min-w-0 truncate text-xs leading-xs text-ink-3">
                      before: {change.before}
                    </span>
                  ) : null}
                  {change.after ? (
                    <span className="min-w-0 truncate text-xs leading-xs text-ink-2">
                      after: {change.after}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p role="status" className="text-xs leading-xs text-ink-2">
            Pick a revision to compare this one with, node by node.
          </p>
        )}
      </section>
    </div>
  );
}

function ImplementControl({ workKey, sketchOnly, onCopy, onSend }: { workKey: string; sketchOnly: boolean; onCopy: () => void; onSend: () => void }) {
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
            <p className="text-xs leading-xs text-ink-2">{IMPLEMENT_SENTENCE}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="xs" onClick={onSend}>
                <Send />
                Send /design implement @{workKey}
              </Button>
              <Button size="xs" variant="outline" onClick={onCopy}>
                <Copy />
                Copy {workKey}
              </Button>
            </div>
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
