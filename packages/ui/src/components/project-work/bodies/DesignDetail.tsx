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
import { Layers, Maximize2, Pencil, Play, RefreshCw, Save, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientRequests, DesignBody, DesignIndex, DesignIndexEntry, DesignTokenGroup, DesignTreeVocabulary } from "@lasercode/protocol";
import { designAggregateFidelity, designIsSketchOnly, designTokenDocumentSchema, validateDesignBody } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DesignCanvas } from "@/components/design/DesignCanvas";
import { DesignIndexPanel, type DesignIndexAccess } from "@/components/design/DesignIndexPanel";
import { FlowsPanel } from "@/components/design/FlowsPanel";
import { FoundationSection } from "@/components/design/FoundationSection";
import { HostContextPanel, type GroundHostPage } from "@/components/design/HostContextPanel";
import { ImplementControl } from "@/components/design/ImplementControl";
import { useDesignAccess } from "@/components/design/use-design-access";
import { NodeInspector } from "@/components/design/NodeInspector";
import { PrototypeStage } from "@/components/design/PrototypeStage";
import { ReviewPanel } from "@/components/design/ReviewPanel";
import { ScreenInspector, type GroundSketch } from "@/components/design/ScreenInspector";
import { FIDELITY_LABEL, FIDELITY_TONE, type SketchBytes } from "@/components/design/ScreenFrame";
import type { KitIndexEntry, KitRenderContext } from "@/components/design/kit/KitNode";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { readBlob, type BlobRequest } from "@/design/blob-read";
import { KIT_NAMES } from "@/design/kit";
import { implementCommandFor, routeFromBrief } from "@/design/host-context";
import { startPrototype, triggerPrototype, type PrototypeState } from "@/design/prototype";
import { designPins, pinsForScreen } from "@/design/review";
import { SKETCH_GATE_REFUSAL } from "@/design/sketch";
import { frameTokens } from "@/design/tokens";
import { designIsEmpty, nodeOf, nudgeNode, reorderChild, screenOf, screenOfNode, setNodeText } from "@/design/tree-model";
import { MarkdownAuthoringField, MarkdownEditorActivationProvider } from "../MarkdownAuthoringField.js";
import { quoteIntoComposer } from "../quote.js";

import type { WorkBodyContext } from "./context.js";
import { Field } from "./editor-fields.js";
import { EmptyBody, Prose, Section } from "./fields.js";

// The sections are their own modules (`components/design/*`); this file is
// the detail's orchestration — the draft, the selection, the wire and which
// section is open. Their copy is re-exported here because it is this
// detail's surface, and callers read it from the detail.
export { FoundationStart, FOUNDATION_PENDING_SENTENCE, FOUNDATION_START_SENTENCE, foundationRequestFor } from "@/components/design/FoundationSection";
export { IMPLEMENT_SENTENCE } from "@/components/design/ImplementControl";

