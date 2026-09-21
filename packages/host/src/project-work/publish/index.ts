/**
 * Publication: an export in a repository, recorded as `published_as`
 * (M21-T21, leap "Repository provenance").
 *
 * The rule the whole module exists for: **`published_as` is added only after
 * the exact committed or checkpoint state is known.** Never "it is in the
 * folder", never "HEAD will do", never a link written in the hope that a
 * commit follows.
 *
 * So publication is two halves, and the commit in between is not this
 * module's:
 *
 * 1. `project/work/publish/preview` reads the export on disk, checks it is
 *    still the export this project's work would produce, resolves the
 *    repository it sits in, and says which of its files are committed. While
 *    anything is uncommitted it hands back the **M20 git commit action** to
 *    run — `pi/project/git/commit`, which has its own preview and its own
 *    typed confirmation — rather than committing anything itself.
 * 2. `project/work/publish/apply` takes the commit that resulted, proves every
 *    exported document is exactly that commit's blob, and only then writes one
 *    `published_as` link per item: the commit, the repository-relative path,
 *    the git blob id and the content digest. A previous publication of the
 *    same item is superseded, never deleted.
 *
 * Which state is published is an explicit choice, not a guess: the preview
 * offers the repository's current commit and the checkpoints it still has,
 * each one already measured against this export, and it answers with the one it
 * measured (`selected`). An apply sends that state back and gets the same
 * measurement or a refusal — a state that moved, a checkpoint that disagrees
 * with the commit beside it, or an export that changed all refuse.
 *
 * An export that is not committed can still be published — a person may want
 * the state recorded before they commit — but only by naming the M20
 * checkpoint that holds those exact bytes. A checkpoint **is a commit object**
 * (leap, "Repository provenance"), so naming one does not relax the proof: the
 * ref is resolved in this repository, its commit is read, and every exported
 * file's blob is proved against that commit exactly as it would be against a
 * commit the person made. An id that resolves to nothing, or a state that does
 * not carry the export, is a refusal — "published at some state nobody can
 * point at" is exactly the provenance the leap forbids.
 */
import { relative } from "node:path";
import {
  WORK_PUBLISH_SOURCES_MAX,
  parseCheckpointRef,
  type ProjectWorkOrigin,
  type RepositoryStateRef,
  type WorkPublishApplyParams,
  type WorkPublishApplyResult,
  type WorkPublished,
  type WorkPublishEntity,
  type WorkPublishFile,
  type WorkPublishPreviewParams,
  type WorkPublishPreviewResult,
  type WorkPublishSource,
  type WorkPublishSourceKind,
  type WorkPublishSourceSelection,
} from "@lasercode/protocol";

import { ProjectWorkRefusedError } from "../errors.js";
import { canonicalJson, sha256 } from "../ids.js";
import { insideProject, insideProjectAt, projectDirectory, readTextFile } from "../export/paths.js";
import { ProjectWorkExport, type ComputedExport } from "../export/index.js";
import type { ProjectWorkStore } from "../store.js";
import { blobObjectId, checkpointCommit, listCheckpoints, repositoryAt, resolveCommit, treeAt, type GitRepository } from "./git.js";

/** The one state a preview measured against, and an apply records. */
interface ResolvedSource {
  kind: WorkPublishSourceKind;
  commitObjectId: string;
  checkpointId?: string;
  label: string;
}

/** Files this export's bytes are not in, bounded for a sentence. */
const MISSING_LISTED = 3;

interface PublishPlan {
  root: string;
  computed: ComputedExport;
  repository: GitRepository;
  /** The export root, relative to the repository's working tree. */
  repositoryRoot: string;
  /**
   * The state the export was measured against: the repository's current commit
   * unless the caller selected another, and `undefined` only when the
   * repository has no commit at all yet.
   */
  source?: ResolvedSource;
  /** That state's tree under the export root, read once and reused by the apply. */
  tree: Map<string, string>;
  files: WorkPublishFile[];
  uncommitted: string[];
  entities: WorkPublishEntity[];
}

export class ProjectWorkPublish {
  private readonly exporter: ProjectWorkExport;

  constructor(private readonly store: ProjectWorkStore) {
    this.exporter = new ProjectWorkExport(store);
  }

