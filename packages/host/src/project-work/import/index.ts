/**
 * Import: an adapter's proposals, previewed, decided and then written
 * (M21-T21).
 *
 * `project/work/import/preview` runs the adapter, matches every proposal
 * against the work this project already has, and answers with what would be
 * created and what needs a decision. It writes nothing.
 *
 * `project/work/import/apply` runs the same adapter again, refuses unless the
 * result is byte-for-byte the preview the person confirmed, and then writes:
 * one revision per proposal, each one carrying the file it came from, the
 * digest of those bytes, the adapter that read them and the licence the source
 * declared — as a `source_location` evidence record joined to the exact
 * revision, which is where provenance about something *outside* the project
 * belongs (an edge joins two artifacts; a source file is not one).
 *
 * Two rules the leap states plainly, and this file keeps:
 *
 * - **Nothing watches anything.** The adapter reads files once, per call.
 *   There is no watcher, no scheduled re-read and no background task; editing
 *   the source afterwards changes nothing until a person imports again.
 * - **A collision is a person's decision.** A proposal that lands on an
 *   existing key or title is never merged, never overwritten and never
 *   silently duplicated: the preview offers "new revision", "new item" or
 *   "skip", and an apply without a decision for it is refused.
 */
import {
  WORK_IMPORT_PROPOSALS_MAX,
  type ProjectWorkListItem,
  type ProjectWorkOrigin,
  type WorkImportAdapter,
  type WorkImportApplied,
  type WorkImportApplyParams,
  type WorkImportApplyResult,
  type WorkImportChoice,
  type WorkImportPreviewParams,
  type WorkImportPreviewResult,
  type WorkImportProposal,
} from "@lasercode/protocol";

import { ProjectWorkRefusedError } from "../errors.js";
import { canonicalJson, sha256 } from "../ids.js";
import { DEFAULT_EXPORT_ROOT, insideProject, normaliseRelative, projectDirectory } from "../export/paths.js";
import type { ProjectWorkStore } from "../store.js";
import { ADAPTER_DEFAULT_ROOT, runAdapter, type AdapterOutput, type ParsedItem } from "./adapters.js";

/** A Laser key, as a source may have written one back out. */
const KEY_PATTERN = /^(SPEC|RES|DES|PLAN|TASK)-\d+$/;

interface Matched {
  item: ParsedItem;
  proposal: WorkImportProposal;
  match?: { entityId: string; expectedRevisionId: string; kind: string };
}

export class ProjectWorkImport {
  constructor(private readonly store: ProjectWorkStore) {}

  preview(params: WorkImportPreviewParams): WorkImportPreviewResult {
    const { output, matched } = this.read(params.projectId, params.adapter, params.path);
    const proposals = matched.map((row) => row.proposal);
    return {
      adapter: params.adapter,
      root: output.root,
      previewDigest: previewDigest(params.adapter, output, proposals),
      proposals,
      creates: proposals.filter((proposal) => proposal.action === "create").length,
      conflicts: proposals.filter((proposal) => proposal.action === "decide").length,
      skipped: output.skipped.slice(0, 200),
      ...(output.truncated || output.items.length >= WORK_IMPORT_PROPOSALS_MAX ? { truncated: true } : {}),
      watches: false,
    };
  }