import { FoundationStart, foundationRequestFor as foundationRequest } from "@/components/design/FoundationSection";

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

  // The wire (M21-T13). Props win, so a test injects what it wants and the
  // window otherwise reads the project's own worker through the host.
  const wire = useDesignAccess(indexAccess ? "" : projectId);
  const access: DesignIndexAccess = indexAccess ?? wire.access;
  const liveIndex = index ?? wire.index;
  const groundPage = groundHost ?? wire.ground;
  const wireGroundSketch = wire.groundSketchDocument;

  // What a node may reference. When this window can read the project's index,
  // the entry ids are part of the vocabulary: a node pointing at an entry a
  // review has since merged away is a problem the save gate must see, exactly
  // as the worker's own grounding validates it. With no index read, the kit
  // names are all this window can honestly check.
  const vocabulary = useMemo<DesignTreeVocabulary>(
    () => ({ primitives: KIT_NAMES, ...(liveIndex ? { entryIds: liveIndex.entries.map((entry) => entry.id) } : {}) }),
    [liveIndex],
  );

  // -- the draft ------------------------------------------------------------
  const [draft, setDraft] = useState<DesignBody>(body);
  const [title, setTitle] = useState(context.detail.revision.title);
  const [saving, setSaving] = useState(false);
  const [briefEditing, setBriefEditing] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(body);
    setTitle(context.detail.revision.title);
    setConflict(undefined);
  }, [body, context.detail.revision.title]);
  const dirty = draft !== body || title.trim() !== context.detail.revision.title;
  const editable = context.editable && !compact;
  const readOnlyReason = compact ? "Editing a design needs a wider window. Here you can read it, inspect any node and play it." : context.readOnlyReason;

  const save = useCallback(async () => {
    if (!context.store) return;
    const validation = validateDesignBody(draft, vocabulary);
    if (!validation.ok) {
      actions.toast("error", validation.issues[0]?.message ?? "This design has a problem that has to be fixed first.");
      return;
    }
    setSaving(true);
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "design", design: draft },
      { note: "Edited on the design surface", ...(title.trim() !== context.detail.revision.title ? { title: title.trim() } : {}) },
    );
    setSaving(false);
    if (outcome.ok) {
      actions.toast("info", `${context.detail.entity.key} · revision ${outcome.value.revision.index} saved`);
      setBriefEditing(false);
      context.onChanged();
      return;
    }
    if (outcome.failure.kind === "conflict") {
      setConflict(outcome.failure.message);
      return;
    }
    actions.toast("error", outcome.failure.message);
  }, [actions, context, draft, title, vocabulary]);

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
  // Case A's own affordance, on any design that has no foundation yet: the
  // header override of `docs/design-phase.md` ("Start a foundation"), which
  // exists in an established project too.
  const startFoundation = useCallback(() => {
    const request = foundationRequest(context.detail.entity.key);
    quoteIntoComposer({ text: request, workKey: context.detail.entity.key });
    actions.toast("info", `${request} is in the composer — send it when you are ready.`);
  }, [actions, context.detail.entity.key]);
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
  // A greenfield design *is* its foundation until it has screens, so that is
  // the section it opens on; everything else still opens on the canvas.
  const [section, setSection] = useState<DesignSection>(() => (body.foundation && body.screens.length === 0 ? "foundation" : "screens"));
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
  const validation = useMemo(() => validateDesignBody(draft, vocabulary), [draft, vocabulary]);

  // The Foundation (M21-T14) lives in its own section, beside the other four
  // (M21-T13): a greenfield design opens on it, and a design that has both a
  // foundation and screens can still be read as a design.
  const foundation = draft.foundation;
  const nothingDrawn = designIsEmpty(draft);
  const briefBlock = briefEditing ? (
    <div className="flex flex-col gap-4">
      <Field label="Title" htmlFor="design-title">
        <Input id="design-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <MarkdownEditorActivationProvider active>
      <MarkdownAuthoringField
        editorKey="design-brief"
        label="Brief"
        value={draft.brief}
        onChange={(brief) => setDraft((current) => ({ ...current, brief }))}
        placeholder="What should this experience make possible?"
      />
      </MarkdownEditorActivationProvider>
    </div>
  ) : (
    <Section title="Brief">
      <Prose text={draft.brief} />
    </Section>
  );

  if (!foundation && nothingDrawn) {
    return (
      <div data-slot="design-detail" className="flex flex-col gap-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <Badge variant="live">Proposed</Badge>
          <span className="text-xs leading-xs text-ink-3">0 screens · 0 flows · nothing drawn yet</span>
          {editable ? (
            <span className="ms-auto flex items-center gap-1.5">
              {!briefEditing ? <Button size="sm" variant="outline" onClick={() => setBriefEditing(true)}><Pencil />Edit brief</Button> : null}
              <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(body); setTitle(context.detail.revision.title); setBriefEditing(false); }}><Undo2 />Discard</Button>
              <Button size="sm" disabled={!dirty || saving || title.trim() === ""} onClick={() => void save()}><Save />{saving ? "Saving…" : "Save revision"}</Button>
            </span>
          ) : null}
        </div>
        {conflict ? <p role="alert" data-slot="revision-conflict" className="rounded-lg border border-attention/40 p-3 text-sm text-ink-2">{conflict} Your edits are still here.</p> : null}
        {briefBlock}
        <EmptyBody
          what="This design has a brief and nothing drawn yet."
          next="Screens arrive as the model composes them from this project's design index — or as a sketch, when the ask is exploratory. Ask for either in the chat with this design open."
        />
        <div className="flex flex-wrap items-center gap-2">
          <FoundationStart access={access} editable={editable} onStart={startFoundation} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const request = `Compose screens for ${context.detail.entity.key} from its brief and this project's design index.`;
              quoteIntoComposer({ text: request, workKey: context.detail.entity.key });
            }}
          >
            Compose screens
          </Button>
        </div>
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
        {/* A design with nothing drawn has no fidelity to report; "Mapped"
            over zero screens would be a claim about nothing. */}
        {nothingDrawn ? <Badge variant="live">Proposed</Badge> : <Badge variant={FIDELITY_TONE[aggregate]}>{FIDELITY_LABEL[aggregate]}</Badge>}
        {draft.strategy ? <Badge variant="outline">{draft.strategy.kind === "island" ? "Island" : "Conform"}</Badge> : null}
        {draft.hostPage ? <Badge variant="mono">{draft.hostPage.routeOrPath}</Badge> : null}
        <span className="text-xs leading-xs text-ink-3">
          {draft.screens.length} screen{draft.screens.length === 1 ? "" : "s"} · {draft.flows.length} flow{draft.flows.length === 1 ? "" : "s"}
          {draft.sketches.length > 0 ? ` · ${String(draft.sketches.length)} sketch${draft.sketches.length === 1 ? "" : "es"}` : ""}
          {tokens.tokens.length > 0 ? ` · ${String(tokens.tokens.length)} tokens` : ""}
        </span>
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          {nothingDrawn ? null : prototype ? (
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
          {!fullScreen && !nothingDrawn ? (
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
              {!briefEditing ? (
                <Button size="sm" variant="outline" onClick={() => setBriefEditing(true)}>
                  <Pencil />
                  Edit brief
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => { setDraft(body); setTitle(context.detail.revision.title); setBriefEditing(false); }}>
                <Undo2 />
                Discard
              </Button>
              <Button size="sm" disabled={!dirty || saving || title.trim() === ""} onClick={() => void save()}>
                <Save />
                {saving ? "Saving…" : "Save revision"}
              </Button>
            </>
          ) : null}
        </span>
      </div>

      {briefBlock}

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
        <FoundationSection
          body={draft}
          context={context}
          access={access}
          editable={editable}
          dirty={dirty}
          index={liveIndex}
          onChange={(next) => setDraft((current) => ({ ...current, foundation: next }))}
          onSave={save}
          onStart={startFoundation}
        />
      ) : section === "review" ? (
        <ReviewPanel
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
            {section === "flows" ? <FlowsPanel body={draft} onSelectScreen={(screenId) => setSelectedScreenId(screenId)} /> : null}
            {nothingDrawn ? (
              <div role="status" data-slot="design-nothing-drawn" className="rounded-lg border border-dashed border-line p-3">
                <p className="text-sm leading-5 font-medium text-ink">Nothing is drawn on this design yet</p>
                <p className="mt-0.5 text-xs leading-xs text-ink-2">
                  {foundation
                    ? "The foundation is in its own section above. Screens come next: ask for one in the chat with this design open, and it is composed from the language the foundation sets."
                    : "Screens arrive as the model composes them from this project's design index — or as a sketch, when the ask is exploratory. Ask for either in the chat with this design open."}
                </p>
              </div>
            ) : !fullScreen ? (
              (stage ?? canvas)
            ) : (
              <p className="text-xs leading-xs text-ink-3">The canvas is open full screen. Esc brings it back here.</p>
            )}
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