  preview(params: WorkPublishPreviewParams): WorkPublishPreviewResult {
    const root = this.exporter.rootOf(params.path);
    const plan = this.plan(params.projectId, root, params.source);
    if (!plan.ok) {
      return {
        root,
        previewDigest: sha256(canonicalJson({ root, refusal: plan.refusal })),
        files: [],
        uncommitted: [],
        entities: [],
        ready: false,
        refusal: plan.refusal,
      };
    }
    const { plan: ready } = plan;
    const complete = ready.source !== undefined && ready.uncommitted.length === 0;
    const selected: WorkPublishSource | undefined =
      ready.source === undefined
        ? undefined
        : {
            kind: ready.source.kind,
            commitObjectId: ready.source.commitObjectId,
            ...(ready.source.checkpointId !== undefined ? { checkpointId: ready.source.checkpointId } : {}),
            label: ready.source.label,
            carriesExport: ready.uncommitted.length === 0,
            missing: ready.uncommitted.slice(0, MISSING_LISTED),
          };
    return {
      root: ready.root,
      previewDigest: publishDigest(ready),
      repository: {
        repositoryId: this.repositoryId(params.projectId, ready.repository),
        name: ready.repository.toplevel.split(/[\\/]/).pop() ?? "this repository",
        objectFormat: ready.repository.objectFormat,
        ...(ready.repository.head !== undefined ? { head: ready.repository.head } : {}),
        ...(ready.repository.branch !== undefined ? { branch: ready.repository.branch } : {}),
      },
      files: ready.files,
      uncommitted: ready.uncommitted,
      entities: ready.entities,
      ...(selected ? { selected } : {}),
      sources: this.candidates(ready, selected),
      ...(complete
        ? {}
        : {
            commit: {
              method: "pi/project/git/commit" as const,
              cwd: ready.repository.toplevel,
              paths: [ready.repositoryRoot],
              message: `Publish project work export (${String(ready.entities.length)} item${ready.entities.length === 1 ? "" : "s"})`,
            },
          }),
      ready: complete,
      ...(complete
        ? {}
        : {
            refusal:
              ready.source === undefined
                ? "This repository has no commit yet, so there is no state to record this export at. Commit the export first."
                : `${String(ready.uncommitted.length)} exported file${ready.uncommitted.length === 1 ? " is" : "s are"} not in ${ready.source.label.toLowerCase()}. Commit them, or choose a state that carries these exact files, before recording where this work is published.`,
          }),
    };
  }

  /**
   * The states this repository offers to publish against, newest first.
   *
   * Host-resolved, bounded and proved: the current commit, then the checkpoints
   * this repository still has, each one measured against the export blob by blob
   * so the person chooses a state that *carries* their work rather than a name.
   * Discovery is read-only git and starts no worker.
   */
  private candidates(plan: PublishPlan, selected: WorkPublishSource | undefined): WorkPublishSource[] {
    const sources: WorkPublishSource[] = [];
    const seen = new Set<string>();
    const push = (source: WorkPublishSource): void => {
      const identity = `${source.kind}\u0000${source.commitObjectId}\u0000${source.checkpointId ?? ""}`;
      if (seen.has(identity) || sources.length >= WORK_PUBLISH_SOURCES_MAX) return;
      seen.add(identity);
      sources.push(source);
    };

    // Whatever the preview measured is offered first, already proved.
    if (selected) push(selected);
    const head = plan.repository.head;
    if (head !== undefined) {
      push({
        kind: "commit",
        commitObjectId: head,
        label: currentCommitLabel(plan.repository),
        ...this.carriedBy(plan, head),
      });
    }
    for (const row of listCheckpoints(plan.repository.toplevel, WORK_PUBLISH_SOURCES_MAX)) {
      push({
        kind: "checkpoint",
        commitObjectId: row.commitObjectId,
        checkpointId: row.ref,
        label: `Checkpoint from turn ${String(row.turn)}`,
        ...this.carriedBy(plan, row.commitObjectId),
      });
    }
    return sources;
  }

  /** Does this commit carry every one of the export's files? Proved, not assumed. */
  private carriedBy(plan: PublishPlan, commitObjectId: string): { carriesExport: boolean; missing: string[] } {
    const tree = treeAt(plan.repository.toplevel, commitObjectId, plan.repositoryRoot);
    const missing: string[] = [];
    for (const file of plan.computed.files) {
      const contents = plan.computed.contents.get(file.path);
      if (contents === undefined) continue;
      const repositoryPath = joinPath(plan.repositoryRoot, file.path);
      if (tree.get(repositoryPath) !== blobObjectId(plan.repository.objectFormat, contents)) missing.push(repositoryPath);
    }
    return { carriesExport: missing.length === 0, missing: missing.slice(0, MISSING_LISTED) };
  }

