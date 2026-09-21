"use client";
/**
 * Import…, Export… and Publish… (M21-T21, leap "Import, export and
 * interoperability").
 *
 * All three are the same shape, because all three are the same promise: **you
 * see exactly what would happen before anything happens.** Each dialog ends in
 * a preview the host computed — the files that would be read, the files that
 * would be written, the commit the publication would be recorded against —
 * and the confirming button sends that preview's digest back, so a tree that
 * moved in between is refused rather than applied.
 *
 * **Enter confirms none of them.** The path field swallows Enter, there is no
 * form to submit, and the cancelling control takes focus when the dialog
 * opens: the acting button is never the one a stray keypress reaches.
 */
import { Check, Download, FileText, GitCommitHorizontal, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PROJECT_DIR_NAME, WORK_EXPORT_DIR, type ClientRequests, type WorkExportMode, type WorkImportAdapter, type WorkImportChoice } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { ProjectWorkStore } from "@/project-work";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";

type ImportPreview = ClientRequests["project/work/import/preview"]["result"];
type ExportPreview = ClientRequests["project/work/export/preview"]["result"];
type PublishPreview = ClientRequests["project/work/publish/preview"]["result"];

/** Where an export goes when the person names nothing, as the host defaults it. */
const DEFAULT_EXPORT_ROOT = `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`;

export interface WorkDialogProps {
  store: ProjectWorkStore | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * What each adapter is, in the person's words.
 *
 * The tool's own name is the honest label — a person who has a Spec Kit tree
 * knows it by that name — and the sentence says what it will read, because
 * "import" means nothing without "from where".
 */
export const IMPORT_ADAPTERS: ReadonlyArray<{ id: WorkImportAdapter; label: string; detail: string; where: string }> = [
  { id: "spec_kit", label: "Spec Kit", detail: "A feature folder with a spec, a plan and a task list.", where: "specs" },
  { id: "openspec", label: "OpenSpec", detail: "Capability specs and proposed changes.", where: "openspec" },
  { id: "markdown", label: "Markdown", detail: "Markdown files that say what they are in their front matter.", where: "docs" },
  { id: "plan_md", label: "A plan document", detail: "Milestone sections with a table of tasks.", where: "PLAN.md" },
  { id: "work_export", label: "An export from here", detail: "A folder this app exported, read back exactly.", where: "the export folder" },
];

const CHOICE_LABEL: Readonly<Record<WorkImportChoice, string>> = {
  new_revision: "New revision",
  new_entity: "New item",
  skip: "Skip",
};

const MODE_LABEL: Readonly<Record<WorkExportMode, string>> = {
  replace: "Replace it",
  new_revision: "Keep both",
};

/** A row of a preview list: one line, never smaller type, always truncating. */
function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <li className={cn("flex min-w-0 items-center gap-2 py-1", className)}>{children}</li>;
}

function Waiting({ what }: { what: string }) {
  return <p className="text-sm leading-5 text-ink-2">{what}</p>;
}

