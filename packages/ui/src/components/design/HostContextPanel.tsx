"use client";
/**
 * Design in context — the host page, the region and the strategy (M21-T13;
 * `docs/design-phase.md` "Case C · Design in context").
 *
 * The contract, made visible:
 *
 * - **The host is frozen.** What is shown on the left is a structural outline
 *   parsed from the project's real templates, plus the reference image the
 *   repository itself carries. It is not editable, it is not a render, and it
 *   is labelled `Mapped` because a parse is what it is. Nothing here runs the
 *   project (D-353).
 * - **The region is picked, never guessed.** A person clicks a node on the
 *   outline; the anchor recorded is `{ templatePath, structuralPath, textHash }`
 *   and a box drawn on the reference image only *positions a pin* inside it.
 *   When the template moves so the path is gone, the region is shown orphaned
 *   with where the same content went — as an offer, never as a move.
 * - **The strategy is chosen, explicitly.** Both cases are shown with their
 *   reasons and their trade-offs, the model's recommendation is marked as a
 *   recommendation, and what the person picks is recorded on the design with
 *   the era it composes in and whether it is a proposal for the Plan.
 */
import { Crosshair, Image as ImageIcon, Link2Off, MapPin, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ClientRequests, DesignBody, DesignStrategy, HostPage, InsertionRegion } from "@lasercode/protocol";
import { resolveInsertionRegion } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { routeFromBrief } from "@/design/host-context";

type GroundResult = ClientRequests["design/host/ground"]["result"];
export type GroundHostPage = (params: Omit<ClientRequests["design/host/ground"]["params"], "projectId">) => Promise<GroundResult>;

/** What the header says while nothing can ground a page from this window. */
export const HOST_PENDING_SENTENCE =
  "Grounding an existing page reads this project's own templates and gives you its outline to place a design inside. This connection can read this project's design system but not change it, so grounding has to be done from the app on this machine.";

export interface HostContextPanelProps {
  body: DesignBody;
  brief: string;
  editable: boolean;
  ground?: GroundHostPage | undefined;
  onChange: (next: DesignBody) => void;
  /** The reference image of the last grounding, kept out of the body. */
  reference?: GroundResult["referenceImage"] | undefined;
  onReference?: ((image: GroundResult["referenceImage"] | undefined) => void) | undefined;
  compact?: boolean | undefined;
}