  apply(params: WorkPublishApplyParams, origin: ProjectWorkOrigin): Omit<WorkPublishApplyResult, "seq"> {
    const root = this.exporter.rootOf(params.path);
    // The selection the caller confirmed, in the same shape the preview took:
    // a checkpoint by its ref, or the commit it named. The plan resolves it and
    // measures the export against that state and no other.
    const selection: WorkPublishSourceSelection =
      params.checkpointId !== undefined ? { kind: "checkpoint", checkpointId: params.checkpointId } : { kind: "commit", commit: params.commit };
    const planned = this.plan(params.projectId, root, selection);
    if (!planned.ok) throw new ProjectWorkRefusedError(planned.refusal);
    const plan = planned.plan;
    const source = plan.source;
    if (!source) {
      throw new ProjectWorkRefusedError(
        "This repository has no commit yet, so there is no state to publish this export at. Commit the export first.",
      );
    }

    // Two identities that disagree are a refusal, never a preference: a caller
    // that names both a checkpoint and a commit must name that checkpoint's own
    // commit, so what is recorded is the state they confirmed.
    if (params.checkpointId !== undefined) {
      if (params.commit === "HEAD") {
        throw new ProjectWorkRefusedError(
          "A checkpoint is published at its own commit, so name that commit rather than the current one. Preview the publication again and record the state it shows.",
        );
      }
      const named = resolveCommit(plan.repository.toplevel, params.commit);
      if (named !== source.commitObjectId) {
        throw new ProjectWorkRefusedError(
          "That checkpoint and that commit are two different states, so nothing was recorded. Preview the publication again and record the state it shows.",
        );
      }
    }

    if (publishDigest(plan) !== params.previewDigest) {
      throw new ProjectWorkRefusedError(
        "The export, the repository or the state you chose changed after that preview, so nothing was recorded. Preview the publication again.",
      );
    }

    const commitObjectId = source.commitObjectId;
    const checkpoint = source.kind === "checkpoint" ? { ref: source.checkpointId! } : undefined;
    const missing: string[] = [];
    const blobs = new Map<string, string>();
    for (const file of plan.computed.files) {
      const contents = plan.computed.contents.get(file.path);
      if (contents === undefined) continue;
      const repositoryPath = joinPath(plan.repositoryRoot, file.path);
      const expected = blobObjectId(plan.repository.objectFormat, contents);
      if (plan.tree.get(repositoryPath) === expected) blobs.set(file.path, expected);
      else missing.push(repositoryPath);
    }
    if (missing.length > 0) {
      throw new ProjectWorkRefusedError(
        checkpoint
          ? `That checkpoint does not carry ${String(missing.length)} of this export's files (${missing.slice(0, MISSING_LISTED).join(", ")}). Export again, take a checkpoint of that state, and publish it — or commit the export.`
          : `That commit does not carry ${String(missing.length)} of this export's files (${missing.slice(0, MISSING_LISTED).join(", ")}). Commit the export, or publish the checkpoint whose commit carries these exact files.`,
      );
    }

    const repositoryId = this.repositoryId(params.projectId, plan.repository);
    const published: WorkPublished[] = [];
    for (const [index, entity] of plan.entities.entries()) {
      const document = `${entity.key}.md`;
      const contents = plan.computed.contents.get(document);
      const blob = blobs.get(document);
      if (contents === undefined || blob === undefined) continue;
      const state: RepositoryStateRef = {
        vcs: "git",
        objectFormat: plan.repository.objectFormat,
        commitObjectId,
        ...(checkpoint ? { checkpointId: checkpoint.ref } : {}),
        path: entity.publishedPath,
        // Proved above against this commit's tree, never computed into the
        // record from bytes git was not holding.
        blobObjectId: blob,
        contentDigest: sha256(contents),
      };
      const previous = this.previousPublication(params.projectId, entity.entityId);
      const result = this.store.link({
        projectId: params.projectId,
        expectedRevisionId: entity.revisionId,
        link: {
          type: "repository",
          relation: "published_as",
          subjectEntityId: entity.entityId,
          subjectRevisionId: entity.revisionId,
          repositoryId,
          target: { state },
          publishedPath: entity.publishedPath,
          ...(previous !== undefined ? { supersedesLinkId: previous } : {}),
        },
        origin,
        idempotencyKey: `pub-${sha256(params.idempotencyKey).slice(0, 24)}-${String(index)}`,
      });
      const record = result.link;
      if (record.type !== "repository") continue;
      published.push({
        entityId: entity.entityId,
        key: entity.key,
        linkId: record.repository.linkId,
        publishedPath: entity.publishedPath,
        ...(previous !== undefined ? { supersedesLinkId: previous } : {}),
      });
    }

    return {
      root: plan.root,
      repositoryId,
      commitObjectId,
      objectFormat: plan.repository.objectFormat,
      state: {
        vcs: "git",
        objectFormat: plan.repository.objectFormat,
        commitObjectId,
        ...(checkpoint ? { checkpointId: checkpoint.ref } : {}),
        path: plan.repositoryRoot,
        contentDigest: plan.computed.manifestDigest,
      },
      published,
    };
  }