/** The scrolling area every preview list sits in. Bounded, never a page scroll. */
function PreviewList({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <ul role="list" aria-label={label} className="max-h-64 min-w-0 overflow-y-auto rounded-lg border border-line bg-surface px-2.5 py-1">
      {children}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function ImportDialog({ store, open, onOpenChange }: WorkDialogProps) {
  const { actions } = useLaserStable();
  const [adapter, setAdapter] = useState<WorkImportAdapter>("spec_kit");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined);
  const [decisions, setDecisions] = useState<Record<string, WorkImportChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(undefined);
    setDecisions({});
    setError(undefined);
    setPath("");
  }, [open]);

  const look = useCallback(async () => {
    if (!store) return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.importPreview(adapter, { path: path.trim() === "" ? undefined : path.trim() });
    setBusy(false);
    if (!outcome.ok) {
      setPreview(undefined);
      setError(outcome.failure.message);
      return;
    }
    setPreview(outcome.value);
    setDecisions({});
  }, [adapter, path, store]);

  const undecided = (preview?.proposals ?? []).filter((proposal) => proposal.action === "decide" && decisions[proposal.sourceId] === undefined);

  const run = async (): Promise<void> => {
    if (!store || !preview) return;
    setBusy(true);
    const outcome = await store.importApply(adapter, {
      previewDigest: preview.previewDigest,
      ...(path.trim() === "" ? {} : { path: path.trim() }),
      decisions: Object.entries(decisions).map(([sourceId, choice]) => ({ sourceId, choice })),
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    const { created, revised, skipped } = outcome.value;
    actions.toast("info", `Imported ${String(created)} new, ${String(revised)} updated, ${String(skipped)} skipped`);
    onOpenChange(false);
  };

  const chosen = IMPORT_ADAPTERS.find((candidate) => candidate.id === adapter)!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Import work into this project</DialogTitle>
          <DialogDescription>
            The files are read once, here and now. Nothing watches them afterwards, and the tool they came from never becomes a second author of
            this work.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Where the work comes from</legend>
          {IMPORT_ADAPTERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={candidate.id === adapter}
              onClick={() => {
                setAdapter(candidate.id);
                setPreview(undefined);
              }}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm leading-5 outline-none",
                "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                candidate.id === adapter ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
              )}
            >
              {candidate.label}
            </button>
          ))}
        </fieldset>
        <p className="text-xs leading-xs text-ink-2">{chosen.detail}</p>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Folder in this project</span>
          <Input
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setPreview(undefined);
            }}
            // Enter never runs anything here: the preview is a deliberate press.
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={chosen.where}
            aria-label="Folder in this project to import from"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {preview === undefined ? (
          busy ? (
            <Waiting what="Reading those files…" />
          ) : (
            <p className="text-sm leading-5 text-ink-2">Nothing has been read yet. Look at the files to see what would be created.</p>
          )
        ) : preview.proposals.length === 0 ? (
          <WorkRefusal
            message={`Nothing to import from ${preview.root}.`}
            recovery={preview.skipped[0] ? `${preview.skipped[0].path}: ${preview.skipped[0].reason}` : "There are no files this adapter reads there."}
          />
        ) : (
          <>
            <p className="text-sm leading-5 text-ink-2">
              <span className="text-ink">{preview.creates}</span> would be created
              {preview.conflicts > 0 ? (
                <>
                  , <span className="text-ink">{preview.conflicts}</span> already exist here and need a decision
                </>
              ) : null}
              {" · "}
              <span className="typed">{preview.root}</span>
            </p>
            <PreviewList label="What would be imported">
              {preview.proposals.map((proposal) => (
                <Row key={proposal.sourceId} className="flex-wrap">
                  <TypeBadge kind={proposal.kind} />
                  <span className="min-w-0 flex-1 truncate text-sm leading-5 text-ink">{proposal.title}</span>
                  <span className="typed truncate text-xs leading-xs text-ink-3">{proposal.source.path}</span>
                  {proposal.source.licenceName ? <span className="text-xs leading-xs text-ink-3">{proposal.source.licenceName}</span> : null}
                  {proposal.conflict ? (
                    <span className="flex w-full items-center gap-1.5 ps-5">
                      <span className="text-xs leading-xs text-ink-2">
                        Already here as <KeyTag workKey={proposal.match?.key ?? ""} muted />
                      </span>
                      {proposal.conflict.choices.map((choice) => (
                        <button
                          key={choice}
                          type="button"
                          aria-pressed={decisions[proposal.sourceId] === choice}
                          onClick={() => setDecisions((current) => ({ ...current, [proposal.sourceId]: choice }))}
                          className={cn(
                            "flex h-7 items-center rounded-md border px-2 text-xs leading-xs outline-none",
                            "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                            decisions[proposal.sourceId] === choice ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                          )}
                        >
                          {CHOICE_LABEL[choice]}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </Row>
              ))}
            </PreviewList>
            {preview.skipped.length > 0 ? (
              <p className="text-xs leading-xs text-ink-3">
                {preview.skipped.length} file{preview.skipped.length === 1 ? "" : "s"} skipped · {preview.skipped[0]!.reason}
              </p>
            ) : null}
          </>
        )}

        {error ? <WorkRefusal message={error} /> : null}

        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || !store} onClick={() => void look()}>
            <FileText />
            {preview === undefined ? "Look at the files" : "Look again"}
          </Button>
          <Button
            disabled={busy || !store || preview === undefined || preview.proposals.length === 0 || undecided.length > 0}
            onClick={() => void run()}
          >
            <Upload />
            {undecided.length > 0 ? `${String(undecided.length)} still to decide` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function ExportDialog({ store, open, onOpenChange }: WorkDialogProps) {
  const { actions } = useLaserStable();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<WorkExportMode | undefined>(undefined);
  const [preview, setPreview] = useState<ExportPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const look = useCallback(
    async (next: { path?: string; mode?: WorkExportMode }) => {
      if (!store) return;
      setBusy(true);
      setError(undefined);
      const outcome = await store.exportPreview({
        ...(next.path && next.path.trim() !== "" ? { path: next.path.trim() } : {}),
        ...(next.mode ? { mode: next.mode } : {}),
      });
      setBusy(false);
      if (!outcome.ok) {
        setPreview(undefined);
        setError(outcome.failure.message);
        return;
      }
      setPreview(outcome.value);
    },
    [store],
  );

  useEffect(() => {
    if (!open) return;
    setPath("");
    setMode(undefined);
    setError(undefined);
    void look({});
  }, [look, open]);

  const run = async (): Promise<void> => {
    if (!store || !preview) return;
    setBusy(true);
    const outcome = await store.exportApply({
      previewDigest: preview.previewDigest,
      ...(path.trim() === "" ? {} : { path: path.trim() }),
      ...(mode ? { mode } : {}),
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `Exported ${String(outcome.value.entities)} item(s) to ${outcome.value.root}`);
    onOpenChange(false);
  };

  const needsDecision = preview?.decide !== undefined && mode === undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Export this project's work</DialogTitle>
          <DialogDescription>
            A readable document and the exact stored content for every item, plus a manifest of ids, digests, links and attachments. It is a copy:
            this app stays the authority, and it will not read the copy back on its own.
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Folder in this project</span>
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onBlur={() => void look({ path, ...(mode ? { mode } : {}) })}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={preview?.root ?? DEFAULT_EXPORT_ROOT}
            aria-label="Folder in this project to export to"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {preview === undefined ? (
          <Waiting what={busy ? "Working out what would be written…" : "Nothing has been worked out yet."} />
        ) : (
          <>
            <p className="text-sm leading-5 text-ink-2">
              <span className="text-ink">{preview.entities}</span> item{preview.entities === 1 ? "" : "s"} ·{" "}
              <span className="text-ink">{preview.files.length}</span> file{preview.files.length === 1 ? "" : "s"}
              {preview.attachments > 0 ? ` · ${String(preview.attachments)} attachment${preview.attachments === 1 ? "" : "s"} referenced` : null} ·{" "}
              <span className="typed">{preview.root}</span>
            </p>
            <PreviewList label="Files this export would write">
              {preview.files.map((file) => (
                <Row key={file.path}>
                  <span className="typed min-w-0 flex-1 truncate text-sm leading-5 text-ink">{file.path}</span>
                  <span className="text-xs leading-xs text-ink-3 tnum">{file.bytes}</span>
                </Row>
              ))}
            </PreviewList>
            {preview.removes.length > 0 ? (
              <p className="text-xs leading-xs text-ink-2">
                {preview.removes.length} file{preview.removes.length === 1 ? "" : "s"} of the export already there would be removed.
              </p>
            ) : null}
            {preview.decide ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <p className="text-sm leading-5 text-ink">
                  There is already an export at <span className="typed">{preview.existing?.root ?? preview.root}</span>
                  {preview.existing?.unchanged ? ", and it is identical to this one." : "."}
                </p>
                <p className="text-xs leading-xs text-ink-2">Replace it, or keep it and write this one beside it.</p>
                <div className="flex gap-1.5">
                  {preview.decide.choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={mode === choice}
                      onClick={() => {
                        setMode(choice);
                        void look({ path, mode: choice });
                      }}
                      className={cn(
                        "flex h-8 items-center rounded-md border px-2.5 text-sm leading-5 outline-none",
                        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                        mode === choice ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                      )}
                    >
                      {MODE_LABEL[choice]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        {error ? <WorkRefusal message={error} /> : null}

        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !store || preview === undefined || needsDecision} onClick={() => void run()}>
            <Download />
            {needsDecision ? "Choose one first" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export function PublishDialog({ store, open, onOpenChange }: WorkDialogProps) {
  const { actions } = useLaserStable();
  const [preview, setPreview] = useState<PublishPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const look = useCallback(async () => {
    if (!store) return;
    setBusy(true);
    setError(undefined);
    const outcome = await store.publishPreview({});
    setBusy(false);
    if (!outcome.ok) {
      setPreview(undefined);
      setError(outcome.failure.message);
      return;
    }
    setPreview(outcome.value);
  }, [store]);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void look();
  }, [look, open]);

  const run = async (): Promise<void> => {
    if (!store || !preview?.ready) return;
    setBusy(true);
    const outcome = await store.publishApply({ previewDigest: preview.previewDigest, commit: "HEAD" });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `Recorded where ${String(outcome.value.published.length)} item(s) are published`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Record where this work is published</DialogTitle>
          <DialogDescription>
            Each item is joined to the exact commit, path and file its exported document lives at. Nothing is recorded until that commit exists, and
            an earlier publication is kept rather than rewritten.
          </DialogDescription>
        </DialogHeader>

        {preview === undefined ? (
          <Waiting what={busy ? "Looking at the export and the repository…" : "Nothing has been checked yet."} />
        ) : preview.refusal && !preview.ready && preview.entities.length === 0 ? (
          <WorkRefusal message={preview.refusal} onRetry={() => void look()} />
        ) : (
          <>
            <p className="text-sm leading-5 text-ink-2">
              <span className="text-ink">{preview.entities.length}</span> item{preview.entities.length === 1 ? "" : "s"} ·{" "}
              <span className="typed">{preview.root}</span>
              {preview.repository ? (
                <>
                  {" · "}
                  <span className="text-ink">{preview.repository.name}</span>
                  {preview.repository.branch ? <span className="typed text-ink-3"> {preview.repository.branch}</span> : null}
                </>
              ) : null}
            </p>
            <PreviewList label="What would be recorded">
              {preview.entities.map((entity) => (
                <Row key={entity.entityId}>
                  <KeyTag workKey={entity.key} />
                  <span className="typed min-w-0 flex-1 truncate text-sm leading-5 text-ink-2">{entity.publishedPath}</span>
                  {entity.publishedAs ? (
                    <span className="text-xs leading-xs text-ink-3">already at {entity.publishedAs.commitObjectId.slice(0, 7)}</span>
                  ) : null}
                </Row>
              ))}
            </PreviewList>
            {preview.ready ? (
              <p className="flex items-center gap-1.5 text-sm leading-5 text-ink-2">
                <Check aria-hidden="true" className="size-4 text-ok" />
                Every exported file is in {preview.repository?.head?.slice(0, 7) ?? "the current commit"}.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <p className="flex items-center gap-1.5 text-sm leading-5 text-ink">
                  <GitCommitHorizontal aria-hidden="true" className="size-4 text-ink-3" />
                  {preview.uncommitted.length} exported file{preview.uncommitted.length === 1 ? " is" : "s are"} not committed yet.
                </p>
                <p className="text-xs leading-xs text-ink-2">
                  Commit <span className="typed">{preview.commit?.paths[0] ?? preview.root}</span> in Source control — you will see that change
                  before it is made — then check again here.
                </p>
              </div>
            )}
          </>
        )}

        {error ? <WorkRefusal message={error} /> : null}

        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || !store} onClick={() => void look()}>
            <FileText />
            Check again
          </Button>
          <Button disabled={busy || !store || preview?.ready !== true} onClick={() => void run()}>
            <Upload />
            Record it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