export function HostContextPanel({ body, brief, editable, ground, onChange, reference, onReference, compact }: HostContextPanelProps) {
  const hostPage = body.hostPage;
  const [route, setRoute] = useState(() => routeFromBrief(brief) ?? hostPage?.routeOrPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [proposal, setProposal] = useState<GroundResult["strategy"] | undefined>(undefined);
  const [showImage, setShowImage] = useState(true);

  const run = useCallback(
    async (routeOrPath: string) => {
      if (!ground || routeOrPath.trim() === "") return;
      setBusy(true);
      setError(undefined);
      setDetail(undefined);
      try {
        const answer = await ground({ routeOrPath: routeOrPath.trim() });
        setCandidates(answer.candidates);
        setDetail(answer.detail);
        setProposal(answer.strategy);
        onReference?.(answer.referenceImage);
        if (answer.hostPage) {
          // A new grounding never keeps a region picked on the old page: an
          // anchor belongs to the template it was picked in.
          const samePage = body.hostPage?.templatePath === answer.hostPage.templatePath;
          const { insertionRegion, ...rest } = body;
          onChange({ ...rest, ...(samePage && insertionRegion ? { insertionRegion } : {}), hostPage: answer.hostPage });
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "That page could not be grounded.");
      } finally {
        setBusy(false);
      }
    },
    [body, ground, onChange, onReference],
  );

  if (!hostPage) {
    return (
      <section data-slot="design-host-context" aria-label="Design in context" className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-line p-3">
        <h3 className="eyebrow">Change an existing page</h3>
        <p className="text-xs leading-xs text-ink-2">
          Name the page this design goes into — a route like <span className="typed">/orders</span>, or the template's own path. This project's own templates are read, and their
          outline is what you place the design inside. Nothing is run.
        </p>
        {ground && editable ? (
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void run(route);
            }}
          >
            <Input aria-label="Route or template path" value={route} onChange={(event) => setRoute(event.target.value)} placeholder="/orders" className="h-7 max-w-64" />
            <Button size="xs" type="submit" disabled={busy || route.trim() === ""}>
              <Crosshair />
              {busy ? "Reading the page…" : "Ground this page"}
            </Button>
          </form>
        ) : (
          <p data-slot="host-pending" className="rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
            {HOST_PENDING_SENTENCE}
          </p>
        )}
        {detail ? (
          <p role="status" className="text-xs leading-xs text-ink-2">
            {detail}
          </p>
        ) : null}
        {candidates.length > 0 ? (
          <ul role="list" className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 8).map((candidate) => (
              <li key={candidate}>
                <Button size="xs" variant="outline" onClick={() => void run(candidate)}>
                  {candidate}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs leading-xs text-danger">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section data-slot="design-host-context" aria-label="Design in context" className={cn("grid min-w-0 gap-3", compact ? "grid-cols-1" : "grid-cols-[minmax(0,18rem)_minmax(0,1fr)]")}>
      <HostOutline
        hostPage={hostPage}
        region={body.insertionRegion}
        editable={editable && ground !== undefined}
        onPick={(region) => onChange({ ...body, insertionRegion: region })}
        busy={busy}
        onReground={ground && editable ? () => void run(hostPage.routeOrPath) : undefined}
      />
      <div className="flex min-w-0 flex-col gap-3">
        <StrategyChip body={body} proposal={proposal} editable={editable} onChange={onChange} />
        {reference ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="ok">Mapped</Badge>
              <span className="typed min-w-0 truncate text-ink-3">{reference.path}</span>
              <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setShowImage((value) => !value)}>
                <ImageIcon />
                {showImage ? "Hide the reference" : "Show the reference"}
              </Button>
            </div>
            {showImage ? (
              <ReferenceImage
                reference={reference}
                region={body.insertionRegion}
                editable={editable}
                onBox={(box) => {
                  const region = body.insertionRegion;
                  if (!region) return;
                  onChange({ ...body, insertionRegion: { ...region, box } });
                }}
              />
            ) : null}
          </div>
        ) : null}
        {hostPage.gaps && hostPage.gaps.length > 0 ? (
          <div role="status" className="flex flex-col gap-1 rounded-lg border border-dashed border-line p-2">
            <p className="text-xs leading-xs text-ink-2">{hostPage.gaps.length === 1 ? "One file could not be read:" : `${String(hostPage.gaps.length)} files could not be read:`}</p>
            <ul role="list" className="flex flex-col gap-0.5">
              {hostPage.gaps.slice(0, 5).map((gap) => (
                <li key={`${gap.path}:${gap.reason}`} className="typed min-w-0 truncate text-ink-3" title={gap.reason}>
                  {gap.path} — {gap.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs leading-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function HostOutline({
  hostPage,
  region,
  editable,
  onPick,
  onReground,
  busy,
}: {
  hostPage: HostPage;
  region: InsertionRegion | undefined;
  editable: boolean;
  onPick: (region: InsertionRegion) => void;
  onReground?: (() => void) | undefined;
  busy: boolean;
}) {
  const anchors = useMemo(
    () =>
      hostPage.outline
        .filter((node) => node.structuralPath !== undefined && node.textHash !== undefined)
        .map((node) => ({ id: node.id, structuralPath: node.structuralPath ?? "", textHash: node.textHash ?? "", ...(node.label !== undefined ? { label: node.label } : {}) })),
    [hostPage.outline],
  );
  const resolution = region ? resolveInsertionRegion(region, anchors) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h3 className="eyebrow">The page</h3>
        <Badge variant="mono">{hostPage.routeOrPath}</Badge>
        <Badge variant={hostPage.fidelity === "mapped" ? "ok" : "live"}>{hostPage.fidelity === "mapped" ? "Mapped" : "Proposed"}</Badge>
        {onReground ? (
          <Button size="xs" variant="ghost" className="ms-auto" disabled={busy} onClick={onReground}>
            <RefreshCw />
            {busy ? "Reading…" : "Read it again"}
          </Button>
        ) : null}
      </div>
      {hostPage.templatePath ? <span className="typed min-w-0 truncate text-ink-3" title={hostPage.files.join("\n")}>{hostPage.templatePath}</span> : null}

      {resolution?.state === "orphaned" ? (
        <p role="status" data-slot="region-orphaned" className="flex flex-col gap-1 rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5 text-xs leading-xs text-ink-2">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <Link2Off aria-hidden="true" className="size-3.5" />
            The region this design was placed in is gone
          </span>
          {resolution.reason}
          {resolution.candidate && editable ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() => {
                const candidate = hostPage.outline.find((node) => node.structuralPath === resolution.candidate?.structuralPath);
                if (!candidate || region === undefined) return;
                onPick({ ...region, structuralPath: candidate.structuralPath ?? region.structuralPath, textHash: candidate.textHash ?? region.textHash, orphaned: false });
              }}
            >
              Re-anchor it there
            </Button>
          ) : null}
        </p>
      ) : resolution?.state === "changed" ? (
        <p role="status" className="text-xs leading-xs text-ink-2">
          {resolution.reason}
        </p>
      ) : null}

      {hostPage.outline.length === 0 ? (
        <p role="status" className="text-xs leading-xs text-ink-2">
          This template parsed to no structure at all — it may be generated, or written in a form this reader does not know. Pick a different template, or compose the design on its
          own and say in the brief where it goes.
        </p>
      ) : (
        <ul role="list" data-slot="host-outline" className="flex max-h-80 min-w-0 flex-col gap-0.5 overflow-y-auto">
          {hostPage.outline.map((node) => {
            const picked = region?.structuralPath !== undefined && region.structuralPath === node.structuralPath;
            const pickable = editable && node.structuralPath !== undefined && node.textHash !== undefined;
            return (
              <li key={node.id} style={{ paddingInlineStart: `${String(Math.min(node.depth, 8) * 0.75)}rem` }}>
                <button
                  type="button"
                  disabled={!pickable}
                  data-picked={picked ? "true" : undefined}
                  aria-pressed={picked}
                  title={node.structuralPath}
                  onClick={() => {
                    if (!pickable) return;
                    onPick({
                      id: region?.id ?? `reg${node.id}`,
                      templatePath: node.sourcePath ?? hostPage.templatePath ?? "",
                      structuralPath: node.structuralPath ?? "",
                      textHash: node.textHash ?? "",
                      ...(region?.box ? { box: region.box } : {}),
                    });
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-start text-xs leading-xs outline-none transition-colors duration-(--motion-instant) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
                    picked ? "bg-[color-mix(in_oklab,var(--live)_16%,transparent)] text-ink" : pickable ? "text-ink-2 hover:bg-surface-2" : "text-ink-3",
                  )}
                >
                  {picked ? <MapPin aria-hidden="true" className="size-3 shrink-0 text-live" /> : null}
                  <span className="shrink-0 text-ink-3">{node.role}</span>
                  <span className="min-w-0 truncate">{node.label ?? node.structuralPath}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {region ? (
        <p className="text-xs leading-xs text-ink-3">
          The design goes in <span className="typed">{region.structuralPath}</span>
          {region.box ? " · the box on the reference only positions it for the eye; the anchor is the path." : ""}
        </p>
      ) : (
        <p className="text-xs leading-xs text-ink-3">{editable ? "Pick the part of the page the design goes into." : "No region has been picked yet."}</p>
      )}
    </div>
  );
}

function ReferenceImage({
  reference,
  region,
  editable,
  onBox,
}: {
  reference: NonNullable<GroundResult["referenceImage"]>;
  region: InsertionRegion | undefined;
  editable: boolean;
  onBox: (box: { x: number; y: number; width: number; height: number }) => void;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const source = `data:${reference.mediaType};base64,${reference.data}`;
  const box = region?.box;

  const relative = (event: React.PointerEvent): { x: number; y: number } | undefined => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  return (
    <div
      ref={frame}
      data-slot="reference-image"
      className="relative min-w-0 overflow-hidden rounded-lg border border-line"
      onPointerDown={(event) => {
        if (!editable || !region) return;
        start.current = relative(event);
      }}
      onPointerUp={(event) => {
        const from = start.current;
        start.current = undefined;
        const to = relative(event);
        if (!from || !to) return;
        const x = Math.min(from.x, to.x);
        const y = Math.min(from.y, to.y);
        const width = Math.abs(to.x - from.x);
        const height = Math.abs(to.y - from.y);
        if (width < 0.01 || height < 0.01) return;
        onBox({ x, y, width, height });
      }}
    >
      {/* A reference image is a picture to lay a design over. It is never read
          for text and never treated as the host itself (D-353). */}
      <img src={source} alt={`Reference screenshot of this page, from ${reference.path}`} className="block h-auto w-full" />
      {box ? (
        <span
          data-slot="region-box"
          aria-hidden="true"
          className="pointer-events-none absolute rounded border-2 border-live bg-[color-mix(in_oklab,var(--live)_16%,transparent)]"
          style={{ left: `${String(box.x * 100)}%`, top: `${String(box.y * 100)}%`, width: `${String(box.width * 100)}%`, height: `${String(box.height * 100)}%` }}
        />
      ) : null}
    </div>
  );
}

function StrategyChip({
  body,
  proposal,
  editable,
  onChange,
}: {
  body: DesignBody;
  proposal: GroundResult["strategy"] | undefined;
  editable: boolean;
  onChange: (next: DesignBody) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = body.strategy?.kind;
  const cases = proposal ? [proposal.conform, proposal.island] : [];

  const choose = (kind: DesignStrategy): void => {
    if (!proposal) return;
    const picked = kind === "island" ? proposal.island : proposal.conform;
    const other = kind === "island" ? proposal.conform : proposal.island;
    onChange({
      ...body,
      strategy: {
        kind,
        reason: picked.reasons[0] ?? proposal.summary,
        targetFiles: body.hostPage?.files.slice(0, 20) ?? [],
        reasons: picked.reasons,
        tradeoffs: picked.tradeoffs,
        alternative: { kind: other.kind, reasons: other.reasons, tradeoffs: other.tradeoffs },
        ...(picked.eraId !== undefined ? { eraId: picked.eraId } : {}),
        ...(kind === "island" ? { proposalOnly: proposal.proposalOnly } : {}),
      },
    });
  };

  return (
    <div data-slot="design-strategy" className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h3 className="eyebrow">Strategy</h3>
        {chosen ? <Badge variant={chosen === "island" ? "live" : "ok"}>{chosen === "island" ? "Island" : "Conform"}</Badge> : <Badge variant="attention">Not chosen</Badge>}
        {body.strategy?.proposalOnly ? <Badge variant="outline">a proposal for the Plan</Badge> : null}
        {cases.length > 0 ? (
          <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            <Sparkles />
            {open ? "Hide the reasons" : "Why"}
          </Button>
        ) : null}
      </div>

      {body.strategy ? (
        <p className="text-xs leading-xs text-ink-2">{body.strategy.reason}</p>
      ) : proposal ? (
        <p className="text-xs leading-xs text-ink-2">{proposal.summary}</p>
      ) : (
        <p className="text-xs leading-xs text-ink-3">
          Read the page again to see both strategies with their reasons. Conform builds in the page's own idiom; Island mounts one self-contained component into the region.
        </p>
      )}

      {open && proposal
        ? cases.map((option) => (
            <div key={option.kind} className="flex flex-col gap-1 rounded-md border border-line p-2">
              <span className="flex items-center gap-1.5 text-xs leading-xs font-medium text-ink">
                {option.kind === "island" ? "Island" : "Conform"}
                {proposal.recommended === option.kind ? <Badge variant="live">recommended</Badge> : null}
              </span>
              <ul role="list" className="flex flex-col gap-0.5 text-xs leading-xs text-ink-2">
                {option.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <ul role="list" className="flex flex-col gap-0.5 text-xs leading-xs text-ink-3">
                {option.tradeoffs.map((tradeoff) => (
                  <li key={tradeoff}>Costs: {tradeoff}</li>
                ))}
              </ul>
            </div>
          ))
        : null}

      {editable && proposal ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant={chosen === "conform" ? "default" : "outline"} onClick={() => choose("conform")}>
            Conform
          </Button>
          <Button size="xs" variant={chosen === "island" ? "default" : "outline"} onClick={() => choose("island")}>
            Island
          </Button>
          <span className="text-xs leading-xs text-ink-3">The recommendation is the model's; the choice is yours and it is recorded on this design.</span>
        </div>
      ) : null}
    </div>
  );
}