  /**
   * Write the import.
   *
   * Each proposal is written on its own: one that the store refuses (a body it
   * will not take, a plan graph it will not accept) is recorded as skipped
   * with the store's own sentence, and the rest still land. A half-written
   * import that says exactly which half is better than an all-or-nothing
   * refusal that leaves a person guessing which file was the problem.
   */
  apply(params: WorkImportApplyParams, origin: ProjectWorkOrigin): Omit<WorkImportApplyResult, "seq"> {
    const { output, matched } = this.read(params.projectId, params.adapter, params.path);
    const proposals = matched.map((row) => row.proposal);
    const digest = previewDigest(params.adapter, output, proposals);
    if (digest !== params.previewDigest) {
      throw new ProjectWorkRefusedError(
        "Those files changed after that preview, so nothing was imported. Preview the import again to see what would be created now.",
      );
    }
    const decisions = new Map((params.decisions ?? []).map((decision) => [decision.sourceId, decision.choice]));
    const undecided = proposals.filter((proposal) => proposal.action === "decide" && !decisions.has(proposal.sourceId));
    if (undecided.length > 0) {
      const names = undecided.slice(0, 5).map((proposal) => proposal.title).join(", ");
      throw new ProjectWorkRefusedError(
        `${String(undecided.length)} of these already exist in this project (${names}). Choose a new revision, a new item or skip for each one before importing.`,
      );
    }

    const applied: WorkImportApplied[] = [];
    const writtenByKey = new Map<string, { entityId: string; revisionId: string }>();
    let created = 0;
    let revised = 0;
    let skipped = 0;

    for (const [index, row] of matched.entries()) {
      const choice: WorkImportChoice | "create" = row.proposal.action === "create" ? "create" : decisions.get(row.proposal.sourceId)!;
      const key = writeKey(params.idempotencyKey, index);
      if (choice === "skip") {
        skipped += 1;
        applied.push({ sourceId: row.proposal.sourceId, action: "skipped", source: row.item.source, note: "You chose to skip this one." });
        continue;
      }
      try {
        if (choice === "new_revision" && row.match) {
          const result = this.store.revise({
            projectId: params.projectId,
            entityId: row.match.entityId,
            expectedRevisionId: row.match.expectedRevisionId,
            title: row.item.title,
            body: row.item.body,
            note: importNote(row.item),
            origin,
            idempotencyKey: key,
          });
          revised += 1;
          this.recordProvenance(params.projectId, result.entity.entityId, result.revision.revisionId, row.item, origin, key);
          if (row.item.sourceKey) writtenByKey.set(row.item.sourceKey, { entityId: result.entity.entityId, revisionId: result.revision.revisionId });
          applied.push({
            sourceId: row.proposal.sourceId,
            action: "revised",
            key: result.entity.key,
            entityId: result.entity.entityId,
            revisionId: result.revision.revisionId,
            digest: result.revision.digest,
            source: row.item.source,
          });
          continue;
        }
        const result = this.store.create({
          projectId: params.projectId,
          kind: row.item.kind,
          title: row.item.title,
          body: row.item.body,
          note: importNote(row.item),
          origin,
          idempotencyKey: key,
        });
        created += 1;
        this.recordProvenance(params.projectId, result.entity.entityId, result.revision.revisionId, row.item, origin, key);
        if (row.item.sourceKey) writtenByKey.set(row.item.sourceKey, { entityId: result.entity.entityId, revisionId: result.revision.revisionId });
        applied.push({
          sourceId: row.proposal.sourceId,
          action: "created",
          key: result.entity.key,
          entityId: result.entity.entityId,
          revisionId: result.revision.revisionId,
          digest: result.revision.digest,
          source: row.item.source,
        });
      } catch (error) {
        skipped += 1;
        applied.push({
          sourceId: row.proposal.sourceId,
          action: "skipped",
          source: row.item.source,
          note: error instanceof Error ? error.message.slice(0, 400) : "This one could not be imported.",
        });
      }
    }

    // Relations the source recorded between its own items, recreated between
    // the items this import wrote. Nothing is inferred: only pairs that were
    // both written, and only the relations the source actually held.
    let relations = 0;
    for (const [index, relation] of output.relations.entries()) {
      const subject = writtenByKey.get(relation.subjectKey);
      const object = writtenByKey.get(relation.objectKey);
      if (!subject || !object) continue;
      try {
        this.store.link({
          projectId: params.projectId,
          expectedRevisionId: subject.revisionId,
          link: {
            type: "edge",
            relation: relation.relation,
            subject: { entityId: subject.entityId, revisionId: subject.revisionId },
            object: { entityId: object.entityId, revisionId: object.revisionId },
            ...(relation.note !== undefined ? { note: relation.note } : {}),
          },
          origin,
          idempotencyKey: writeKey(params.idempotencyKey, 10_000 + index),
        });
        relations += 1;
      } catch {
        // A relation the current rules do not allow between these two kinds is
        // not worth failing an import for; the items themselves are written.
      }
    }

    return { adapter: params.adapter, root: output.root, applied, created, revised, skipped, relations, watches: false };
  }

  /** Run the adapter and match every proposal against this project's work. */
  private read(projectId: string, adapter: WorkImportAdapter, path: string | undefined): { output: AdapterOutput; matched: Matched[] } {
    const projectRoot = projectDirectory(this.store, projectId);
    const root = normaliseRelative(path ?? ADAPTER_DEFAULT_ROOT[adapter]);
    // Containment is decided before a single byte is read.
    insideProject(projectRoot, root);
    const output = runAdapter(adapter, { projectRoot, root, exportRoot: DEFAULT_EXPORT_ROOT });

    // The whole backlog, page by page: a match this missed would import a
    // second copy of something the project already has.
    const existing: ProjectWorkListItem[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = this.store.list({ projectId, includeArchived: true, limit: 200, ...(cursor !== undefined ? { cursor } : {}) });
      existing.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === undefined || existing.length >= 5000) break;
    }
    const byKey = new Map(existing.map((item) => [item.key, item]));
    const byTitle = new Map(existing.map((item) => [item.title.trim().toLowerCase(), item]));

