"use client";
/**
 * The Design Index panel (M21-T11; `docs/design-phase.md` "Review").
 *
 * The index is a proposal until a person accepts it: automated component
 * discovery is roughly two-thirds right in the industry's own measurements,
 * so every entry is shown like a Research finding — confidence chip, review
 * chip, sources — and the person accepts, renames, merges or rejects.
 *
 * The panel does not know where the index comes from. It takes a
 * `DesignIndexAccess`: the index (or why there is none), the review verb and
 * the re-index command. The worker owns the index and its review
 * (`design/index/review.ts`, M21-T10); the wire between that and this window
 * is M21-T17's. Until it lands, the detail passes an access whose state is
 * `unavailable` with the honest sentence, and the panel draws that as a
 * designed state — never as buttons that would fail.
 */
import { Check, GitMerge, Loader2, Pencil, RefreshCw, Square, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { DesignIndex, DesignIndexEntry, DesignIndexEntryKind } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/settings/fields";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { cn } from "@/lib/utils";

export type DesignReviewVerb =
  | { action: "accept"; entryId: string }
  | { action: "rename"; entryId: string; name: string }
  | { action: "merge"; entryId: string; intoId: string }
  | { action: "reject"; entryId: string };

export type DesignIndexState =
  | { kind: "loading" }
  | { kind: "ready"; index: DesignIndex }
  /** This project has never been indexed. */
  | { kind: "absent"; detail: string }
  /** The host refused or failed to read it. */
  | { kind: "error"; message: string }
  /** This window has no way to read it yet. The sentence says why. */
  | { kind: "unavailable"; detail: string };

export interface DesignReindexState {
  commandId: string;
  /** Files parsed so far — progress by files, never by percent. */
  files: number;
  total?: number | undefined;
}

export interface DesignIndexAccess {
  state: DesignIndexState;
  /** Absent when this connection cannot write reviews. */
  review?: ((verb: DesignReviewVerb) => Promise<{ ok: true } | { ok: false; message: string }>) | undefined;
  /** Absent when this connection cannot start a build, or when none could be owned. */
  reindex?: (() => Promise<{ ok: true; commandId: string } | { ok: false; message: string }>) | undefined;
  /**
   * Why a build cannot be started from here, with the way to fix it.
   *
   * A build is a Command in a conversation, so without one there is nothing to
   * press — and the panel says so in the button's place, with the act that
   * leads to a conversation. Never a hidden control, and never one that would
   * start work nobody could see.
   */
  reindexRefusal?: { sentence: string; act?: { label: string; run: () => void } | undefined } | undefined;
  reindexing?: DesignReindexState | undefined;
  stopReindex?: ((commandId: string) => void) | undefined;
  /** Why a review or a re-index is not offered here, in one sentence. */
  writeRefusal?: string | undefined;
}

const KIND_LABEL: Readonly<Record<DesignIndexEntryKind, string>> = {
  token: "Tokens",
  component: "Components",
  convention: "Conventions",
  asset: "Assets",
  era: "Eras",
  philosophy: "Philosophy",
};

const CONFIDENCE_TONE = { declared: "ok", observed: "live", inferred: "attention", proposed: "outline" } as const;

export function DesignIndexPanel({ access, usedEntryIds, className }: { access: DesignIndexAccess; usedEntryIds?: ReadonlySet<string> | undefined; className?: string }) {
  return (
    <section data-slot="design-index-panel" aria-label="Design index" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="eyebrow">Design index</h3>
        <ReindexControl access={access} />
      </header>
      <BuildRefusal access={access} />
      <IndexBody access={access} usedEntryIds={usedEntryIds} />
    </section>
  );
}

function ReindexControl({ access }: { access: DesignIndexAccess }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  if (access.reindexing) {
    const progress = access.reindexing;
    return (
      <span className="ms-auto flex items-center gap-1.5 text-xs leading-xs text-ink-2" role="status">
        <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-busy" />
        {progress.total !== undefined ? `${String(progress.files)} of ${String(progress.total)} files` : `${String(progress.files)} files`}
        {access.stopReindex ? (
          <Button size="xs" variant="outline" onClick={() => access.stopReindex?.(progress.commandId)}>
            <Square />
            Stop
          </Button>
        ) : null}
      </span>
    );
  }
  if (!access.reindex) return null;
  return (
    <span className="ms-auto flex items-center gap-1.5">
      {error ? (
        <span role="alert" className="text-xs leading-xs text-danger">
          {error}
        </span>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={starting}
        onClick={() => {
          setStarting(true);
          setError(undefined);
          void access.reindex?.().then((outcome) => {
            setStarting(false);
            if (!outcome.ok) setError(outcome.message);
          });
        }}
      >
        <RefreshCw />
        {access.state.kind === "ready" ? "Re-index" : "Build the index"}
      </Button>
    </span>
  );
}

function IndexBody({ access, usedEntryIds }: { access: DesignIndexAccess; usedEntryIds?: ReadonlySet<string> | undefined }) {
  switch (access.state.kind) {
    case "loading":
      return <GenerationLoader label="Reading the design index" />;
    case "absent":
      return <Notice title="This project has no design index yet" detail={access.state.detail} />;
    case "error":
      return <Notice role="alert" title="The design index could not be read" detail={access.state.message} />;
    case "unavailable":
      return <Notice title="The design index is not readable from here yet" detail={access.state.detail} />;
    case "ready":
      return <IndexEntries access={access} index={access.state.index} usedEntryIds={usedEntryIds} />;
  }
}

function Notice({ title, detail, role = "status" }: { title: string; detail: string; role?: "status" | "alert" }) {
  return (
    <div role={role} className="flex flex-col gap-1 rounded-lg border border-dashed border-line p-3">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-xs leading-xs text-ink-2">{detail}</p>
    </div>
  );
}

function IndexEntries({ access, index, usedEntryIds }: { access: DesignIndexAccess; index: DesignIndex; usedEntryIds?: ReadonlySet<string> | undefined }) {
  const [kind, setKind] = useState<DesignIndexEntryKind | "all">("all");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [eraId, setEraId] = useState<string | "all">("all");

  const entries = useMemo(
    () =>
      index.entries.filter(
        (entry) =>
          (kind === "all" || entry.kind === kind) &&
          (eraId === "all" || entry.eraId === eraId) &&
          (!unreviewedOnly || entry.review.state === "unreviewed" || entry.changedSinceReview === true),
      ),
    [index.entries, kind, eraId, unreviewedOnly],
  );
  const unreviewed = index.entries.filter((entry) => entry.review.state === "unreviewed").length;
  const kinds = [...new Set(index.entries.map((entry) => entry.kind))];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs leading-xs text-ink-2">
        {index.stack.frameworks.join(", ") || "Stack not detected"}
        {index.stack.styling.length > 0 ? ` · ${index.stack.styling.join(", ")}` : ""} · {index.entries.length} entries
        {unreviewed > 0 ? ` · ${String(unreviewed)} to review` : " · all reviewed"}
        {index.stoppedEarly === true ? " · stopped before it finished" : ""}
        {index.gaps.length > 0 ? ` · ${String(index.gaps.length)} files could not be parsed` : ""}
      </p>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter entries">
        <FilterChip active={kind === "all"} onClick={() => setKind("all")}>
          All
        </FilterChip>
        {kinds.map((candidate) => (
          <FilterChip key={candidate} active={kind === candidate} onClick={() => setKind(candidate)}>
            {KIND_LABEL[candidate]}
          </FilterChip>
        ))}
        <FilterChip active={unreviewedOnly} onClick={() => setUnreviewedOnly((value) => !value)}>
          Needs review
        </FilterChip>
        {index.eras.length > 1 ? (
          <select aria-label="Era" className={cn(selectClass, "ms-auto h-6 w-auto py-0 text-xs")} value={eraId} onChange={(event) => setEraId(event.target.value)}>
            <option value="all">Every era</option>
            {index.eras.map((era) => (
              <option key={era.id} value={era.id}>
                {era.name}
                {era.useForNewWork ? " · for new work" : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {access.writeRefusal ? (
        <p role="status" className="text-xs leading-xs text-ink-3">
          {access.writeRefusal}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <Notice title="Nothing matches" detail={unreviewedOnly ? "Every entry here has been reviewed." : "Widen the filter to see more of the index."} />
      ) : (
        <ul role="list" className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} index={index} access={access} used={usedEntryIds?.has(entry.id) ?? false} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Why a build cannot be started from here, in the place the button would have
 * been — a full line of its own, because it is a sentence and the header is a
 * row of controls (the 12px floor holds; it wraps rather than shrinks).
 */
function BuildRefusal({ access }: { access: DesignIndexAccess }) {
  const refusal = access.reindexRefusal;
  if (access.reindex || !refusal) return null;
  return (
    <div data-slot="design-index-build-refusal" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <p role="status" className="min-w-0 flex-1 text-xs leading-xs text-ink-3">
        {refusal.sentence}
      </p>
      {refusal.act ? (
        <Button size="xs" variant="outline" onClick={refusal.act.run}>
          {refusal.act.label}
        </Button>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2 text-xs leading-none outline-none transition-colors duration-(--motion-instant) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
        active ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

function EntryRow({ entry, index, access, used }: { entry: DesignIndexEntry; index: DesignIndex; access: DesignIndexAccess; used: boolean }) {
  const [mode, setMode] = useState<"idle" | "rename" | "merge">("idle");
  const [draft, setDraft] = useState(entry.name);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const era = index.eras.find((candidate) => candidate.id === entry.eraId);
  const canReview = access.review !== undefined;

  const run = (verb: DesignReviewVerb): void => {
    if (!access.review) return;
    setBusy(true);
    setError(undefined);
    void access.review(verb).then((outcome) => {
      setBusy(false);
      if (outcome.ok) setMode("idle");
      else setError(outcome.message);
    });
  };

  return (
    <li data-slot="design-index-entry" data-entry-id={entry.id} data-review={entry.review.state} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate text-sm leading-5 font-medium text-ink" title={entry.name}>
          {entry.name}
        </span>
        <Badge variant="mono">{entry.kind}</Badge>
        {era ? <Badge variant="outline">{era.name}</Badge> : null}
        <Badge variant={CONFIDENCE_TONE[entry.confidence]}>{entry.confidence}</Badge>
        <Badge
          variant={entry.review.state === "accepted" ? "ok" : entry.review.state === "rejected" ? "danger" : entry.review.state === "unreviewed" ? "attention" : "outline"}
        >
          {entry.review.state}
        </Badge>
        {entry.changedSinceReview === true ? <Badge variant="attention">changed since review</Badge> : null}
        {used ? <Badge variant="live">in this design</Badge> : null}
      </div>
      {entry.summary ? <p className="text-xs leading-xs text-ink-2">{entry.summary}</p> : null}
      {entry.sources.length > 0 ? (
        <span className="typed min-w-0 truncate text-ink-3" title={entry.sources.map((source) => source.path).join("\n")}>
          {entry.sources[0]?.path}
          {entry.sources.length > 1 ? ` +${String(entry.sources.length - 1)}` : ""}
        </span>
      ) : null}

      {mode === "rename" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) run({ action: "rename", entryId: entry.id, name: draft.trim() });
          }}
        >
          <Input aria-label="New name" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-7" />
          <Button size="xs" type="submit" disabled={busy || !draft.trim()}>
            Rename
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </form>
      ) : mode === "merge" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (target) run({ action: "merge", entryId: entry.id, intoId: target });
          }}
        >
          <select aria-label="Merge into" className={cn(selectClass, "h-7")} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Merge into…</option>
            {index.entries
              .filter((candidate) => candidate.id !== entry.id && candidate.kind === entry.kind)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
          </select>
          <Button size="xs" type="submit" disabled={busy || !target}>
            Merge
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </form>
      ) : canReview ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant="outline" disabled={busy || entry.review.state === "accepted"} onClick={() => run({ action: "accept", entryId: entry.id })}>
            <Check />
            Accept
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode("rename")}>
            <Pencil />
            Rename
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode("merge")}>
            <GitMerge />
            Merge
          </Button>
          <Button size="xs" variant="destructive-ghost" disabled={busy || entry.review.state === "rejected"} onClick={() => run({ action: "reject", entryId: entry.id })}>
            <X />
            Reject
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs leading-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