  /**
   * What would be published, or the sentence saying why nothing can be.
   *
   * The export on disk is compared against the export this project's work
   * would produce right now: publishing a stale snapshot would record a
   * `published_as` for a revision whose document says something else, which is
   * the one thing a provenance link may never do.
   */
  private plan(
    projectId: string,
    root: string,
    selection?: WorkPublishSourceSelection,
  ): { ok: true; plan: PublishPlan } | { ok: false; refusal: string } {
    const projectRoot = projectDirectory(this.store, projectId);
    const absoluteRoot = insideProject(projectRoot, root);
    const computed = this.currentExportAt(projectId, root);
    if (!computed) {
      return {
        ok: false,
        refusal: `The export at ${root} is not there, or is not the export this project's work would produce now. Export again, then publish.`,
      };
    }
    const repository = repositoryAt(absoluteRoot) ?? repositoryAt(projectRoot);
    if (!repository) {
      return { ok: false, refusal: "This project is not in a git repository, so there is nowhere to publish its work to." };
    }
    const repositoryRoot = toPosix(relative(repository.toplevel, absoluteRoot));
    if (repositoryRoot.startsWith("..")) {
      return { ok: false, refusal: "The export is outside this repository's working tree, so it cannot be published from here." };
    }

    const resolved = resolveSource(repository, selection);
    if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
    const source = resolved.source;
    const tree = source ? treeAt(repository.toplevel, source.commitObjectId, repositoryRoot) : new Map<string, string>();
    const files: WorkPublishFile[] = [];
    const uncommitted: string[] = [];
    for (const file of computed.files) {
      const contents = computed.contents.get(file.path);
      if (contents === undefined) continue;
      const repositoryPath = joinPath(repositoryRoot, file.path);
      const committed = tree.get(repositoryPath) === blobObjectId(repository.objectFormat, contents);
      files.push({ path: repositoryPath, digest: file.digest, committed });
      if (!committed) uncommitted.push(repositoryPath);
    }

    const entities: WorkPublishEntity[] = computed.manifest.entities.map((entity) => {
      const existing = this.publicationOf(projectId, entity.entityId, entity.revisionId);
      return {
        entityId: entity.entityId,
        key: entity.key,
        revisionId: entity.revisionId,
        digest: entity.digest,
        publishedPath: joinPath(repositoryRoot, entity.document),
        ...(existing ? { publishedAs: existing } : {}),
      };
    });

    return { ok: true, plan: { root, computed, repository, repositoryRoot, ...(source ? { source } : {}), tree, files, uncommitted, entities } };
  }

  /**
   * The export this project would write right now, when the one on disk is
   * exactly it. Archived work is exported only if the snapshot on disk has it,
   * so both shapes of export can be published.
   */
  private currentExportAt(projectId: string, root: string): ComputedExport | undefined {
    const projectRoot = projectDirectory(this.store, projectId);
    const absolute = insideProject(projectRoot, root);
    for (const includeArchived of [false, true]) {
      const computed = this.exporter.compute(projectId, root, includeArchived);
      if (readAll(projectRoot, absolute, computed)) return computed;
    }
    return undefined;
  }

  /** The repository's stable id in this project, minted on first publication. */
  private repositoryId(projectId: string, repository: GitRepository): string {
    return this.store.ensureRepository({
      projectId,
      name: repository.toplevel.split(/[\\/]/).pop() ?? "repository",
      gitCommonDir: repository.commonDir,
      ...(repository.rootCommitId !== undefined ? { rootCommitId: repository.rootCommitId } : {}),
    });
  }

  /** The `published_as` already recorded for this exact revision, if any. */
  private publicationOf(projectId: string, entityId: string, revisionId: string): { linkId: string; commitObjectId: string } | undefined {
    for (const link of this.linksOf(projectId, entityId)) {
      if (link.relation !== "published_as" || link.subject.revisionId !== revisionId) continue;
      const commitObjectId = "state" in link.target ? link.target.state.commitObjectId : link.target.change.head.commitObjectId;
      return { linkId: link.linkId, commitObjectId };
    }
    return undefined;
  }