    const matched: Matched[] = output.items.map((item) => {
      const keyMatch = item.sourceKey && KEY_PATTERN.test(item.sourceKey) ? byKey.get(item.sourceKey) : undefined;
      const titleMatch = keyMatch ? undefined : byTitle.get(item.title.trim().toLowerCase());
      const existing = keyMatch ?? titleMatch;
      if (!existing) {
        return {
          item,
          proposal: { sourceId: item.sourceId, kind: item.kind, title: item.title, summary: item.summary, source: item.source, action: "create", notes: item.notes },
        };
      }
      const sameKind = existing.kind === item.kind;
      const choices: WorkImportChoice[] = sameKind ? ["new_revision", "new_entity", "skip"] : ["new_entity", "skip"];
      return {
        item,
        ...(sameKind ? { match: { entityId: existing.ref.entityId, expectedRevisionId: existing.ref.revisionId, kind: existing.kind } } : {}),
        proposal: {
          sourceId: item.sourceId,
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          source: item.source,
          match: {
            entityId: existing.ref.entityId,
            key: existing.key,
            title: existing.title,
            digest: existing.ref.digest,
            matchedBy: keyMatch ? "key" : "title",
          },
          conflict: { reason: keyMatch ? "key" : "title", choices },
          action: "decide",
          notes: sameKind ? item.notes : [...item.notes, `The existing ${existing.key} is a ${existing.kind}, so this can only become a new item.`],
        },
      };
    });

    return { output, matched };
  }

  /**
   * Where this revision came from, as a record joined to the exact revision.
   *
   * It names the file, the digest of the bytes that were read, the adapter
   * that read them and the licence the source declared — or says plainly that
   * it declared none, which is a fact about the source and not a guess about
   * it (leap: imported material retains licence and source provenance).
   */
  private recordProvenance(
    projectId: string,
    entityId: string,
    revisionId: string,
    item: ParsedItem,
    origin: ProjectWorkOrigin,
    idempotencyKey: string,
  ): void {
    const licence = item.source.licenceName ?? (item.source.licence ? item.source.licence : undefined);
    const detail = [
      `source: ${item.source.path}`,
      `digest: ${item.source.digest}`,
      `adapter: ${item.source.adapter}`,
      `licence: ${licence ?? "not declared by the source"}`,
      item.source.externalId ? `source id: ${item.source.externalId}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    try {
      this.store.link({
        projectId,
        expectedRevisionId: revisionId,
        link: {
          type: "evidence",
          entityId,
          revisionId,
          kind: "source_location",
          role: "supporting",
          summary: `Imported from ${item.source.path} by the ${item.source.adapter} adapter.`,
          detail,
          outcome: "inconclusive",
        },
        origin,
        idempotencyKey: `${idempotencyKey}.p`.slice(0, 80),
      });
    } catch {
      // The revision is written and carries the same sentence as its note; a
      // failure to add the record beside it must not undo the import.
    }
  }
}

/** The note the revision itself carries, so provenance is visible in history. */
function importNote(item: ParsedItem): string {
  return `Imported from ${item.source.path} (${item.source.adapter}).`;
}

/**
 * What the person confirmed: the adapter, the root, and every proposal with
 * the digest of the file it came from. A source file edited between the
 * preview and the press changes this, and the apply refuses.
 */
function previewDigest(adapter: WorkImportAdapter, output: AdapterOutput, proposals: readonly WorkImportProposal[]): string {
  return sha256(
    canonicalJson({
      adapter,
      root: output.root,
      proposals: proposals.map((proposal) => ({
        sourceId: proposal.sourceId,
        kind: proposal.kind,
        title: proposal.title,
        digest: proposal.source.digest,
        path: proposal.source.path,
        action: proposal.action,
        match: proposal.match?.entityId ?? null,
      })),
      relations: output.relations.map((relation) => [relation.relation, relation.subjectKey, relation.objectKey]),
    }),
  );
}

/** A legal, unique idempotency key per write, derived from the caller's one. */
function writeKey(idempotencyKey: string, index: number): string {
  return `imp-${sha256(idempotencyKey).slice(0, 24)}-${String(index)}`;
}