  /** The newest `published_as` of this item, whichever revision it was for. */
  private previousPublication(projectId: string, entityId: string): string | undefined {
    const links = this.linksOf(projectId, entityId).filter((link) => link.relation === "published_as");
    return links[links.length - 1]?.linkId;
  }

  private linksOf(projectId: string, entityId: string) {
    return this.store.get({
      projectId,
      entityId,
      body: { mode: "none" },
      include: { comments: false, approvals: false, evidence: false, links: true, history: false },
    }).repositoryLinks;
  }
}

/** Is every computed file on disk, byte for byte? */
function readAll(projectRoot: string, absoluteRoot: string, computed: ComputedExport): boolean {
  for (const file of computed.files) {
    const expected = computed.contents.get(file.path);
    if (expected === undefined) continue;
    const actual = readTextFile(insideProjectAt(projectRoot, absoluteRoot, file.path), 16 * 1024 * 1024);
    if (actual !== expected) return false;
  }
  return true;
}

function joinPath(prefix: string, path: string): string {
  return prefix === "" || prefix === "." ? path : `${prefix}/${path}`;
}

/**
 * The state a caller selected, resolved against this repository.
 *
 * Three shapes and nothing else: the current commit (the default, and what
 * publication has always used), a commit named by its object id, or an M20
 * checkpoint named by its exact ref. A checkpoint goes through
 * {@link checkpointCommit}, which proves the namespace, the exact name and that
 * it points at a commit; a commit goes through `rev-parse --verify`. An id that
 * resolves to nothing is a refusal naming what to do, never a fallback to
 * something else.
 */
function resolveSource(
  repository: GitRepository,
  selection: WorkPublishSourceSelection | undefined,
): { ok: true; source?: ResolvedSource } | { ok: false; refusal: string } {
  if (selection?.kind === "checkpoint") {
    const checkpoint = checkpointCommit(repository.toplevel, selection.checkpointId);
    if (!checkpoint) {
      return {
        ok: false,
        refusal:
          "That is not a checkpoint this repository still has, so there is no state to publish against. Check the publication again and choose one of the states it offers.",
      };
    }
    const turn = parseCheckpointRef(checkpoint.ref)?.turn;
    return {
      ok: true,
      source: {
        kind: "checkpoint",
        commitObjectId: checkpoint.commitObjectId,
        checkpointId: checkpoint.ref,
        label: turn === undefined ? "That checkpoint" : `Checkpoint from turn ${String(turn)}`,
      },
    };
  }
  const named = selection?.commit;
  if (named === undefined || named === "HEAD") {
    const head = repository.head;
    // No commit at all yet: not a refusal, but no state either. The preview says
    // what to do and the apply refuses.
    return head === undefined ? { ok: true } : { ok: true, source: { kind: "commit", commitObjectId: head, label: currentCommitLabel(repository) } };
  }
  const resolved = resolveCommit(repository.toplevel, named);
  if (!resolved) {
    return {
      ok: false,
      refusal: "That commit is not in this repository, so there is no state to publish against. Publish the commit the export was written in.",
    };
  }
  return {
    ok: true,
    source:
      resolved === repository.head
        ? { kind: "commit", commitObjectId: resolved, label: currentCommitLabel(repository) }
        : { kind: "commit", commitObjectId: resolved, label: `Commit ${resolved.slice(0, 7)}` },
  };
}

/** "Current commit on main" — what the person sees, never a raw id alone. */
function currentCommitLabel(repository: GitRepository): string {
  return repository.branch === undefined ? "Current commit" : `Current commit on ${repository.branch}`;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * What the person confirmed: the export's files and their digests, the state it
 * was measured against, and the exact revision of every item that would be
 * marked published. A commit, an edit, a new revision or a different chosen
 * state in between changes it.
 */
function publishDigest(plan: PublishPlan): string {
  return sha256(
    canonicalJson({
      root: plan.root,
      repositoryRoot: plan.repositoryRoot,
      // The state itself, not just the branch tip: a preview of a checkpoint and
      // a preview of a commit are two different confirmations, and an apply may
      // only use the one it was given.
      source: plan.source
        ? { kind: plan.source.kind, commitObjectId: plan.source.commitObjectId, checkpointId: plan.source.checkpointId ?? null }
        : null,
      head: plan.repository.head ?? null,
      manifestDigest: plan.computed.manifestDigest,
      files: plan.files.map((file) => ({ path: file.path, digest: file.digest, committed: file.committed })),
      entities: plan.entities.map((entity) => ({ key: entity.key, revisionId: entity.revisionId, path: entity.publishedPath })),
    }),
  );
}
