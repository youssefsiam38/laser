/**
 * ProjectWorkStore (M21-T2) — the canonical authority for the project
 * lifecycle (`docs/project-lifecycle-leap.md`, D-331).
 *
 * One transactional database under the product state root, partitioned by
 * stable `projectId`. It holds entities, immutable revisions, edges, comments,
 * approvals, decisions, evidence, repository links, execution links,
 * content-addressed blobs, the project event sequence and the value-only
 * search projection.
 *
 * What the rest of the host may rely on:
 *
 * - **Identity is the id, never the path.** A project is minted once and keeps
 *   its id across relocation; the paths it has lived at are rows pointing back
 *   at it. A worktree resolves to its parent project, and a repository keeps
 *   one opaque id across checkouts, worktrees, branches and remotes (D-345).
 * - **Keys are allocated inside the write that uses them** (D-355), never
 *   reused and never renumbered — not even after a delete, and not after a
 *   crash between two creates.
 * - **Revisions are immutable.** Nothing updates a row in `revisions`; the
 *   entity's current pointer moves only as part of the transaction that
 *   committed the child revision.
 * - **Every mutation is fenced and idempotent.** A stale `expectedRevisionId`
 *   raises a conflict carrying the current revision; a repeated
 *   `idempotencyKey` replays the first result instead of writing twice.
 * - **A full budget refuses the write.** Canonical revisions, comments and
 *   approvals are never evicted to make room; the refusal says what to do.
 *
 * It spawns nothing, imports no Pi and knows nothing about JSON-RPC.
 */
import {
  anchorResolves,
  artifactTransition,
  commentResolutionAllowed,
  designIsSketchOnly,
  projectWorkBodySchema,
  projectWorkKey,
  propagateStale,
  searchableBodyValues,
  statesForKind,
  taskActionTransition,
  taskTransition,
  TASK_ACTION_TARGET,
  REPOSITORY_CAPTURE_HISTORY_MAX,
  type AttemptRepositoryRecord,
  type DecisionCaptureBinding,
  type DecisionProofKind,
  type PlanGraphReport,
  type ProjectWorkActor,
  type RepositoryCaptureAttachReason,
  type RepositoryCaptureHistoryPage,
  type RepositoryCaptureHistoryQuery,
  type RepositoryLinkCaptureRevision,
  type ProjectTaskBody,
  type RepositoryChangeRef,
  type RepositoryLinkAcceptance,
  type RepositoryLinkContext,
  type RepositoryStateRef,
  type TaskConflict,
  type TaskReadiness,
  type ApprovedRevision,
  type ArtifactReviewState,
  type ExecutionLink,
  type ProjectTaskState,
  type ProjectWorkApproval,
  type ProjectWorkBody,
  type ProjectWorkComment,
  type ProjectWorkDecision,
  type ProjectWorkEdge,
  type ProjectWorkEntity,
  type ProjectWorkEvidence,
  type ProjectWorkKind,
  type ProjectWorkOrigin,
  type ProjectWorkRef,
  type ProjectWorkRevision,
  type ProjectWorkStaleCause,
  type ProjectWorkState,
  type RepositoryLink,
  type StaleGraphEdge,
  type StaleGraphEntity,
  type ProjectWorkChange,
  type ProjectWorkAttentionItem,
  type ProjectWorkListItem,
  type ProjectWorkCounts,
  type ProjectWorkBodyPage,
  type ProjectWorkSearchResult,
  type ProjectWorkLinkInput,
  type ProjectWorkLinkRecord,
  type ProjectTaskAction,
  type ProjectWorkReviewAction,
  type BlockingCommentRef,
  type GateReport,
  type ApprovalGate,
  type ApprovalDecision,
  type ApprovalMode,
  type ProjectWorkAnchor,
  PROJECT_WORK_KINDS,
} from "@lasercode/protocol";
import { ProjectWorkConflictError, ProjectWorkNotFoundError, ProjectWorkQuotaError, ProjectWorkRefusedError } from "./errors.js";
import {
  recomputeProjectUsage,
  rowCharge,
  PROJECT_WORK_GLOBAL_RECORDS_DEFAULT,
  PROJECT_WORK_PROJECT_RECORDS_DEFAULT,
  type CanonicalTable,
} from "./accounting.js";
import { blobBytes, deleteBlob, putBlob, readBlobRange, releaseBlob, type BlobRange, type StoredBlob } from "./blobs.js";
import { GateEngine, type GateEntity, type GateReader } from "./gates.js";
import {
  bodyDigest,
  canonicalJson,
  mintApprovalId,
  mintCaptureRevisionId,
  mintCommentId,
  mintDecisionId,
  mintEntityId,
  mintEvidenceId,
  mintLinkId,
  mintProjectId,
  mintProofBindingId,
  mintRepositoryId,
  mintRevisionId,
  repositoryIdentityKey,
  sha256,
  type RepositoryIdentityInput,
} from "./ids.js";
import { openProjectWorkDatabase, transaction, type ProjectWorkDatabase, type ProjectWorkStatement } from "./schema.js";
import { TaskEngine, type CascadeIntent, type EngineEntity, type EngineEvidence, type TaskEngineReader } from "./task-engine.js";

/** Per-project durable budget. Canonical work is refused at the cap, never evicted. */
export const PROJECT_WORK_PROJECT_BYTES_DEFAULT = 512 * 1024 * 1024;
/** Every project together. */
export const PROJECT_WORK_GLOBAL_BYTES_DEFAULT = 4 * 1024 * 1024 * 1024;
/** Entities one project may hold. Far above any real backlog. */
export const PROJECT_WORK_PROJECT_ENTITIES_DEFAULT = 20_000;
/** Events kept per project. Below this a client reconciles with a full page. */
export const PROJECT_WORK_EVENTS_RETAINED = 5000;
export { PROJECT_WORK_GLOBAL_RECORDS_DEFAULT, PROJECT_WORK_PROJECT_RECORDS_DEFAULT } from "./accounting.js";

/**
 * What a person can do when a project's durable budget is full.
 *
 * It never suggests archiving: archiving hides an item and keeps every byte of
 * its history, which is exactly what the leap requires of it.
 */
const PROJECT_FULL_RECOVERY =
  "Export or permanently delete some of this project's saved work — attachments and sketches first — and try again. " +
  "Archiving an item hides it and keeps its history, so it frees nothing. Nothing from this action was saved.";

/** The same, when it is every project together that has no room left. */
const GLOBAL_FULL_RECOVERY =
  "Permanently delete project work you no longer need from another project, or export it, and try again. " +
  "Archiving an item hides it and keeps its history, so it frees nothing. Nothing from this action was saved.";

/** The same, when it is the number of items in one project that is full. */
const ITEM_LIMIT_RECOVERY =
  "Permanently delete some project work before adding more. Archiving an item hides it and keeps its history, so it frees nothing.";

/**
 * What an earlier transaction already saved, when this one is refused
 * (M21-T2 corrections, item 2; storage review H-1).
 *
 * Several doors of this store write in two steps: a capture, a report or some
 * other blob is stored by one transaction, and the record that rests on it is
 * written by the next one. If the second transaction is refused for space,
 * "nothing from this action was saved" is a lie about bytes the person can
 * still read — and it stays a lie whichever ceiling refused it, this
 * project's or the whole app's.
 *
 * So a door that consumes earlier-transaction bytes carries this with it:
 * what is still there, what did not happen, and what to do after making room.
 * Three phrases rather than a sentence per door, because the difference
 * between approving, accepting a delivery and saving a record that points at
 * a report is real and a person can hear it.
 */
export interface PreparedWrite {
  /** What an earlier transaction saved and that is still readable. */
  kept: string;
  /** What this refused transaction did not record. */
  refused: string;
  /** How the sentence "make room and …" ends. */
  retry: string;
}

/** The refusal a {@link PreparedWrite} gets at either ceiling. */
export function preparedRefusedRecovery(prepared: PreparedWrite, scope: "project" | "global" = "project"): string {
  const room =
    scope === "project"
      ? `Export or permanently delete some of this project's saved work — attachments and sketches first — and ${prepared.retry}. `
      : `Export or permanently delete project work you no longer need from another project, and ${prepared.retry}. `;
  return `${prepared.kept}; ${prepared.refused}. ` + room + "Archiving an item hides it and keeps its history, so it frees nothing.";
}

/** A gate prepared its evidence, and the decision it was for was refused. */
function preparedDecision(gate: string): PreparedWrite {
  return {
    kept: `The evidence ${gate} prepared is kept and can still be read`,
    refused: "the decision itself was not recorded",
    retry: "decide again",
  };
}

/** The capture of an accepted change outlived the acceptance that was refused. */
function preparedDelivery(): PreparedWrite {
  return {
    kept: "The evidence this delivery was checked against is kept and can still be read",
    refused: "the delivery itself was not accepted",
    retry: "accept it again",
  };
}

/** A state was captured, and the record naming it was refused. */
function preparedCapture(gate: string): PreparedWrite {
  return {
    kept: `The evidence ${gate} prepared is kept and can still be read`,
    refused: "the record of it was not saved",
    retry: "record it again",
  };
}

/** A correction to which capture a record points at was refused. */
function preparedCorrection(gate?: string | undefined): PreparedWrite {
  return {
    kept: gate
      ? `The evidence ${gate} prepared is kept and can still be read`
      : "The evidence that was captured is kept and can still be read",
    refused: "this record still points at the evidence it pointed at before",
    retry: "try again",
  };
}

/**
 * The general case: a record that names something an earlier transaction
 * already stored.
 *
 * A verification report is the one this store writes today — the report blob
 * is stored, then the evidence row that points at it — but the shape is the
 * point: any later door that saves bytes first and names them afterwards gets
 * a truthful refusal without having to remember to ask for one.
 */
function preparedStoredData(): PreparedWrite {
  return {
    kept: "What this record points at was already saved and can still be read",
    refused: "the record naming it was not saved",
    retry: "try again",
  };
}

/**
 * What a refusal says when a gate already stored its evidence.
 *
 * The capture was written by an earlier transaction and is still there; only
 * the decision's own transaction rolled back. Saying "nothing was saved" here
 * would be a lie about a blob the person can still read — and it stays a lie
 * when it is the whole app's budget that is full rather than this project's,
 * so the sentence exists for both scopes and only the way to make room
 * changes (M21-T2 corrections, item 2).
 */
export function decisionRefusedRecovery(gate: string, scope: "project" | "global" = "project"): string {
  return preparedRefusedRecovery(preparedDecision(gate), scope);
}

/**
 * Why one item cannot be deleted while another item's record rests on its
 * proof (M21-T2 corrections, item 4).
 *
 * It names the dependent item, because "another item" is not something a
 * person can act on, and it does not offer a recovery that does not exist:
 * superseding a decision, recording a correction or capturing a state again
 * all leave the original reference exactly where it is — that is what makes
 * the history worth keeping. The two things that really work are keeping this
 * item, or deleting the dependent work as explicitly as this deletion was
 * asked for. The store rewrites nobody's history to make room for a deletion.
 */
function dependentProofRefusal(key: string, rests: string): string {
  return (
    `${key}'s ${rests}, so deleting this item would leave ${key} naming proof nobody can read. ` +
    `Superseding a decision or capturing that state again does not remove the reference — it is part of ${key}'s own history and stays. ` +
    `Keep this item, or permanently delete ${key} first if that work should go as well.`
  );
}

export interface ProjectWorkQuota {
  projectBytes?: number;
  globalBytes?: number;
  projectEntities?: number;
  /** Canonical rows one project may keep. A count, never a size. */
  projectRecords?: number;
  /** Canonical rows every project together may keep. */
  globalRecords?: number;
}

export interface ProjectWorkStoreOptions {
  /** Database file. `:memory:` for tests. */
  file: string;
  quota?: ProjectWorkQuota;
  /** Events kept per project. Below the default only in tests. */
  eventsRetained?: number;
  now?: () => Date;
  log?: (message: string) => void;
  /** Called after a mutation commits, so the host can notify clients. */
  onEvent?: (event: { projectId: string; seq: number; change: ProjectWorkChange }) => void;
}

export interface ProjectWorkWriteOrigin {
  origin: ProjectWorkOrigin;
  idempotencyKey: string;
}

/**
 * One capture association a gate read while it was preparing a decision
 * (D-363).
 *
 * The blob **and** the association that made it current: the pair is what the
 * decision's own transaction rechecks, so a proof that moved between
 * preparation and decision is caught even when the new capture happens to be
 * the same bytes as some earlier one.
 */
export interface DecisionProofRef {
  linkId: string;
  blobId: string;
  associationRevisionId: string;
  associationSeq: number;
}

/**
 * What a gate's preparation established, handed to the decision it was for.
 *
 * Preparation is not a decision: this is only ever *bound* inside the
 * transaction that really writes the approval or the completion, and a
 * refused decision leaves no binding behind.
 */
export interface DecisionProofPreparation {
  /** The gate's own words, so a moved proof refuses in the decision's language. */
  gate: string;
  refs: DecisionProofRef[];
}

interface EntityRow {
  entity_id: string;
  project_id: string;
  kind: string;
  key: string;
  key_number: number;
  title: string;
  state: string;
  state_before_archive: string | null;
  current_revision_id: string;
  current_digest: string;
  revision_count: number;
  created_at: string;
  updated_at: string;
  updated_seq: number;
  archived_at: string | null;
  stale_json: string | null;
  blocking_comments: number;
  needs_attention: number;
}

interface RevisionRow {
  revision_id: string;
  project_id: string;
  entity_id: string;
  kind: string;
  idx: number;
  parent_revision_id: string | null;
  title: string;
  digest: string;
  body_bytes: number;
  body: string;
  created_at: string;
  origin_json: string;
  state: string;
  note: string | null;
}

export interface ProjectWorkListQuery {
  projectId: string;
  kinds?: readonly ProjectWorkKind[] | undefined;
  states?: readonly ProjectWorkState[] | undefined;
  needsYou?: boolean | undefined;
  hasLinks?: boolean | undefined;
  includeArchived?: boolean | undefined;
  updatedSince?: string | undefined;
  sinceSeq?: number | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ProjectWorkListPage {
  projectId: string;
  seq: number;
  items: ProjectWorkListItem[];
  counts: ProjectWorkCounts;
  nextCursor?: string;
  removed?: string[];
  reset?: boolean;
}

export interface ProjectWorkDetail {
  ref: ProjectWorkRef;
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  fence: { entityId: string; revisionId: string; digest: string; seq: number };
  body?: ProjectWorkBodyPage;
  edges: ProjectWorkEdge[];
  repositoryLinks: RepositoryLink[];
  executionLinks: ExecutionLink[];
  comments: ProjectWorkComment[];
  approvals: ProjectWorkApproval[];
  evidence: ProjectWorkEvidence[];
  decisions: ProjectWorkDecision[];
  history?: ProjectWorkRevision[];
  /** Tasks only: derived readiness (M21-T15). */
  readiness?: TaskReadiness;
  /** Tasks only: the other active Tasks writing in the same places. */
  conflicts?: TaskConflict[];
  /** Plans only: the Task graph, including the Tasks this Plan stopped listing. */
  planGraph?: PlanGraphReport;
  /** The three gates of the Spec this entity's lifecycle belongs to (M21-T8). */
  gates?: GateReport;
  truncated: string[];
}

/** How many related records one `get` inlines before it says it cut the list. */
const RELATED_MAX = 100;

/**
 * What an attempt changed, in the words its evidence record uses (M21-T18).
 *
 * One phrase per repository that recorded something, so a monorepo reads as
 * two facts rather than one merged number, and a repository the attempt did
 * not touch is silent rather than reported as zero.
 */
function changeSummary(repositories: readonly AttemptRepositoryRecord[]): string[] {
  const phrases: string[] = [];
  for (const repository of repositories) {
    if (repository.changedPaths.length === 0 && repository.checkpoints.length === 0) continue;
    const files = repository.changedPaths.length;
    const checkpoints = repository.checkpoints.length;
    phrases.push(
      `${String(files)} file${files === 1 ? "" : "s"} changed in ${repository.name} across ${String(checkpoints)} checkpoint${checkpoints === 1 ? "" : "s"}`,
    );
  }
  return phrases;
}
/** Projections one search may rebuild before it answers. Keeps a read bounded. */
const PROJECTION_REPAIR_MAX = 200;

export class ProjectWorkStore {
  private readonly db: ProjectWorkDatabase;
  private readonly statements = new Map<string, ProjectWorkStatement>();
  private readonly quota: Required<ProjectWorkQuota>;
  private readonly clock: () => Date;
  private readonly log: (message: string) => void;
  private readonly onEvent: ((event: { projectId: string; seq: number; change: ProjectWorkChange }) => void) | undefined;
  private readonly eventsRetained: number;
  /** The Plan DAG and Task rules (M21-T15). Reads through this store's rows. */
  private readonly engine: TaskEngine;
  /** The three hard gates (M21-T8). Reads through this store's rows. */
  private readonly gates: GateEngine;
  private closed = false;
  /** Events raised inside the open transaction, published after it commits. */
  private pending: Array<{ projectId: string; seq: number; change: ProjectWorkChange }> = [];

  constructor(options: ProjectWorkStoreOptions) {
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.onEvent = options.onEvent;
    this.db = openProjectWorkDatabase(options.file, this.log);
    this.engine = new TaskEngine(this.engineReader());
    this.gates = new GateEngine(this.gateReader());
    this.eventsRetained = Math.max(1, Math.trunc(options.eventsRetained ?? PROJECT_WORK_EVENTS_RETAINED));
    this.quota = {
      projectBytes: options.quota?.projectBytes ?? PROJECT_WORK_PROJECT_BYTES_DEFAULT,
      globalBytes: options.quota?.globalBytes ?? PROJECT_WORK_GLOBAL_BYTES_DEFAULT,
      projectEntities: options.quota?.projectEntities ?? PROJECT_WORK_PROJECT_ENTITIES_DEFAULT,
      projectRecords: options.quota?.projectRecords ?? PROJECT_WORK_PROJECT_RECORDS_DEFAULT,
      globalRecords: options.quota?.globalRecords ?? PROJECT_WORK_GLOBAL_RECORDS_DEFAULT,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // -------------------------------------------------------------- plumbing

  private statement(sql: string): ProjectWorkStatement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /**
   * One mutation: a single transaction, and the events it raised published
   * only once it has committed. A client can therefore never hear about a
   * change that is not on disk.
   */
  private write<T>(work: () => T): T {
    this.pending = [];
    this.ledger.clear();
    this.prepared = undefined;
    let result: T;
    try {
      // Admission is settled inside the transaction, after the work and before
      // the commit: a refusal throws here and `transaction` rolls back the
      // rows, the counters, the sequence, the events and the idempotency
      // receipt together, so a refused write leaves nothing at all behind.
      result = transaction(this.db, () => {
        const done = work();
        this.settle();
        return done;
      });
    } catch (error) {
      this.pending = [];
      throw error;
    } finally {
      this.ledger.clear();
      this.prepared = undefined;
    }
    const events = this.pending;
    this.pending = [];
    for (const event of events) {
      try {
        this.onEvent?.(event);
      } catch (error) {
        this.log(`project work: a listener threw on event ${event.seq}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  // -------------------------------------------------------------- identity

  /**
   * The stable id of the project a directory belongs to.
   *
   * `projectRoot` is the caller's resolved project directory — a worktree has
   * already been mapped to its parent by the host, which is what makes a
   * worktree session see the same Specs and Tasks. A path this store has never
   * seen mints a new id unless `create` says otherwise.
   */
  projectIdFor(projectRoot: string, options: { create?: boolean } = {}): string | undefined {
    const known = this.statement("SELECT project_id FROM project_paths WHERE path = ?").get(projectRoot) as { project_id: string } | undefined;
    if (known) return known.project_id;
    if (options.create === false) return undefined;
    return this.write(() => {
      const again = this.statement("SELECT project_id FROM project_paths WHERE path = ?").get(projectRoot) as { project_id: string } | undefined;
      if (again) return again.project_id;
      const projectId = mintProjectId();
      const now = this.now();
      this.statement("INSERT INTO projects (project_id, created_at) VALUES (?,?)").run(projectId, now);
      this.statement("INSERT INTO project_paths (path, project_id, current, seen_at) VALUES (?,?,1,?)").run(projectRoot, projectId, now);
      // A project's identity and the paths it has lived at are canonical
      // mappings, not free bookkeeping: losing them loses which work belongs
      // to which folder (D-365).
      this.chargeRow("projects", projectId, "project_id = ?", [projectId], true);
      this.chargeRow("project_paths", projectId, "path = ?", [projectRoot], true);
      return projectId;
    });
  }

  /** True when this id names a project the store knows. */
  hasProject(projectId: string): boolean {
    return this.statement("SELECT 1 AS present FROM projects WHERE project_id = ?").get(projectId) !== undefined;
  }

  /** Every path this project has been opened at, current first. */
  projectPaths(projectId: string): string[] {
    const rows = this.statement("SELECT path, current FROM project_paths WHERE project_id = ? ORDER BY current DESC, seen_at DESC").all(projectId) as Array<{
      path: string;
      current: number;
    }>;
    return rows.map((row) => row.path);
  }

  /**
   * A project moved. The new path points at the same id, the old one is kept
   * as history, and nothing is merged: a path that already belongs to another
   * project is refused rather than quietly taking its work.
   */
  relinkProject(projectId: string, projectRoot: string): void {
    this.write(() => {
      if (!this.hasProject(projectId)) throw new ProjectWorkNotFoundError("That project is not one this app has project work for.");
      const owner = this.statement("SELECT project_id FROM project_paths WHERE path = ?").get(projectRoot) as { project_id: string } | undefined;
      if (owner && owner.project_id !== projectId) {
        throw new ProjectWorkRefusedError(
          "Another project already keeps its work at that folder. Open that project instead, or choose a different folder.",
        );
      }
      const now = this.now();
      const existing = this.statement("SELECT 1 AS present FROM project_paths WHERE path = ?").get(projectRoot) !== undefined;
      this.statement("UPDATE project_paths SET current = 0 WHERE project_id = ?").run(projectId);
      this.statement(
        "INSERT INTO project_paths (path, project_id, current, seen_at) VALUES (?,?,1,?) " +
          "ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, current = 1, seen_at = excluded.seen_at",
      ).run(projectRoot, projectId, now);
      this.statement("UPDATE projects SET removed_at = NULL WHERE project_id = ?").run(projectId);
      this.chargeRow("project_paths", projectId, "path = ?", [projectRoot], !existing);
      this.chargeRow("projects", projectId, "project_id = ?", [projectId]);
    });
  }

  /**
   * The person removed the project from their list. Its work is retained, and
   * hidden, until an explicit delete (leap, "Relationship graph").
   */
  removeProject(projectId: string): void {
    this.write(() => {
      this.statement("UPDATE projects SET removed_at = ? WHERE project_id = ?").run(this.now(), projectId);
      this.chargeRow("projects", projectId, "project_id = ?", [projectId]);
    });
  }

  /** True when this project's work is retained but hidden. */
  isRemoved(projectId: string): boolean {
    const row = this.statement("SELECT removed_at FROM projects WHERE project_id = ?").get(projectId) as { removed_at: string | null } | undefined;
    return row?.removed_at !== null && row?.removed_at !== undefined;
  }

  /** The explicit **Delete project work** confirmation. Everything, for good. */
  deleteProjectWork(projectId: string): { entities: number } {
    return this.write(() => {
      const count = (this.statement("SELECT COUNT(*) AS n FROM entities WHERE project_id = ?").get(projectId) as { n: number }).n;
      // One statement per table: `ON DELETE CASCADE` covers them, but deleting
      // the project row is the last thing that happens, so a failure part way
      // through rolls back with the project still intact.
      for (const table of [
        "search_projection",
        "idempotency",
        "events",
        "blob_chunks",
        "blobs",
        "evidence",
        "decisions",
        "decision_capture_bindings",
        "decision_capture_binding_sets",
        "approvals",
        "comments",
        "execution_links",
        "repository_link_captures",
        "repository_links",
        "edges",
        "revisions",
        "entities",
        "key_sequences",
        "repositories",
        "project_paths",
      ]) {
        if (table === "blob_chunks") {
          this.statement("DELETE FROM blob_chunks WHERE blob_id IN (SELECT blob_id FROM blobs WHERE project_id = ?)").run(projectId);
          continue;
        }
        this.statement(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      }
      this.statement("DELETE FROM projects WHERE project_id = ?").run(projectId);
      return { entities: Number(count) };
    });
  }

  /**
   * The stable id of one repository in the project's workspace.
   *
   * The caller resolves the workspace shape and hands over each repository's
   * git common directory (a worktree's is its owner's) and, when git could
   * supply one, its root commit. The identity key derived from those survives
   * relocation and worktrees; the id itself never changes once minted.
   */
  ensureRepository(input: RepositoryIdentityInput & { projectId: string; name: string }): string {
    const identityKey = repositoryIdentityKey(input);
    const existing = this.statement("SELECT repository_id FROM repositories WHERE project_id = ? AND identity_key = ?").get(
      input.projectId,
      identityKey,
    ) as { repository_id: string } | undefined;
    if (existing) {
      this.write(() => {
        this.statement("UPDATE repositories SET last_dir = ?, name = ? WHERE repository_id = ?").run(
          input.gitCommonDir,
          input.name,
          existing.repository_id,
        );
        this.chargeRow("repositories", input.projectId, "repository_id = ?", [existing.repository_id]);
      });
      return existing.repository_id;
    }
    return this.write(() => {
      const again = this.statement("SELECT repository_id FROM repositories WHERE project_id = ? AND identity_key = ?").get(
        input.projectId,
        identityKey,
      ) as { repository_id: string } | undefined;
      if (again) return again.repository_id;
      const repositoryId = mintRepositoryId();
      this.statement(
        "INSERT INTO repositories (repository_id, project_id, identity_key, name, last_dir, created_at) VALUES (?,?,?,?,?,?)",
      ).run(repositoryId, input.projectId, identityKey, input.name, input.gitCommonDir, this.now());
      this.chargeRow("repositories", input.projectId, "repository_id = ?", [repositoryId], true);
      return repositoryId;
    });
  }

  /** Every repository this project has registered. */
  repositories(projectId: string): Array<{ repositoryId: string; name: string }> {
    const rows = this.statement("SELECT repository_id, name FROM repositories WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as Array<{
      repository_id: string;
      name: string;
    }>;
    return rows.map((row) => ({ repositoryId: row.repository_id, name: row.name }));
  }

  // ------------------------------------------------------------ accounting

  /** What this project and the whole store are using right now. */
  usage(projectId?: string): {
    projectBytes: number;
    globalBytes: number;
    entities: number;
    records: number;
    globalRecords: number;
    limits: Required<ProjectWorkQuota>;
  } {
    const global = this.statement("SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(record_count), 0) AS r FROM projects").get() as {
      b: number;
      r: number;
    };
    if (!projectId) {
      return { projectBytes: 0, globalBytes: Number(global.b), entities: 0, records: 0, globalRecords: Number(global.r), limits: this.quota };
    }
    const row = this.statement("SELECT bytes, entity_count, record_count FROM projects WHERE project_id = ?").get(projectId) as
      | { bytes: number; entity_count: number; record_count: number }
      | undefined;
    return {
      projectBytes: Number(row?.bytes ?? 0),
      globalBytes: Number(global.b),
      entities: Number(row?.entity_count ?? 0),
      records: Number(row?.record_count ?? 0),
      globalRecords: Number(global.r),
      limits: this.quota,
    };
  }

  /**
   * Count this project's charge again from its own rows (M21-T2, D-365).
   *
   * The independent invariant behind the counters: it derives every charge
   * from the **raw stored values**, never by summing the `charged_bytes` the
   * writers wrote, so a writer that forgot to recharge a row it updated shows
   * up as a disagreement rather than as two copies of the same mistake. A full
   * scan of one project, and therefore never part of a write: it is the
   * integrity surface and what the tests assert against.
   */
  reconcileUsage(projectId: string): { bytes: number; records: number; entities: number; changed: boolean } {
    const counted = recomputeProjectUsage(this.db, projectId);
    const stored = this.usage(projectId);
    return {
      ...counted,
      changed: counted.bytes !== stored.projectBytes || counted.records !== stored.records || counted.entities !== stored.entities,
    };
  }

  /**
   * What this transaction has charged and credited so far, per project.
   *
   * Admission is decided **once**, on the net delta, when the transaction is
   * about to commit — never per statement. That is what lets a store that is
   * already over its cap recover: a deletion that credits more than the
   * idempotency receipt it writes afterwards costs is net non-growth and is
   * allowed through, even though the store is still over the limit at the end
   * of it. A per-statement check would refuse exactly the operation that fixes
   * the problem.
   */
  private ledger = new Map<string, { bytes: number; entities: number; records: number }>();
  /**
   * What an earlier transaction already saved for the write this transaction
   * is making, if anything.
   *
   * A door that consumes bytes stored before it — a gate's capture, a state
   * capture, a verification report — records it here, and every ceiling this
   * transaction can reach (this project's bytes or records, or the whole
   * app's) refuses in words that do not claim that preparation was rolled
   * back. Only this transaction's own work was.
   */
  private prepared: PreparedWrite | undefined;

  private note(projectId: string, delta: { bytes?: number; entities?: number; records?: number }): void {
    const current = this.ledger.get(projectId) ?? { bytes: 0, entities: 0, records: 0 };
    current.bytes += delta.bytes ?? 0;
    current.entities += delta.entities ?? 0;
    current.records += delta.records ?? 0;
    this.ledger.set(projectId, current);
  }

  /**
   * Charge (or recharge) one row from what is actually stored in it.
   *
   * The same call answers an insert and an update: it reads the row back,
   * prices it with the one definition in `accounting.ts`, and moves the
   * ledger by the difference from whatever that row was charged before. A
   * shrinking update therefore credits, and a row whose update changed no
   * charged column costs one read and writes nothing.
   */
  private chargeRow(table: CanonicalTable, projectId: string, where: string, params: readonly unknown[], inserted = false): number {
    const row = this.statement(`SELECT * FROM ${table} WHERE ${where}`).get(...params) as Record<string, unknown> | undefined;
    if (!row) return 0;
    const next = rowCharge(table, row);
    const previous = Number(row["charged_bytes"] ?? 0);
    if (next !== previous) {
      this.statement(`UPDATE ${table} SET charged_bytes = ? WHERE ${where}`).run(next, ...params);
    }
    this.note(projectId, { bytes: next - previous, records: inserted ? 1 : 0 });
    return next;
  }

  /**
   * Give back exactly what the rows a `DELETE` is about to remove were
   * charged. Called immediately before the delete, with the same `WHERE`.
   */
  private creditRows(table: CanonicalTable, projectId: string, where: string, params: readonly unknown[]): { bytes: number; rows: number } {
    const row = this.statement(`SELECT COALESCE(SUM(charged_bytes), 0) AS b, COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as {
      b: number;
      n: number;
    };
    const bytes = Number(row.b);
    const rows = Number(row.n);
    if (rows > 0) this.note(projectId, { bytes: -bytes, records: -rows });
    return { bytes, rows };
  }

  /** Recharge one entity row after an update that touched a stored value. */
  private touchEntity(projectId: string, entityId: string): void {
    this.chargeRow("entities", projectId, "entity_id = ?", [entityId]);
  }

  /**
   * Decide the whole transaction's admission, then move the counters.
   *
   * Every ceiling is checked against the usage this transaction **started**
   * with — the counters are only written here, so reading them now is reading
   * the entry value — plus this transaction's net delta. A delta that does not
   * grow is always admitted, whatever the usage is: that is the rule that
   * keeps an over-cap store recoverable, and the reason a migrated store can
   * still be deleted from. One counter read per project plus one global sum,
   * however many rows the transaction wrote.
   */
  private settle(): void {
    if (this.ledger.size === 0) return;
    let globalBytes = 0;
    let globalRecords = 0;
    for (const delta of this.ledger.values()) {
      globalBytes += delta.bytes;
      globalRecords += delta.records;
    }
    // The same truth in both scopes: bytes an earlier transaction stored are
    // still there, whichever budget is full.
    const recovery = this.prepared ? preparedRefusedRecovery(this.prepared) : PROJECT_FULL_RECOVERY;
    const globalRecovery = this.prepared ? preparedRefusedRecovery(this.prepared, "global") : GLOBAL_FULL_RECOVERY;
    for (const [projectId, delta] of this.ledger) {
      const entry = this.statement("SELECT bytes, entity_count, record_count FROM projects WHERE project_id = ?").get(projectId) as
        | { bytes: number; entity_count: number; record_count: number }
        | undefined;
      const bytes = Number(entry?.bytes ?? 0);
      const entities = Number(entry?.entity_count ?? 0);
      const records = Number(entry?.record_count ?? 0);
      if (delta.entities > 0 && entities + delta.entities > this.quota.projectEntities) {
        throw new ProjectWorkQuotaError("project", bytes, this.quota.projectBytes, ITEM_LIMIT_RECOVERY, {
          measure: "entities",
          used: entities,
          limit: this.quota.projectEntities,
        });
      }
      if (delta.records > 0 && records + delta.records > this.quota.projectRecords) {
        throw new ProjectWorkQuotaError("project", bytes, this.quota.projectBytes, recovery, {
          measure: "records",
          used: records + delta.records,
          limit: this.quota.projectRecords,
        });
      }
      if (delta.bytes > 0 && bytes + delta.bytes > this.quota.projectBytes) {
        throw new ProjectWorkQuotaError("project", bytes + delta.bytes, this.quota.projectBytes, recovery);
      }
    }
    if (globalBytes > 0 || globalRecords > 0) {
      const whole = this.statement("SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(record_count), 0) AS r FROM projects").get() as {
        b: number;
        r: number;
      };
      const bytes = Number(whole.b);
      const records = Number(whole.r);
      if (globalRecords > 0 && records + globalRecords > this.quota.globalRecords) {
        throw new ProjectWorkQuotaError("global", bytes, this.quota.globalBytes, globalRecovery, {
          measure: "records",
          used: records + globalRecords,
          limit: this.quota.globalRecords,
        });
      }
      if (globalBytes > 0 && bytes + globalBytes > this.quota.globalBytes) {
        throw new ProjectWorkQuotaError("global", bytes + globalBytes, this.quota.globalBytes, globalRecovery);
      }
    }
    // Counters move by exactly the transaction's delta. There is no `MAX(0,
    // …)` here on purpose: clamping a negative total would turn an accounting
    // fault into a ledger that merely *looks* right, and every later refusal
    // and every later credit would be computed from a number nobody could
    // trust. A total that would end below zero means this store's counters and
    // its rows disagree, so the whole transaction is refused and rolled back —
    // the rows it was going to write are not saved, and not one row that was
    // already there is changed or removed (M21-T2 corrections, item 3).
    for (const [projectId, delta] of this.ledger) {
      this.statement(
        "UPDATE projects SET bytes = bytes + ?, entity_count = entity_count + ?, record_count = record_count + ? WHERE project_id = ?",
      ).run(delta.bytes, delta.entities, delta.records, projectId);
      const settled = this.statement("SELECT bytes, entity_count, record_count FROM projects WHERE project_id = ?").get(projectId) as
        | { bytes: number; entity_count: number; record_count: number }
        | undefined;
      if (!settled) continue;
      const negative =
        Number(settled.bytes) < 0
          ? "size"
          : Number(settled.record_count) < 0
            ? "number of saved records"
            : Number(settled.entity_count) < 0
              ? "number of items"
              : undefined;
      if (negative) {
        throw new ProjectWorkRefusedError(
          `This change was not saved: it would leave this project's stored ${negative} counted as less than nothing, ` +
            "which means the tally of what is saved no longer matches what is really there. " +
            "Nothing already saved was changed or removed, and all of it is still readable. " +
            "Export this project's work before changing more of it.",
        );
      }
    }
  }

  // ---------------------------------------------------------------- events

  private raise(projectId: string, change: Omit<ProjectWorkChange, "at"> & { at?: string }): number {
    const at = change.at ?? this.now();
    const row = this.statement("SELECT seq FROM projects WHERE project_id = ?").get(projectId) as { seq: number } | undefined;
    if (!row) throw new ProjectWorkNotFoundError("That project is not one this app has project work for.");
    const seq = Number(row.seq) + 1;
    const full: ProjectWorkChange = { ...change, at };
    this.statement("UPDATE projects SET seq = ? WHERE project_id = ?").run(seq, projectId);
    this.statement("INSERT INTO events (project_id, project_seq, at, change_json) VALUES (?,?,?,?)").run(projectId, seq, at, JSON.stringify(full));
    // The entity's place in "newest first" is this sequence, not a timestamp:
    // two writes inside the same millisecond still have an exact order.
    this.statement("UPDATE entities SET updated_seq = ? WHERE entity_id = ?").run(seq, change.entityId);
    // Bounded: the oldest events fall off, and a client that asks from before
    // them is told to replace its cache rather than handed a partial history.
    this.statement(
      "DELETE FROM events WHERE project_id = ? AND project_seq <= ?",
    ).run(projectId, seq - this.eventsRetained);
    this.pending.push({ projectId, seq, change: full });
    return seq;
  }

  /** The project's current event sequence number. */
  seq(projectId: string): number {
    const row = this.statement("SELECT seq FROM projects WHERE project_id = ?").get(projectId) as { seq: number } | undefined;
    return Number(row?.seq ?? 0);
  }

  /** Events after `sinceSeq`, oldest first, with whether history was lost. */
  eventsSince(projectId: string, sinceSeq: number): { events: Array<{ seq: number; change: ProjectWorkChange }>; reset: boolean } {
    const oldest = this.statement("SELECT MIN(project_seq) AS n FROM events WHERE project_id = ?").get(projectId) as { n: number | null };
    const reset = oldest.n !== null && sinceSeq > 0 && sinceSeq < Number(oldest.n) - 1;
    const rows = this.statement("SELECT project_seq, change_json FROM events WHERE project_id = ? AND project_seq > ? ORDER BY project_seq ASC").all(
      projectId,
      sinceSeq,
    ) as Array<{ project_seq: number; change_json: string }>;
    return {
      events: rows.map((row) => ({ seq: Number(row.project_seq), change: JSON.parse(row.change_json) as ProjectWorkChange })),
      reset,
    };
  }

  // ---------------------------------------------------------- idempotency

  private replay<T>(projectId: string, method: string, key: string): T | undefined {
    const row = this.statement("SELECT result_json FROM idempotency WHERE project_id = ? AND method = ? AND key = ?").get(projectId, method, key) as
      | { result_json: string }
      | undefined;
    return row ? (JSON.parse(row.result_json) as T) : undefined;
  }

  private remember(projectId: string, method: string, key: string, result: unknown): void {
    // A plain `INSERT`, on purpose (storage review M-1). A receipt answers the
    // same key with the same result for ever: `once()` replays an existing one
    // before any work is done, so reaching here twice for one key would be a
    // fault, and the fault should be a constraint failure that rolls the whole
    // transaction back rather than a silent re-price that resets the charge
    // this receipt is already carrying in the counters.
    this.statement("INSERT INTO idempotency (project_id, method, key, result_json, at) VALUES (?,?,?,?,?)").run(
      projectId,
      method,
      key,
      JSON.stringify(result),
      this.now(),
    );
    // A receipt is durable canonical storage and is charged like any other
    // (D-365, A-3). It is charged after the work succeeded and inside the same
    // transaction: if there is no room for it the whole mutation refuses and
    // the key is left free to retry. A receipt is scoped to the project, not
    // to an entity, so it survives an entity's deletion on purpose.
    this.chargeRow("idempotency", projectId, "project_id = ? AND method = ? AND key = ?", [projectId, method, key], true);
  }

  /**
   * Run a mutation once for a given key.
   *
   * The check and the write share the transaction, so two calls that arrive
   * together cannot both write: the second finds the first's result.
   */
  private once<T extends object>(projectId: string, method: string, key: string, work: () => T): T & { replayed?: boolean } {
    return this.write(() => {
      const earlier = this.replay<T>(projectId, method, key);
      if (earlier) return { ...earlier, replayed: true as const };
      const result = work();
      this.remember(projectId, method, key, result);
      return result;
    });
  }

  // --------------------------------------------------------------- lookups

  private entityRow(projectId: string, entityId: string): EntityRow {
    const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as EntityRow | undefined;
    if (!row) throw new ProjectWorkNotFoundError("That item is not in this project — it may have been deleted.");
    return row;
  }

  private entityRowByKey(projectId: string, key: string): EntityRow {
    const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND key = ?").get(projectId, key) as EntityRow | undefined;
    if (!row) throw new ProjectWorkNotFoundError(`${key} is not in this project — it may have been deleted.`);
    return row;
  }

  private revisionRow(projectId: string, revisionId: string): RevisionRow {
    const row = this.statement("SELECT * FROM revisions WHERE project_id = ? AND revision_id = ?").get(projectId, revisionId) as RevisionRow | undefined;
    if (!row) throw new ProjectWorkNotFoundError("That revision is not one this project has.");
    return row;
  }

  private toEntity(row: EntityRow): ProjectWorkEntity {
    return {
      projectId: row.project_id,
      entityId: row.entity_id,
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      keyNumber: Number(row.key_number),
      title: row.title,
      state: row.state as ProjectWorkState,
      currentRevisionId: row.current_revision_id,
      currentDigest: row.current_digest,
      revisionCount: Number(row.revision_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      ...(row.state_before_archive ? { stateBeforeArchive: row.state_before_archive as ProjectWorkState } : {}),
      ...(row.stale_json ? { staleBecause: JSON.parse(row.stale_json) as ProjectWorkStaleCause } : {}),
      blockingComments: Number(row.blocking_comments),
      needsAttention: row.needs_attention === 1,
    };
  }

  private toRevision(row: RevisionRow): ProjectWorkRevision {
    return {
      projectId: row.project_id,
      entityId: row.entity_id,
      revisionId: row.revision_id,
      kind: row.kind as ProjectWorkKind,
      index: Number(row.idx),
      ...(row.parent_revision_id ? { parentRevisionId: row.parent_revision_id } : {}),
      title: row.title,
      digest: row.digest,
      bodyBytes: Number(row.body_bytes),
      createdAt: row.created_at,
      origin: JSON.parse(row.origin_json) as ProjectWorkOrigin,
      state: row.state as ProjectWorkState,
      ...(row.note ? { note: row.note } : {}),
    };
  }

  private refOf(entity: EntityRow, revision?: RevisionRow): ProjectWorkRef {
    return {
      projectId: entity.project_id,
      kind: entity.kind as ProjectWorkKind,
      entityId: entity.entity_id,
      revisionId: revision?.revision_id ?? entity.current_revision_id,
      digest: revision?.digest ?? entity.current_digest,
      label: revision?.title ?? entity.title,
      key: entity.key,
    };
  }

  /** The current reference for one entity, for a mention or an approval. */
  refFor(projectId: string, entityId: string): ProjectWorkRef {
    return this.refOf(this.entityRow(projectId, entityId));
  }

  // ---------------------------------------------------------------- writes

  /**
   * Allocate this project's next key for a kind.
   *
   * Called only from inside a write transaction: the number and the entity
   * that carries it commit together, and the counter is never decremented, so
   * deleting `TASK-44` does not hand `TASK-44` to anything else.
   */
  private nextKey(projectId: string, kind: ProjectWorkKind): { key: string; number: number } {
    const row = this.statement("SELECT next_number FROM key_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind) as
      | { next_number: number }
      | undefined;
    const number = Number(row?.next_number ?? 1);
    this.statement(
      "INSERT INTO key_sequences (project_id, kind, next_number) VALUES (?,?,?) " +
        "ON CONFLICT(project_id, kind) DO UPDATE SET next_number = excluded.next_number",
    ).run(projectId, kind, number + 1);
    return { key: projectWorkKey(kind, number), number };
  }

  /** What the next key of each kind would be, for the Create dialog. */
  peekNextKeys(projectId: string): Record<ProjectWorkKind, string> {
    const out = {} as Record<ProjectWorkKind, string>;
    for (const kind of PROJECT_WORK_KINDS) {
      const row = this.statement("SELECT next_number FROM key_sequences WHERE project_id = ? AND kind = ?").get(projectId, kind) as
        | { next_number: number }
        | undefined;
      out[kind] = projectWorkKey(kind, Number(row?.next_number ?? 1));
    }
    return out;
  }

  private validateBody(kind: ProjectWorkKind, body: ProjectWorkBody): ProjectWorkBody {
    const parsed = projectWorkBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ProjectWorkRefusedError(`That ${kind} could not be saved: ${parsed.error.issues[0]?.message ?? "the content is not valid"}.`);
    }
    if (parsed.data.kind !== kind) {
      throw new ProjectWorkRefusedError("The content does not match the kind of item being saved.");
    }
    // The caller's value, not zod's inference: the schema is strict, so the
    // two carry the same members, and this keeps the declared optionality.
    return body;
  }

  private writeSearchProjection(entity: EntityRow, revisionId: string, body: ProjectWorkBody): void {
    const values = searchableBodyValues(body).join("\n");
    this.statement(
      "INSERT INTO search_projection (entity_id, project_id, revision_id, key, kind, title, values_text) VALUES (?,?,?,?,?,?,?) " +
        "ON CONFLICT(entity_id) DO UPDATE SET revision_id = excluded.revision_id, key = excluded.key, kind = excluded.kind, " +
        "title = excluded.title, values_text = excluded.values_text",
    ).run(entity.entity_id, entity.project_id, revisionId, entity.key, entity.kind, entity.title, values);
  }

  /** Create an entity and its first revision. */
  create(input: {
    projectId: string;
    kind: ProjectWorkKind;
    title: string;
    body: ProjectWorkBody;
    note?: string | undefined;
  } & ProjectWorkWriteOrigin): {
    ref: ProjectWorkRef;
    entity: ProjectWorkEntity;
    revision: ProjectWorkRevision;
    seq: number;
    replayed?: boolean;
    planGraph?: PlanGraphReport;
  } {
    return this.once(input.projectId, "project/work/create", input.idempotencyKey, () => {
      const body = this.validateBody(input.kind, input.body);
      // A plan's task graph is checked before anything is written: nothing
      // downstream should ever have to decide what a cyclic plan means.
      const planGraph = this.requirePlanGraph(input.projectId, body);
      this.requireSharedScopeAuthority(undefined, body, input.origin);
      const { digest, bytes, canonical } = bodyDigest(body);
      const now = this.now();
      const { key, number } = this.nextKey(input.projectId, input.kind);
      const entityId = mintEntityId();
      const revisionId = mintRevisionId();
      const state: ProjectWorkState = "draft";
      this.statement(
        "INSERT INTO revisions (revision_id, project_id, entity_id, kind, idx, parent_revision_id, title, digest, body_bytes, body, created_at, origin_json, state, note) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        revisionId,
        input.projectId,
        entityId,
        input.kind,
        1,
        null,
        input.title,
        digest,
        bytes,
        canonical,
        now,
        JSON.stringify(input.origin),
        state,
        input.note ?? null,
      );
      this.statement(
        "INSERT INTO entities (entity_id, project_id, kind, key, key_number, title, state, current_revision_id, current_digest, revision_count, created_at, updated_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(entityId, input.projectId, input.kind, key, number, input.title, state, revisionId, digest, 1, now, now);
      // The body is charged once, as the `body` column of the revision it was
      // stored in; every other column of the revision and of the entity is
      // charged on top of it (D-365, A-4).
      this.chargeRow("revisions", input.projectId, "revision_id = ?", [revisionId], true);
      this.note(input.projectId, { entities: 1 });
      this.chargeRow("entities", input.projectId, "entity_id = ?", [entityId], true);
      const entityRow = this.entityRow(input.projectId, entityId);
      this.writeSearchProjection(entityRow, revisionId, body);
      const seq = this.raise(input.projectId, {
        change: "created",
        entityId,
        entityKind: input.kind,
        key,
        title: input.title,
        state,
        revisionId,
        digest,
        at: now,
        actorLabel: input.origin.actor.label,
        ...(input.origin.sessionId ? { sessionId: input.origin.sessionId } : {}),
      });
      return {
        ref: this.refOf(entityRow),
        entity: this.toEntity(entityRow),
        revision: this.toRevision(this.revisionRow(input.projectId, revisionId)),
        seq,
        ...(planGraph ? { planGraph } : {}),
      };
    });
  }

  /**
   * Append a child revision.
   *
   * The new revision is written first and the entity's pointer moves in the
   * same transaction, so a reader either sees the old revision or the new one
   * — never an entity pointing at a revision that is not there.
   */
  revise(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    title?: string | undefined;
    body: ProjectWorkBody;
    note?: string | undefined;
  } & ProjectWorkWriteOrigin): {
    ref: ProjectWorkRef;
    entity: ProjectWorkEntity;
    revision: ProjectWorkRevision;
    seq: number;
    replayed?: boolean;
    planGraph?: PlanGraphReport;
  } {
    return this.once(input.projectId, "project/work/revise", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      const body = this.validateBody(entity.kind as ProjectWorkKind, input.body);
      // The graph a revision asks for, checked against this project; a task
      // this plan stopped listing is recorded as an orphan, not refused.
      const planGraph = this.requirePlanGraph(input.projectId, body, entity.key);
      const previous = JSON.parse(this.revisionRow(input.projectId, entity.current_revision_id).body) as ProjectWorkBody;
      this.requireSharedScopeAuthority(previous.kind === "task" ? previous.task : undefined, body, input.origin);
      const { digest, bytes, canonical } = bodyDigest(body);
      const now = this.now();
      const revisionId = mintRevisionId();
      const title = input.title ?? entity.title;
      const priorState = entity.state as ProjectWorkState;
      // A revision of a settled artifact returns it to draft: approving a
      // document never approves its successor.
      const state: ProjectWorkState =
        entity.kind === "task" ? priorState : priorState === "archived" ? "archived" : "draft";
      this.statement(
        "INSERT INTO revisions (revision_id, project_id, entity_id, kind, idx, parent_revision_id, title, digest, body_bytes, body, created_at, origin_json, state, note) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        revisionId,
        input.projectId,
        entity.entity_id,
        entity.kind,
        Number(entity.revision_count) + 1,
        entity.current_revision_id,
        title,
        digest,
        bytes,
        canonical,
        now,
        JSON.stringify(input.origin),
        state,
        input.note ?? null,
      );
      this.statement(
        "UPDATE entities SET current_revision_id = ?, current_digest = ?, revision_count = revision_count + 1, title = ?, state = ?, updated_at = ?, stale_json = NULL WHERE entity_id = ?",
      ).run(revisionId, digest, title, state, now, entity.entity_id);
      this.chargeRow("revisions", input.projectId, "revision_id = ?", [revisionId], true);
      // A title change makes the entity row cost more or less than it did:
      // an update is re-priced, never left at what it was first charged.
      this.touchEntity(input.projectId, entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      this.writeSearchProjection(updated, revisionId, body);
      const seq = this.raise(input.projectId, {
        change: "revised",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title,
        state,
        revisionId,
        digest,
        at: now,
        actorLabel: input.origin.actor.label,
        ...(input.origin.sessionId ? { sessionId: input.origin.sessionId } : {}),
      });
      // A material change to an approved artifact stales what depends on it,
      // along the links that exist and no further (D-352).
      const reached = this.applyStale(input.projectId, entity.entity_id, priorState, now);
      // An anchor is preserved, never lost: a comment whose target survived
      // this revision stays on it, one whose target went is orphaned (M21-T8).
      this.refreshAnchors(input.projectId, entity.entity_id, revisionId);
      // A material change invalidates the gate it was approved at, and only
      // the downstream the change actually reaches (D-332).
      this.invalidateApprovals(input.projectId, entity.entity_id, { previousDigest: entity.current_digest, digest, reached }, now);
      // A revision can change what this Task depends on, and an artifact
      // leaving `approved` can unsatisfy the Tasks that named it.
      this.applyCascade(
        input.projectId,
        entity.kind === "task" ? { entityIds: [entity.entity_id] } : { keys: [entity.key] },
        now,
      );
      return {
        ref: this.refOf(updated),
        entity: this.toEntity(updated),
        revision: this.toRevision(this.revisionRow(input.projectId, revisionId)),
        seq,
        ...(planGraph ? { planGraph } : {}),
      };
    });
  }

  private requireCurrent(entity: EntityRow, expectedRevisionId: string): void {
    if (entity.current_revision_id === expectedRevisionId) return;
    throw new ProjectWorkConflictError(this.refOf(entity), expectedRevisionId);
  }

  /** Archive or restore. Reversible, and every link is kept. */
  archive(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    archived: boolean;
  } & ProjectWorkWriteOrigin): { entity: ProjectWorkEntity; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/archive", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      const now = this.now();
      const isTask = entity.kind === "task";
      if (input.archived) {
        if (!isTask) {
          const move = artifactTransition({
            kind: entity.kind as ProjectWorkKind,
            from: entity.state as ArtifactReviewState,
            to: "archived",
            trigger: input.origin.actor.kind,
          });
          if (!move.ok) throw new ProjectWorkRefusedError(move.reason);
        }
        this.statement("UPDATE entities SET archived_at = ?, state_before_archive = ?, state = ?, updated_at = ? WHERE entity_id = ?").run(
          now,
          entity.state,
          isTask ? entity.state : "archived",
          now,
          entity.entity_id,
        );
      } else {
        const restored = entity.state_before_archive ?? (isTask ? "draft" : "draft");
        this.statement("UPDATE entities SET archived_at = NULL, state_before_archive = NULL, state = ?, updated_at = ? WHERE entity_id = ?").run(
          restored,
          now,
          entity.entity_id,
        );
      }
      // Archiving hides an item and keeps every byte of its history: this
      // re-prices the row it changed and frees nothing else, on purpose.
      this.touchEntity(input.projectId, entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "archived",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      return { entity: this.toEntity(updated), seq };
    });
  }

  /** What deleting this would orphan, by key: the typed confirmation's list. */
  deletePreview(projectId: string, entityId: string): Array<{ key: string; kind: ProjectWorkKind; relation: string }> {
    const entity = this.entityRow(projectId, entityId);
    const rows = this.statement(
      `SELECT e.key AS key, e.kind AS kind, edges.relation AS relation FROM edges
         JOIN entities e ON e.entity_id = CASE WHEN edges.subject_entity = ? THEN edges.object_entity ELSE edges.subject_entity END
        WHERE edges.project_id = ? AND (edges.subject_entity = ? OR edges.object_entity = ?)`,
    ).all(entity.entity_id, projectId, entity.entity_id, entity.entity_id) as Array<{ key: string; kind: string; relation: string }>;
    return rows.map((row) => ({ key: row.key, kind: row.kind as ProjectWorkKind, relation: row.relation }));
  }

  /**
   * Permanent deletion. Everything that belonged to the entity goes with it;
   * its key number is not returned to the sequence, so no later item can be
   * mistaken for it.
   */
  delete(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
  } & ProjectWorkWriteOrigin): { deleted: boolean; orphans: Array<{ key: string; kind: ProjectWorkKind; relation: string }>; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/delete", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      const orphans = this.deletePreview(input.projectId, input.entityId);
      // An explicit deletion takes this item's own history with it. What it
      // may never do is amputate somebody else's record: if a surviving
      // decision on another item was made on this item's link, capture or
      // blob, the deletion is refused rather than silently dropping that
      // binding or leaving it pointing at proof nobody can read (D-365, A-2).
      const consumed = this.proofConsumedElsewhere(input.projectId, entity.entity_id);
      if (consumed) throw new ProjectWorkRefusedError(consumed);
      const now = this.now();
      const links = this.statement("SELECT link_id FROM repository_links WHERE project_id = ? AND entity_id = ?").all(
        input.projectId,
        entity.entity_id,
      ) as Array<{ link_id: string }>;
      // Credit exactly what each row was charged, from the charge stored on
      // it, before the row that carries that number is gone.
      this.creditRows("blobs", input.projectId, "project_id = ? AND entity_id = ?", [input.projectId, entity.entity_id]);
      const blobs = this.statement("SELECT blob_id FROM blobs WHERE project_id = ? AND entity_id = ?").all(input.projectId, entity.entity_id) as Array<{
        blob_id: string;
      }>;
      for (const blob of blobs) deleteBlob(this.db, input.projectId, blob.blob_id);
      // `revisions` is reached by its own `(entity_id, idx)` index; the rest
      // by their `(project_id, entity_id)` one. The credit and the delete
      // share the predicate, so they can never disagree about which rows went.
      this.creditRows("revisions", input.projectId, "entity_id = ?", [entity.entity_id]);
      this.statement("DELETE FROM revisions WHERE entity_id = ?").run(entity.entity_id);
      for (const table of ["comments", "approvals", "decisions", "evidence", "execution_links", "repository_links"] as const) {
        this.creditRows(table, input.projectId, "project_id = ? AND entity_id = ?", [input.projectId, entity.entity_id]);
        this.statement(`DELETE FROM ${table} WHERE project_id = ? AND entity_id = ?`).run(input.projectId, entity.entity_id);
      }
      this.creditRows("edges", input.projectId, "subject_entity = ? OR object_entity = ?", [entity.entity_id, entity.entity_id]);
      this.statement("DELETE FROM edges WHERE subject_entity = ? OR object_entity = ?").run(entity.entity_id, entity.entity_id);
      // The capture history of the links that just went, and the proof
      // bindings of this entity's own decisions. Both key on the project, not
      // on the entity, so without this they would stay unreachable — and, now
      // that they are charged, unreachable *and* charged for ever.
      for (const link of links) {
        this.creditRows("repository_link_captures", input.projectId, "project_id = ? AND link_id = ?", [input.projectId, link.link_id]);
        this.statement("DELETE FROM repository_link_captures WHERE project_id = ? AND link_id = ?").run(input.projectId, link.link_id);
      }
      this.creditRows("decision_capture_bindings", input.projectId, "project_id = ? AND entity_id = ?", [input.projectId, entity.entity_id]);
      this.statement("DELETE FROM decision_capture_bindings WHERE project_id = ? AND entity_id = ?").run(input.projectId, entity.entity_id);
      this.creditRows("decision_capture_binding_sets", input.projectId, "project_id = ? AND entity_id = ?", [input.projectId, entity.entity_id]);
      this.statement("DELETE FROM decision_capture_binding_sets WHERE project_id = ? AND entity_id = ?").run(input.projectId, entity.entity_id);
      this.statement("DELETE FROM search_projection WHERE entity_id = ?").run(entity.entity_id);
      this.creditRows("entities", input.projectId, "entity_id = ?", [entity.entity_id]);
      this.statement("DELETE FROM entities WHERE entity_id = ?").run(entity.entity_id);
      this.note(input.projectId, { entities: -1 });
      const seq = this.raise(input.projectId, {
        change: "deleted",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: entity.title,
        state: entity.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      return { deleted: true, orphans, seq };
    });
  }

  /**
   * Would deleting this entity destroy proof a **surviving other** item's
   * record rests on? (D-365, A-2; M21-T2 corrections, item 4)
   *
   * Explicit deletion is a person's act and it is allowed to take this item's
   * own captures, bindings and links with it. It is not allowed to make
   * another item's record unreadable. Every way one item's record can name
   * another item's proof is checked here, and each of them is a reference a
   * person really can create:
   *
   * - a decision elsewhere that **bound** one of these links or blobs (D-363);
   * - evidence elsewhere that names one of these links, or whose attachment
   *   **is** one of these blobs — evidence takes a `blobId` without requiring
   *   that the blob belongs to the same item;
   * - another link's **current** capture pointer;
   * - a Native acceptance elsewhere, which binds the exact capture it was
   *   confirmed against and keeps naming it after the pointer moves on;
   * - an **older** association in another link's capture history: append-only
   *   provenance (D-363) is read by every decision taken before the pointer
   *   was corrected, including a legacy acceptance that names no capture of
   *   its own and whose proof is therefore the link's first association.
   *
   * The refusal names the dependent item by key and tells the truth about
   * recovery: none of these references can be superseded, recaptured or
   * rewritten away, because they are that item's own immutable history. The
   * two honest ways forward are keeping this item, or deleting the dependent
   * work explicitly as well. Nothing here deletes or rewrites another item's
   * history on a person's behalf.
   *
   * Bounded: one statement per relationship, each an indexed lookup against
   * this entity's own links and blobs, each returning at most one key.
   */
  private proofConsumedElsewhere(projectId: string, entityId: string): string | undefined {
    const ourLinks = "SELECT link_id FROM repository_links WHERE project_id = ? AND entity_id = ?";
    const ourBlobs = "SELECT blob_id FROM blobs WHERE project_id = ? AND entity_id = ?";
    const first = (sql: string): { key: string; kind?: string } | undefined =>
      this.statement(sql).get(projectId, entityId, projectId, entityId) as { key: string; kind?: string } | undefined;

    // The most exact answer first: a decision recorded what it was decided on.
    const bound =
      first(
        "SELECT e.key AS key, b.decision_kind AS kind FROM decision_capture_bindings b JOIN entities e ON e.entity_id = b.entity_id " +
          `WHERE b.project_id = ? AND b.entity_id <> ? AND b.link_id IN (${ourLinks}) ORDER BY e.key LIMIT 1`,
      ) ??
      first(
        "SELECT e.key AS key, b.decision_kind AS kind FROM decision_capture_bindings b JOIN entities e ON e.entity_id = b.entity_id " +
          `WHERE b.project_id = ? AND b.entity_id <> ? AND b.blob_id IN (${ourBlobs}) ORDER BY e.key LIMIT 1`,
      );
    if (bound) {
      return dependentProofRefusal(bound.key, `${bound.kind === "approval" ? "approval" : "completion"} was decided on evidence this item holds`);
    }
    const namesLink = first(
      "SELECT e.key AS key FROM evidence v JOIN entities e ON e.entity_id = v.entity_id " +
        `WHERE v.project_id = ? AND v.entity_id <> ? AND v.repository_link_id IN (${ourLinks}) ORDER BY e.key LIMIT 1`,
    );
    if (namesLink) return dependentProofRefusal(namesLink.key, "evidence points at a repository record this item holds");
    const namesBlob = first(
      "SELECT e.key AS key FROM evidence v JOIN entities e ON e.entity_id = v.entity_id " +
        `WHERE v.project_id = ? AND v.entity_id <> ? AND v.blob_id IN (${ourBlobs}) ORDER BY e.key LIMIT 1`,
    );
    if (namesBlob) return dependentProofRefusal(namesBlob.key, "evidence is kept as a capture this item holds");
    const provedNow = first(
      "SELECT e.key AS key FROM repository_links l JOIN entities e ON e.entity_id = l.entity_id " +
        `WHERE l.project_id = ? AND l.entity_id <> ? AND l.capture_blob_id IN (${ourBlobs}) ORDER BY e.key LIMIT 1`,
    );
    if (provedNow) return dependentProofRefusal(provedNow.key, "repository record is proved by a capture this item holds");
    const accepted = first(
      "SELECT e.key AS key FROM repository_links l JOIN entities e ON e.entity_id = l.entity_id " +
        "WHERE l.project_id = ? AND l.entity_id <> ? AND l.acceptance_json IS NOT NULL " +
        `AND json_extract(l.acceptance_json, '$.captureBlobId') IN (${ourBlobs}) ORDER BY e.key LIMIT 1`,
    );
    if (accepted) return dependentProofRefusal(accepted.key, "accepted state was confirmed against a capture this item holds");
    // Last, the history behind another link's pointer: an association this
    // item's capture is named by is what every decision taken before a later
    // correction was read against, and it is never rewritten.
    const inHistory = first(
      "SELECT e.key AS key FROM repository_link_captures c JOIN repository_links l ON l.link_id = c.link_id " +
        "JOIN entities e ON e.entity_id = l.entity_id " +
        `WHERE c.project_id = ? AND l.entity_id <> ? AND c.blob_id IN (${ourBlobs}) ORDER BY e.key LIMIT 1`,
    );
    if (inHistory) return dependentProofRefusal(inHistory.key, "capture history records a capture this item holds");
    return undefined;
  }

  // --------------------------------------------------------------- review

  comment(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    revisionId: string;
    anchor: ProjectWorkAnchor;
    text: string;
    blocking?: boolean | undefined;
    parentCommentId?: string | undefined;
  } & ProjectWorkWriteOrigin): { comment: ProjectWorkComment; entity: ProjectWorkEntity; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/comment", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      // The comment may anchor to an older revision — that is how review of a
      // superseded revision keeps working — but it must be one of this
      // entity's own.
      const anchored = this.revisionRow(input.projectId, input.revisionId);
      if (anchored.entity_id !== entity.entity_id) {
        throw new ProjectWorkRefusedError("That revision belongs to another item.");
      }
      if (input.parentCommentId !== undefined) {
        const parent = this.readComment(input.projectId, input.parentCommentId);
        if (parent.entityId !== entity.entity_id) throw new ProjectWorkRefusedError("That comment belongs to another item.");
      }
      const now = this.now();
      const commentId = mintCommentId();
      const blocking = input.blocking === true;
      // An anchor that does not resolve in the *current* revision is kept and
      // marked orphaned rather than refused: a person reviewing an older
      // revision is still saying something real, and a lost anchor must never
      // lose the comment with it (leap, "Design contract").
      const orphaned = !this.anchorStillResolves(input.projectId, entity.current_revision_id, input.anchor);
      this.statement(
        "INSERT INTO comments (comment_id, project_id, entity_id, revision_id, anchor_json, text, state, blocking, created_at, origin_json, orphaned, parent_comment_id) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        commentId,
        input.projectId,
        entity.entity_id,
        input.revisionId,
        JSON.stringify(input.anchor),
        input.text,
        "open",
        blocking ? 1 : 0,
        now,
        JSON.stringify(input.origin),
        orphaned ? 1 : 0,
        input.parentCommentId ?? null,
      );
      // Review is canonical history the leap puts inside the budget: the text,
      // its anchor and who said it are charged like any other stored row.
      this.chargeRow("comments", input.projectId, "comment_id = ?", [commentId], true);
      if (blocking) {
        this.statement("UPDATE entities SET blocking_comments = blocking_comments + 1, needs_attention = 1, updated_at = ? WHERE entity_id = ?").run(
          now,
          entity.entity_id,
        );
      } else {
        this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, entity.entity_id);
      }
      this.touchEntity(input.projectId, entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "comment",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        revisionId: input.revisionId,
        at: now,
        actorLabel: input.origin.actor.label,
        ...(input.origin.sessionId ? { sessionId: input.origin.sessionId } : {}),
      });
      // A blocking comment is something waiting on a person, here and on the
      // gate it stops (M21-T8).
      this.refreshGateAttention(input.projectId, entity.entity_id, now);
      return { comment: this.readComment(input.projectId, commentId), entity: this.toEntity(updated), seq };
    });
  }

  private readComment(projectId: string, commentId: string): ProjectWorkComment {
    const row = this.statement("SELECT * FROM comments WHERE project_id = ? AND comment_id = ?").get(projectId, commentId) as
      | {
          comment_id: string;
          project_id: string;
          entity_id: string;
          revision_id: string;
          anchor_json: string;
          text: string;
          state: string;
          blocking: number;
          created_at: string;
          origin_json: string;
          addressed_at: string | null;
          resolved_at: string | null;
          orphaned: number;
          parent_comment_id: string | null;
        }
      | undefined;
    if (!row) throw new ProjectWorkNotFoundError("That comment is no longer here.");
    return {
      projectId: row.project_id,
      commentId: row.comment_id,
      entityId: row.entity_id,
      revisionId: row.revision_id,
      anchor: JSON.parse(row.anchor_json) as ProjectWorkComment["anchor"],
      text: row.text,
      state: row.state as ProjectWorkComment["state"],
      blocking: row.blocking === 1,
      createdAt: row.created_at,
      origin: JSON.parse(row.origin_json) as ProjectWorkOrigin,
      ...(row.addressed_at ? { addressedAt: row.addressed_at } : {}),
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      ...(row.orphaned === 1 ? { orphaned: true } : {}),
      ...(row.parent_comment_id ? { parentCommentId: row.parent_comment_id } : {}),
    };
  }

  /**
   * Move a comment along its lifecycle.
   *
   * An agent may mark a comment **addressed**; only a person resolves one or
   * reopens it (D-332). A resolved blocking comment stops blocking; reopening
   * makes it block again.
   */
  resolveComment(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    commentId: string;
    resolution: "addressed" | "resolved" | "reopened";
  } & ProjectWorkWriteOrigin): { comment: ProjectWorkComment; entity: ProjectWorkEntity; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/resolve-comment", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      const comment = this.readComment(input.projectId, input.commentId);
      if (comment.entityId !== entity.entity_id) throw new ProjectWorkRefusedError("That comment belongs to another item.");
      const move = commentResolutionAllowed({ resolution: input.resolution, actor: input.origin.actor.kind, from: comment.state });
      if (!move.ok) throw new ProjectWorkRefusedError(move.reason);
      const now = this.now();
      if (input.resolution === "addressed") {
        this.statement("UPDATE comments SET state = 'addressed', addressed_at = ? WHERE comment_id = ?").run(now, input.commentId);
      } else if (input.resolution === "resolved") {
        this.statement("UPDATE comments SET state = 'resolved', resolved_at = ? WHERE comment_id = ?").run(now, input.commentId);
        if (comment.blocking && comment.state !== "resolved") {
          this.statement("UPDATE entities SET blocking_comments = MAX(0, blocking_comments - 1) WHERE entity_id = ?").run(entity.entity_id);
        }
      } else {
        this.statement("UPDATE comments SET state = 'open', resolved_at = NULL, addressed_at = NULL WHERE comment_id = ?").run(input.commentId);
        if (comment.blocking && comment.state === "resolved") {
          this.statement("UPDATE entities SET blocking_comments = blocking_comments + 1 WHERE entity_id = ?").run(entity.entity_id);
        }
      }
      this.refreshAttention(entity.entity_id);
      this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, entity.entity_id);
      this.chargeRow("comments", input.projectId, "comment_id = ?", [input.commentId]);
      this.touchEntity(input.projectId, entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "comment",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      // Resolving the last blocking comment can make a gate decidable, which
      // is a change to what is waiting on a person.
      this.refreshGateAttention(input.projectId, entity.entity_id, now);
      return { comment: this.readComment(input.projectId, input.commentId), entity: this.toEntity(updated), seq };
    });
  }

  private refreshAttention(entityId: string): void {
    this.statement(
      "UPDATE entities SET needs_attention = CASE WHEN blocking_comments > 0 OR state = 'needs_review' OR state = 'stale' OR state = 'blocked' THEN 1 ELSE 0 END WHERE entity_id = ?",
    ).run(entityId);
  }

  /**
   * Does this anchor still point at something in that revision? (M21-T8)
   *
   * A text range also has to still say what it said: the hash is over the
   * exact slice, so an edit inside the quoted words orphans the comment
   * instead of silently moving it onto different text.
   */
  private anchorStillResolves(projectId: string, revisionId: string, anchor: ProjectWorkAnchor): boolean {
    const row = this.statement("SELECT body FROM revisions WHERE project_id = ? AND revision_id = ?").get(projectId, revisionId) as
      | { body: string }
      | undefined;
    if (!row) return false;
    return anchorResolves(JSON.parse(row.body) as ProjectWorkBody, anchor, (value) => sha256(value));
  }

  /**
   * Re-decide which of an entity's comments are orphaned, after a revision.
   *
   * Nothing is deleted and nothing moves: a comment whose target came back
   * stops being orphaned, and one whose target went is marked and stays
   * exactly where a person left it. Returns how many changed, so a caller can
   * say so.
   */
  private refreshAnchors(projectId: string, entityId: string, revisionId: string): number {
    const rows = this.statement("SELECT comment_id, anchor_json, orphaned FROM comments WHERE project_id = ? AND entity_id = ?").all(
      projectId,
      entityId,
    ) as Array<{ comment_id: string; anchor_json: string; orphaned: number }>;
    if (rows.length === 0) return 0;
    const bodyRow = this.statement("SELECT body FROM revisions WHERE project_id = ? AND revision_id = ?").get(projectId, revisionId) as
      | { body: string }
      | undefined;
    if (!bodyRow) return 0;
    const body = JSON.parse(bodyRow.body) as ProjectWorkBody;
    let changed = 0;
    for (const row of rows) {
      const anchor = JSON.parse(row.anchor_json) as ProjectWorkAnchor;
      const orphaned = anchorResolves(body, anchor, (value) => sha256(value)) ? 0 : 1;
      if (orphaned === row.orphaned) continue;
      this.statement("UPDATE comments SET orphaned = ? WHERE comment_id = ?").run(orphaned, row.comment_id);
      changed += 1;
    }
    return changed;
  }

  /**
   * Keep "needs you" honest about gates (M21-T8).
   *
   * An artifact on the gated path joins the queue when its gate is ready to
   * decide or has been invalidated, and leaves it when the gate is settled and
   * nothing else is waiting. Bounded on purpose: the entity itself, its Spec
   * and that Spec's linked Design and Plan — never a walk of the project.
   */
  private refreshGateAttention(projectId: string, entityId: string, at: string): void {
    const reader = this.gateReader();
    const entity = reader.entity(projectId, entityId);
    if (!entity) return;
    const spec = this.gates.specFor(projectId, entity);
    if (!spec) return;
    const report = this.gates.report(projectId, spec);
    if (!report) return;
    const subjects = new Map<string, boolean>();
    subjects.set(spec.entityId, false);
    for (const gate of report.gates) {
      if (!gate.subject) continue;
      const waiting = report.gated && (gate.state === "ready" || gate.state === "invalidated" || gate.blockingComments.length > 0);
      subjects.set(gate.subject.entityId, (subjects.get(gate.subject.entityId) ?? false) || waiting);
    }
    for (const [subjectId, waiting] of subjects) {
      const row = this.statement("SELECT needs_attention FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, subjectId) as
        | { needs_attention: number }
        | undefined;
      if (!row) continue;
      if (!waiting) {
        // Back to the ordinary rule: a blocking comment, a review, a stale
        // input or a blocked task — and nothing else — keeps it in the queue.
        this.refreshAttention(subjectId);
        continue;
      }
      if (row.needs_attention === 1) continue;
      this.statement("UPDATE entities SET needs_attention = 1, updated_at = ? WHERE entity_id = ?").run(at, subjectId);
      this.touchEntity(projectId, subjectId);
    }
  }

  /** The review actions that are not approvals. */
  review(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    action: ProjectWorkReviewAction;
    supersededByEntityId?: string | undefined;
    note?: string | undefined;
  } & ProjectWorkWriteOrigin): { entity: ProjectWorkEntity; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/review", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      if (entity.kind === "task") {
        throw new ProjectWorkRefusedError("A task moves through its own states. Use a task action.");
      }
      const from = entity.state as ArtifactReviewState;
      const to: ArtifactReviewState =
        input.action === "request_review"
          ? "needs_review"
          : input.action === "return_to_draft"
            ? "draft"
            : input.action === "supersede"
              ? "superseded"
              : (entity.state_before_archive as ArtifactReviewState | null) ?? "draft";
      const move = artifactTransition({
        kind: entity.kind as ProjectWorkKind,
        from,
        to,
        trigger: input.origin.actor.kind,
        blockingComments: Number(entity.blocking_comments),
        ...(input.action === "restore" ? { restore: true } : {}),
      });
      if (!move.ok) throw new ProjectWorkRefusedError(move.reason);
      const now = this.now();
      this.statement("UPDATE entities SET state = ?, updated_at = ?, archived_at = NULL, state_before_archive = NULL WHERE entity_id = ?").run(
        to,
        now,
        entity.entity_id,
      );
      this.touchEntity(input.projectId, entity.entity_id);
      this.refreshAttention(entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "state",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        revisionId: entity.current_revision_id,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      // A review that leaves `approved` can unsatisfy the Tasks that named it.
      this.applyCascade(input.projectId, { keys: [entity.key] }, now);
      return { entity: this.toEntity(updated), seq };
    });
  }

  /** A gate decision, binding the exact revision set it covers (D-332). */
  approve(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    gate: ApprovalGate;
    decision: ApprovalDecision;
    covers: ApprovedRevision[];
    mode?: ApprovalMode | undefined;
    skipReason?: string | undefined;
    note?: string | undefined;
    /**
     * The captures the gate prepared this approval on (D-363). Present
     * whenever the preparation ran, including when it found nothing to keep,
     * and bound inside this transaction or the approval does not happen.
     */
    proof?: DecisionProofPreparation | undefined;
  } & ProjectWorkWriteOrigin): { approval: ProjectWorkApproval; entity: ProjectWorkEntity; seq: number; replayed?: boolean } {
    return this.once(input.projectId, "project/work/approve", input.idempotencyKey, () => {
      // The gate stored its capture in an earlier transaction, so a refusal
      // here must not claim that nothing was kept: the evidence is still
      // readable and it is the decision that did not happen.
      if (input.proof) this.prepared = preparedDecision(input.proof.gate);
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      // Every revision the decision covers must be exactly what the store has:
      // approving a digest that has moved would approve something unread.
      for (const covered of input.covers) {
        const revision = this.revisionRow(input.projectId, covered.revisionId);
        if (revision.entity_id !== covered.entityId || revision.digest !== covered.digest) {
          throw new ProjectWorkRefusedError(`${covered.key} changed since this was prepared. Open it again before approving.`);
        }
      }
      // Who may decide comes before what the decision needs: an agent asking
      // to approve is told it may not, whatever else is outstanding (D-332).
      if (input.decision === "approved" && input.origin.actor.kind !== "person") {
        throw new ProjectWorkRefusedError("Only a person approves project work.");
      }
      // The gate's own rules: the right subject, the complete digest set, the
      // prerequisites, and no open blocking comment anywhere it covers
      // (M21-T8, D-332).
      const subject = this.gateReader().entity(input.projectId, entity.entity_id);
      if (!subject) throw new ProjectWorkNotFoundError("That item is not in this project — it may have been deleted.");
      const gate = this.gates.check(input.projectId, subject, {
        gate: input.gate,
        decision: input.decision,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        covers: input.covers,
        ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
      });
      if (!gate.ok) throw new ProjectWorkRefusedError(gate.reason);
      const to: ArtifactReviewState =
        input.decision === "approved" ? "approved" : input.decision === "changes_requested" ? "draft" : "archived";
      const sketchOnly = entity.kind === "design" ? this.isSketchOnlyDesign(input.projectId, entity.current_revision_id) : false;
      const move = artifactTransition({
        kind: entity.kind as ProjectWorkKind,
        from: entity.state as ArtifactReviewState,
        to,
        trigger: input.origin.actor.kind,
        blockingComments: Number(entity.blocking_comments),
        sketchOnly,
      });
      if (!move.ok) throw new ProjectWorkRefusedError(move.reason);
      const now = this.now();
      const approvalId = mintApprovalId();
      this.statement(
        "INSERT INTO approvals (approval_id, project_id, entity_id, gate, decision, covers_json, mode, skip_reason, note, at, origin_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        approvalId,
        input.projectId,
        entity.entity_id,
        input.gate,
        input.decision,
        JSON.stringify(input.covers),
        input.mode ?? null,
        input.skipReason ?? null,
        input.note ?? null,
        now,
        JSON.stringify(input.origin),
      );
      this.chargeRow("approvals", input.projectId, "approval_id = ?", [approvalId], true);
      // The proof this approval consumed, bound to this approval's own id
      // before anything else in the transaction can succeed. A capture that
      // moved since the gate read it refuses here, and the approval row above
      // rolls back with the binding (D-363).
      if (input.proof) {
        this.bindDecisionProof({
          projectId: input.projectId,
          kind: "approval",
          decisionId: approvalId,
          entityId: entity.entity_id,
          proof: input.proof,
          at: now,
        });
      }
      this.statement("UPDATE entities SET state = ?, updated_at = ?, stale_json = NULL WHERE entity_id = ?").run(to, now, entity.entity_id);
      this.touchEntity(input.projectId, entity.entity_id);
      this.refreshAttention(entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "approval",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        revisionId: entity.current_revision_id,
        digest: entity.current_digest,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      // An approval can satisfy a dependency, and a change request can take
      // one away: the Tasks that named this artifact are recomputed either
      // way, after the approval itself is on the stream.
      this.applyCascade(input.projectId, { keys: [entity.key] }, now);
      // A settled gate stops waiting on a person; the next one may start.
      this.refreshGateAttention(input.projectId, entity.entity_id, now);
      return { approval: this.readApproval(input.projectId, approvalId), entity: this.toEntity(updated), seq };
    });
  }

  private isSketchOnlyDesign(projectId: string, revisionId: string): boolean {
    const revision = this.revisionRow(projectId, revisionId);
    const body = JSON.parse(revision.body) as ProjectWorkBody;
    return body.kind === "design" ? designIsSketchOnly(body.design) : false;
  }

  private readApproval(projectId: string, approvalId: string): ProjectWorkApproval {
    const row = this.statement("SELECT * FROM approvals WHERE project_id = ? AND approval_id = ?").get(projectId, approvalId) as
      | {
          approval_id: string;
          project_id: string;
          entity_id: string;
          gate: string;
          decision: string;
          covers_json: string;
          mode: string | null;
          skip_reason: string | null;
          note: string | null;
          at: string;
          origin_json: string;
          invalidated_at: string | null;
        }
      | undefined;
    if (!row) throw new ProjectWorkNotFoundError("That approval is no longer here.");
    return {
      projectId: row.project_id,
      approvalId: row.approval_id,
      entityId: row.entity_id,
      gate: row.gate as ApprovalGate,
      decision: row.decision as ApprovalDecision,
      covers: JSON.parse(row.covers_json) as ApprovedRevision[],
      ...(row.mode ? { mode: row.mode as ApprovalMode } : {}),
      ...(row.skip_reason ? { skipReason: row.skip_reason } : {}),
      ...(row.note ? { note: row.note } : {}),
      at: row.at,
      origin: JSON.parse(row.origin_json) as ProjectWorkOrigin,
      ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {}),
    };
  }

  // ---------------------------------------------------------------- links

  link(
    input: {
      projectId: string;
      expectedRevisionId: string;
      link: ProjectWorkLinkInput;
      /** The capture the caller stored for a delivery, before it is accepted. */
      capture?: { blobId: string; bytes: number; files: number; sources: number; truncated?: string } | undefined;
      /**
       * What the host proved about a `verified_at` state before this write
       * (M21-T19, D-361): the capture it stored, and the acceptance record it
       * confirmed. Both are the host's own; a request body reaches neither.
       */
      verified?:
        | {
            captureBlobId?: string | undefined;
            acceptance?: RepositoryLinkAcceptance | undefined;
            /** The attempt the host tied this state to, re-derived by it. */
            executionLinkId?: string | undefined;
            /**
             * The gate that took that capture, in its own words, so a refusal
             * here says which preparation is still readable (review H-1).
             */
            gate?: string | undefined;
          }
        | undefined;
    } & ProjectWorkWriteOrigin,
  ): {
    link: ProjectWorkLinkRecord;
    seq: number;
    replayed?: boolean;
  } {
    return this.once(input.projectId, "project/work/link", input.idempotencyKey, () => {
      const now = this.now();
      const linkId = mintLinkId();
      const payload = input.link;
      // What was already stored for this link before this transaction opened,
      // so a refusal for space says what is still readable (review H-1).
      this.prepared = this.preparedForLink(input, payload);
      if (payload.type === "delivery") return this.acceptDelivery(input, payload, now);
      const anchorEntityId =
        payload.type === "edge" ? payload.subject.entityId : payload.type === "repository" ? payload.subjectEntityId : payload.entityId;
      const entity = this.entityRow(input.projectId, anchorEntityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      let record: ProjectWorkLinkRecord;
      if (payload.type === "edge") {
        const subject = this.entityRow(input.projectId, payload.subject.entityId);
        const object = this.entityRow(input.projectId, payload.object.entityId);
        if (subject.entity_id === object.entity_id) throw new ProjectWorkRefusedError("An item cannot be linked to itself.");
        this.revisionRow(input.projectId, payload.subject.revisionId);
        this.revisionRow(input.projectId, payload.object.revisionId);
        this.statement(
          "INSERT INTO edges (link_id, project_id, relation, subject_entity, subject_revision, object_entity, object_revision, created_at, origin_json, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          linkId,
          input.projectId,
          payload.relation,
          subject.entity_id,
          payload.subject.revisionId,
          object.entity_id,
          payload.object.revisionId,
          now,
          JSON.stringify(input.origin),
          payload.note ?? null,
        );
        this.chargeRow("edges", input.projectId, "link_id = ?", [linkId], true);
        record = {
          type: "edge",
          edge: {
            projectId: input.projectId,
            linkId,
            relation: payload.relation,
            subject: {
              entityId: subject.entity_id,
              revisionId: payload.subject.revisionId,
              kind: subject.kind as ProjectWorkKind,
              key: subject.key,
            },
            object: { entityId: object.entity_id, revisionId: payload.object.revisionId, kind: object.kind as ProjectWorkKind, key: object.key },
            createdAt: now,
            origin: input.origin,
            ...(payload.note ? { note: payload.note } : {}),
          },
        };
      } else if (payload.type === "repository") {
        const revision = this.revisionRow(input.projectId, payload.subjectRevisionId);
        if (revision.entity_id !== entity.entity_id) throw new ProjectWorkRefusedError("That revision belongs to another item.");
        const known = this.statement("SELECT 1 AS present FROM repositories WHERE project_id = ? AND repository_id = ?").get(
          input.projectId,
          payload.repositoryId,
        );
        if (!known) throw new ProjectWorkRefusedError("That repository is not one this project knows.");
        // `implemented_by` is what "this is the change we delivered" means, and
        // it is only ever the result of somebody accepting a change as the
        // delivery — which is where the canonical capture is taken and where
        // the person's decision is recorded (M21-T18, leap "Execution and
        // convergence"). A bare link would be that claim with none of it.
        if (payload.relation === "implemented_by") {
          throw new ProjectWorkRefusedError(
            "A change becomes the delivery by being accepted as one, not by being linked. Accept the attempt's change as delivery instead.",
          );
        }
        const subject = this.refOf(entity, revision);
        const repositoryLink: RepositoryLink = {
          projectId: input.projectId,
          linkId,
          subject,
          relation: payload.relation,
          repositoryId: payload.repositoryId,
          target: payload.target,
          ...(payload.publishedPath ? { publishedPath: payload.publishedPath } : {}),
          createdBy: input.origin.actor,
          createdAt: now,
          ...(payload.supersedesLinkId ? { supersedesLinkId: payload.supersedesLinkId } : {}),
          ...(payload.captureBlobId ? { captureBlobId: payload.captureBlobId } : {}),
          ...(payload.display ? { display: payload.display } : {}),
        };
        this.insertRepositoryLink(linkId, entity.entity_id, payload.subjectRevisionId, repositoryLink, now, "link");
        record = { type: "repository", repository: repositoryLink };
      } else if (payload.type === "evidence") {
        const revision = this.revisionRow(input.projectId, payload.revisionId);
        if (revision.entity_id !== entity.entity_id) throw new ProjectWorkRefusedError("That revision belongs to another item.");
        // Acceptance is what a completion rests on, so it says the acceptance
        // passed. A failed attempt is evidence — supporting evidence — and it
        // leaves the task actionable rather than accepted (leap, "Revision and
        // staleness model").
        if (payload.role === "acceptance" && payload.outcome !== "passed") {
          throw new ProjectWorkRefusedError(
            "Acceptance evidence is evidence that passed. Record this as supporting evidence instead — a failed attempt is evidence, not a failed task.",
          );
        }
        // A verification that names the state it ran against writes that link
        // here, in the same transaction, and joins itself to it (M21-T18): the
        // evidence and the `verified_at` link are one act, so neither can
        // exist without the other.
        let repositoryLinkId = payload.repositoryLinkId;
        if (payload.verifiedAt) {
          const known = this.statement("SELECT 1 AS present FROM repositories WHERE project_id = ? AND repository_id = ?").get(
            input.projectId,
            payload.verifiedAt.repositoryId,
          );
          if (!known) throw new ProjectWorkRefusedError("That repository is not one this project knows.");
          // The attempt a state came out of is recorded on the link, and only
          // after this store has agreed it is one of its own: a client cannot
          // substitute another project's attempt into the record (M21-T19).
          const attemptId = input.verified?.executionLinkId;
          if (attemptId !== undefined) {
            const attempt = this.statement("SELECT 1 AS present FROM execution_links WHERE project_id = ? AND link_id = ?").get(
              input.projectId,
              attemptId,
            );
            if (!attempt) throw new ProjectWorkNotFoundError("That attempt is not one this project has.");
          }
          const verifiedLinkId = mintLinkId();
          const verified: RepositoryLink = {
            projectId: input.projectId,
            linkId: verifiedLinkId,
            subject: this.refOf(entity, revision),
            relation: "verified_at",
            repositoryId: payload.verifiedAt.repositoryId,
            target: { state: payload.verifiedAt.state },
            createdBy: input.origin.actor,
            createdAt: now,
            // Durability and acceptance are the host's findings, established
            // before this transaction opened (D-361). The capture exists by
            // now or the write never got here.
            ...(input.verified?.captureBlobId ? { captureBlobId: input.verified.captureBlobId } : {}),
            ...(attemptId ? { executionLinkId: attemptId } : {}),
            ...(input.verified?.acceptance ? { acceptance: input.verified.acceptance } : {}),
          };
          this.insertRepositoryLink(verifiedLinkId, entity.entity_id, payload.revisionId, verified, now, "record_verified_at");
          repositoryLinkId = verifiedLinkId;
        }
        const evidenceId = mintEvidenceId();
        const evidence: ProjectWorkEvidence = {
          projectId: input.projectId,
          evidenceId,
          entityId: entity.entity_id,
          revisionId: payload.revisionId,
          kind: payload.kind,
          role: payload.role,
          summary: payload.summary,
          ...(payload.detail ? { detail: payload.detail } : {}),
          ...(payload.blobId ? { blobId: payload.blobId } : {}),
          outcome: payload.outcome,
          at: now,
          origin: input.origin,
          ...(repositoryLinkId ? { repositoryLinkId } : {}),
        };
        this.statement(
          "INSERT INTO evidence (evidence_id, project_id, entity_id, revision_id, kind, role, summary, detail, blob_id, outcome, at, origin_json, repository_link_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          evidenceId,
          input.projectId,
          entity.entity_id,
          payload.revisionId,
          payload.kind,
          payload.role,
          payload.summary,
          payload.detail ?? null,
          payload.blobId ?? null,
          payload.outcome,
          now,
          JSON.stringify(input.origin),
          repositoryLinkId ?? null,
        );
        this.chargeRow("evidence", input.projectId, "evidence_id = ?", [evidenceId], true);
        record = { type: "evidence", evidence };
      } else {
        const revision = this.revisionRow(input.projectId, payload.revisionId);
        if (revision.entity_id !== entity.entity_id) throw new ProjectWorkRefusedError("That revision belongs to another item.");
        const decisionId = mintDecisionId();
        const decision: ProjectWorkDecision = {
          projectId: input.projectId,
          decisionId,
          entityId: entity.entity_id,
          revisionId: payload.revisionId,
          title: payload.title,
          rationale: payload.rationale,
          consequences: payload.consequences,
          at: now,
          origin: input.origin,
          ...(payload.supersedesDecisionId ? { supersedesDecisionId: payload.supersedesDecisionId } : {}),
        };
        this.statement(
          "INSERT INTO decisions (decision_id, project_id, entity_id, revision_id, title, rationale, consequences_json, at, origin_json, supersedes_decision_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          decisionId,
          input.projectId,
          entity.entity_id,
          payload.revisionId,
          payload.title,
          payload.rationale,
          JSON.stringify(payload.consequences),
          now,
          JSON.stringify(input.origin),
          payload.supersedesDecisionId ?? null,
        );
        this.chargeRow("decisions", input.projectId, "decision_id = ?", [decisionId], true);
        record = { type: "decision", decision };
      }
      this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, entity.entity_id);
      this.touchEntity(input.projectId, entity.entity_id);
      const seq = this.raise(input.projectId, {
        change: "link",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: entity.title,
        state: entity.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      return { link: record, seq };
    });
  }

  /**
   * What an earlier transaction already stored for the link about to be
   * written, if anything (review H-1).
   *
   * Every way a link can rest on bytes that are already durable: a delivery
   * whose capture the gate stored, a `verified_at` state whose capture the
   * host took before validating anything else, and — generally — any record
   * that names a blob already in this project, whether that is an evidence
   * row pointing at a verification report or a repository link written with
   * the capture it was read against. The general case is deliberately a
   * property of the write rather than a flag a caller passes: a report is
   * stored and then named, and so is whatever the next feature stores and
   * then names.
   */
  private preparedForLink(
    input: {
      projectId: string;
      capture?: { blobId: string } | undefined;
      verified?: { captureBlobId?: string | undefined; gate?: string | undefined } | undefined;
    },
    payload: ProjectWorkLinkInput,
  ): PreparedWrite | undefined {
    if (payload.type === "delivery") return input.capture ? preparedDelivery() : undefined;
    if (payload.type === "repository") {
      return payload.captureBlobId !== undefined && this.blobStored(input.projectId, payload.captureBlobId) ? preparedStoredData() : undefined;
    }
    if (payload.type !== "evidence") return undefined;
    if (input.verified?.captureBlobId !== undefined) return preparedCapture(input.verified.gate ?? "Recording this state");
    if (payload.blobId !== undefined && this.blobStored(input.projectId, payload.blobId)) return preparedStoredData();
    return undefined;
  }

  /** Is this blob already in this project's store, before this transaction? */
  private blobStored(projectId: string, blobId: string): boolean {
    return this.statement("SELECT 1 AS present FROM blobs WHERE project_id = ? AND blob_id = ?").get(projectId, blobId) !== undefined;
  }

  /**
   * Accept one exact repository change as the delivery of this work (M21-T18).
   *
   * The only door `implemented_by` has. It writes one link per accepted
   * subject revision — the Task's own, and every approved input revision the
   * caller named — all pointing at the **same** change, which is what makes
   * the relation many-to-many without any of the copies drifting. The capture
   * was already stored by the caller (`captures.ts`) before this ran, so the
   * evidence is durable before the acceptance exists, not after.
   *
   * A correction appends: a link that supersedes another keeps the old one,
   * with its own capture, exactly where it was.
   */
  private acceptDelivery(
    input: {
      projectId: string;
      expectedRevisionId: string;
      capture?: { blobId: string; bytes: number; files: number; sources: number; truncated?: string } | undefined;
    } & ProjectWorkWriteOrigin,
    payload: Extract<ProjectWorkLinkInput, { type: "delivery" }>,
    now: string,
  ): { link: ProjectWorkLinkRecord; seq: number } {
    const entity = this.entityRow(input.projectId, payload.entityId);
    this.requireCurrent(entity, input.expectedRevisionId);
    const known = this.statement("SELECT 1 AS present FROM repositories WHERE project_id = ? AND repository_id = ?").get(
      input.projectId,
      payload.repositoryId,
    );
    if (!known) throw new ProjectWorkRefusedError("That repository is not one this project knows.");
    if (payload.executionLinkId) {
      const attempt = this.statement("SELECT 1 AS present FROM execution_links WHERE project_id = ? AND link_id = ?").get(
        input.projectId,
        payload.executionLinkId,
      );
      if (!attempt) throw new ProjectWorkNotFoundError("That attempt is not one this project has.");
    }

    const subjects: Array<{ entityId: string; revisionId: string }> = [{ entityId: payload.entityId, revisionId: payload.revisionId }];
    for (const covered of payload.covers ?? []) {
      if (subjects.some((subject) => subject.entityId === covered.entityId && subject.revisionId === covered.revisionId)) continue;
      subjects.push(covered);
    }

    const links: RepositoryLink[] = [];
    for (const subject of subjects) {
      const row = this.entityRow(input.projectId, subject.entityId);
      const revision = this.revisionRow(input.projectId, subject.revisionId);
      if (revision.entity_id !== row.entity_id) throw new ProjectWorkRefusedError("That revision belongs to another item.");
      const linkId = mintLinkId();
      const link: RepositoryLink = {
        projectId: input.projectId,
        linkId,
        subject: this.refOf(row, revision),
        relation: "implemented_by",
        repositoryId: payload.repositoryId,
        target: { change: payload.change },
        createdBy: input.origin.actor,
        createdAt: now,
        ...(payload.supersedesLinkId ? { supersedesLinkId: payload.supersedesLinkId } : {}),
        ...(input.capture ? { captureBlobId: input.capture.blobId } : {}),
        ...(payload.executionLinkId ? { executionLinkId: payload.executionLinkId } : {}),
        ...(payload.display ? { display: payload.display } : {}),
      };
      this.insertRepositoryLink(linkId, row.entity_id, subject.revisionId, link, now, "accept_delivery");
      this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, row.entity_id);
      this.touchEntity(input.projectId, row.entity_id);
      links.push(link);
    }

    const seq = this.raise(input.projectId, {
      change: "link",
      entityId: entity.entity_id,
      entityKind: entity.kind as ProjectWorkKind,
      key: entity.key,
      title: entity.title,
      state: entity.state as ProjectWorkState,
      at: now,
      actorLabel: input.origin.actor.label,
    });
    return { link: { type: "delivery", links, ...(input.capture ? { capture: input.capture } : {}) }, seq };
  }

  /**
   * One repository link row. The same columns whichever door wrote it — and,
   * when it arrives with a capture, the first immutable association between
   * the two, written in this same transaction (D-363).
   */
  private insertRepositoryLink(
    linkId: string,
    entityId: string,
    revisionId: string,
    link: RepositoryLink,
    now: string,
    gate?: string,
  ): void {
    this.statement(
      "INSERT INTO repository_links (link_id, project_id, entity_id, revision_id, relation, repository_id, subject_json, target_json, published_path, created_by_json, created_at, supersedes_link_id, capture_blob_id, display_json, execution_link_id, acceptance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      linkId,
      link.projectId,
      entityId,
      revisionId,
      link.relation,
      link.repositoryId,
      JSON.stringify(link.subject),
      JSON.stringify(link.target),
      link.publishedPath ?? null,
      JSON.stringify(link.createdBy),
      now,
      link.supersedesLinkId ?? null,
      link.captureBlobId ?? null,
      link.display ? JSON.stringify(link.display) : null,
      link.executionLinkId ?? null,
      link.acceptance ? JSON.stringify(link.acceptance) : null,
    );
    this.chargeRow("repository_links", link.projectId, "link_id = ?", [linkId], true);
    if (link.captureBlobId) {
      this.appendCaptureAssociation({
        projectId: link.projectId,
        linkId,
        blobId: link.captureBlobId,
        at: now,
        reason: "first_capture",
        actor: link.createdBy,
        ...(gate ? { gate } : {}),
      });
    }
  }

  /**
   * Append one immutable link-to-capture association (D-363).
   *
   * Only ever called inside the transaction that made the association true —
   * the link's own insert, or a compare-and-set that really moved the pointer.
   * `seq` is this link's own next number rather than a clock: two associations
   * written in the same millisecond stay ordered, and nothing infers which
   * came first from a timestamp.
   */
  private appendCaptureAssociation(input: {
    projectId: string;
    linkId: string;
    blobId: string;
    at: string;
    reason: RepositoryCaptureAttachReason;
    actor: ProjectWorkActor;
    gate?: string;
    supersedesBlobId?: string;
  }): RepositoryLinkCaptureRevision {
    const previous = this.statement(
      "SELECT revision_id, seq FROM repository_link_captures WHERE project_id = ? AND link_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(input.projectId, input.linkId) as { revision_id: string; seq: number } | undefined;
    const revisionId = mintCaptureRevisionId();
    const seq = Number(previous?.seq ?? 0) + 1;
    this.statement(
      "INSERT INTO repository_link_captures (revision_id, project_id, link_id, blob_id, supersedes_blob_id, supersedes_revision_id, attached_at, seq, reason, gate, actor_json) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      revisionId,
      input.projectId,
      input.linkId,
      input.blobId,
      input.supersedesBlobId ?? null,
      input.supersedesBlobId !== undefined ? (previous?.revision_id ?? null) : null,
      input.at,
      seq,
      input.reason,
      input.gate ?? null,
      JSON.stringify(input.actor),
    );
    // Append-only capture provenance is canonical history (D-363), so it is
    // charged like the link it hangs off rather than accumulating for free.
    this.chargeRow("repository_link_captures", input.projectId, "revision_id = ?", [revisionId], true);
    return {
      revisionId,
      linkId: input.linkId,
      blobId: input.blobId,
      ...(input.supersedesBlobId !== undefined ? { supersedesBlobId: input.supersedesBlobId } : {}),
      ...(input.supersedesBlobId !== undefined && previous ? { supersedesRevisionId: previous.revision_id } : {}),
      attachedAt: input.at,
      seq,
      reason: input.reason,
      ...(input.gate ? { gate: input.gate } : {}),
      actor: input.actor,
    };
  }

  /** One association row, as the protocol shape. */
  private toCaptureAssociation(row: Record<string, unknown>): RepositoryLinkCaptureRevision {
    return {
      revisionId: row["revision_id"] as string,
      linkId: row["link_id"] as string,
      blobId: row["blob_id"] as string,
      ...(row["supersedes_blob_id"] ? { supersedesBlobId: row["supersedes_blob_id"] as string } : {}),
      ...(row["supersedes_revision_id"] ? { supersedesRevisionId: row["supersedes_revision_id"] as string } : {}),
      attachedAt: row["attached_at"] as string,
      seq: Number(row["seq"]),
      reason: row["reason"] as RepositoryCaptureAttachReason,
      ...(row["gate"] ? { gate: row["gate"] as string } : {}),
      actor: JSON.parse(row["actor_json"] as string) as ProjectWorkActor,
    };
  }

  /**
   * The association that makes a capture this link's proof **right now**
   * (D-363).
   *
   * Read by a gate while it prepares, and read again inside the decision's own
   * transaction: a decision binds the association it checked, or it is refused
   * because somebody moved the proof underneath it.
   */
  currentCaptureAssociation(projectId: string, linkId: string): RepositoryLinkCaptureRevision | undefined {
    const row = this.statement(
      "SELECT * FROM repository_link_captures WHERE project_id = ? AND link_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(projectId, linkId) as Record<string, unknown> | undefined;
    return row ? this.toCaptureAssociation(row) : undefined;
  }

  /**
   * The link's own original association, when this database can attest one
   * independently (D-363).
   *
   * `first_capture` only: that row was written inside the link's own insert,
   * so it *is* the proof the link was created with, and a delivery accepted
   * before decisions bound their own proof can honestly be read against it.
   *
   * A `legacy_baseline` is explicitly **not** that. It records the only
   * association a migration could see — whatever the pointer happened to hold
   * when this release first opened the database — and says nothing about what
   * an older acceptance consumed: the pointer may already have been corrected
   * once by a gate that ran before this history existed. Attributing it to an
   * old decision would upgrade a partial proof into a certificate, so the
   * honest answer is nothing, and the decision is reviewed again.
   */
  originalCaptureAssociation(projectId: string, linkId: string): RepositoryLinkCaptureRevision | undefined {
    const row = this.statement(
      "SELECT * FROM repository_link_captures WHERE project_id = ? AND link_id = ? ORDER BY seq ASC LIMIT 1",
    ).get(projectId, linkId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const association = this.toCaptureAssociation(row);
    return association.reason === "first_capture" ? association : undefined;
  }

  /**
   * One bounded page of capture history: associations, or the proof bindings
   * of decisions (D-363).
   *
   * Bounded **in total** rather than per link, which is what makes an older
   * association reachable at all: forty links times fifty rows is not a page,
   * and the fifty-first association of the first link was previously
   * unreadable through any request. So the rows are ordered stably
   * (`link_id`, then `seq` newest-first inside a link), cut at the bound, and
   * what did not fit is reached with the cursor this returns.
   *
   * `linkIds` is the scope the caller resolved — the repository links of the
   * entity being read — so a request can never page across a project it did
   * not ask about. A named `linkId` must be one of them.
   */
  captureHistoryPage(
    projectId: string,
    query: RepositoryCaptureHistoryQuery & { linkIds: readonly string[]; entityId?: string | undefined },
  ): RepositoryCaptureHistoryPage {
    const limit = Math.max(1, Math.min(query.limit ?? REPOSITORY_CAPTURE_HISTORY_MAX, REPOSITORY_CAPTURE_HISTORY_MAX));
    if (query.of === "decisions") return this.decisionBindingPage(projectId, query, limit);

    if (query.revisionId !== undefined) {
      // An exact association, which is how a stored binding is read back: one
      // row, by its own id, with no page to walk.
      const row = this.statement(
        `SELECT * FROM repository_link_captures WHERE project_id = ? AND revision_id = ? AND link_id IN (${placeholders(query.linkIds)})`,
      ).get(projectId, query.revisionId, ...query.linkIds) as Record<string, unknown> | undefined;
      return { of: "associations", associations: row ? [this.toCaptureAssociation(row)] : [], bindings: [] };
    }
    const scope = query.linkId !== undefined ? query.linkIds.filter((id) => id === query.linkId) : query.linkIds;
    if (scope.length === 0) return { of: "associations", associations: [], bindings: [] };
    const after = query.cursor === undefined ? undefined : associationCursor(query.cursor);
    // One row more than the bound, so "there is more" is a fact rather than an
    // inference from a full page.
    const rows = this.statement(
      `SELECT * FROM repository_link_captures WHERE project_id = ? AND link_id IN (${placeholders(scope)}) ` +
        (after ? "AND (link_id > ? OR (link_id = ? AND seq < ?)) " : "") +
        "ORDER BY link_id ASC, seq DESC LIMIT ?",
    ).all(
      projectId,
      ...scope,
      ...(after ? [after.linkId, after.linkId, after.seq] : []),
      limit + 1,
    ) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit).map((row) => this.toCaptureAssociation(row));
    const last = page[page.length - 1];
    return {
      of: "associations",
      associations: page,
      bindings: [],
      ...(rows.length > limit && last ? { nextCursor: `${last.linkId}:${String(last.seq)}` } : {}),
    };
  }

  private decisionBindingPage(
    projectId: string,
    query: RepositoryCaptureHistoryQuery & { linkIds: readonly string[]; entityId?: string | undefined },
    limit: number,
  ): RepositoryCaptureHistoryPage {
    const filters = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (query.decisionId !== undefined) {
      filters.push("decision_id = ?");
      params.push(query.decisionId);
    }
    if (query.entityId !== undefined) {
      filters.push("entity_id = ?");
      params.push(query.entityId);
    }
    if (query.linkId !== undefined) {
      filters.push("link_id = ?");
      params.push(query.linkId);
    }
    const after = query.cursor === undefined ? undefined : decisionCursor(query.cursor);
    if (after) {
      filters.push("(decision_id > ? OR (decision_id = ? AND link_id > ?))");
      params.push(after.decisionId, after.decisionId, after.linkId);
    }
    const rows = this.statement(
      `SELECT * FROM decision_capture_bindings WHERE ${filters.join(" AND ")} ORDER BY decision_id ASC, link_id ASC LIMIT ?`,
    ).all(...params, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit).map(
      (row): DecisionCaptureBinding => ({
        kind: row["decision_kind"] as DecisionProofKind,
        decisionId: row["decision_id"] as string,
        entityId: row["entity_id"] as string,
        linkId: row["link_id"] as string,
        blobId: row["blob_id"] as string,
        associationRevisionId: row["association_revision_id"] as string,
        associationSeq: Number(row["association_seq"]),
        boundAt: row["bound_at"] as string,
      }),
    );
    const last = page[page.length - 1];
    // "Known" is only ever answered about **one** named decision, because it is
    // a fact about that decision: a decision this store bound holds a set row,
    // even when the set is empty, and a decision older than this history holds
    // none and stays unknown rather than being read as having rested on
    // nothing.
    //
    // Scoped exactly like the rows beside it. Answering `known` across the
    // whole project while the bindings are filtered by entity would tell a
    // read about one item that some *other* item's decision rested on nothing
    // — a true row about the wrong subject, which is the one kind of answer
    // this history may not give.
    const known =
      query.decisionId === undefined
        ? undefined
        : this.statement(
            "SELECT 1 AS present FROM decision_capture_binding_sets WHERE project_id = ? AND decision_id = ?" +
              (query.entityId !== undefined ? " AND entity_id = ?" : "") +
              " LIMIT 1",
          ).get(projectId, query.decisionId, ...(query.entityId !== undefined ? [query.entityId] : [])) !== undefined;
    return {
      of: "decisions",
      associations: [],
      bindings: page,
      ...(rows.length > limit && last ? { nextCursor: `${last.decisionId}:${last.linkId}` } : {}),
      ...(known !== undefined ? { known } : {}),
    };
  }

  /**
   * Bind a decision to the exact captures it was prepared on, inside the
   * decision's own transaction (D-363).
   *
   * The gate read each association while it was preparing; this checks, under
   * the write lock, that every one of them is **still** what the link's
   * canonical pointer and its newest association say — and refuses the whole
   * decision if one moved. It never quietly re-reads whatever is current now:
   * the person decided on what they were shown, and a decision recorded
   * against a proof nobody checked is the failure this exists to prevent.
   *
   * A refusal throws, so the transaction that would have written the approval
   * or the completion rolls back with it: no binding, and no decision.
   */
  private bindDecisionProof(input: {
    projectId: string;
    kind: DecisionProofKind;
    decisionId: string;
    entityId: string;
    proof: DecisionProofPreparation;
    at: string;
  }): void {
    for (const ref of input.proof.refs) {
      const link = this.statement("SELECT capture_blob_id FROM repository_links WHERE project_id = ? AND link_id = ?").get(
        input.projectId,
        ref.linkId,
      ) as { capture_blob_id: string | null } | undefined;
      const current = this.currentCaptureAssociation(input.projectId, ref.linkId);
      const unchanged =
        link?.capture_blob_id === ref.blobId &&
        current !== undefined &&
        current.revisionId === ref.associationRevisionId &&
        current.seq === ref.associationSeq &&
        current.blobId === ref.blobId;
      if (!unchanged) {
        throw new ProjectWorkRefusedError(
          `${input.proof.gate} was being prepared when this record's evidence changed somewhere else, so it was not decided on what you were looking at. Try again.`,
        );
      }
      const bindingId = mintProofBindingId();
      this.statement(
        "INSERT INTO decision_capture_bindings (binding_id, project_id, decision_kind, decision_id, entity_id, link_id, blob_id, association_revision_id, association_seq, bound_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        bindingId,
        input.projectId,
        input.kind,
        input.decisionId,
        input.entityId,
        ref.linkId,
        ref.blobId,
        ref.associationRevisionId,
        ref.associationSeq,
        input.at,
      );
      this.chargeRow("decision_capture_bindings", input.projectId, "binding_id = ?", [bindingId], true);
    }
    // The set row is written whether or not there were any: a decision that
    // rested on no repository evidence recorded that it rested on none, which
    // is a different answer from the silence a decision older than this
    // history leaves behind.
    const setKey = [input.projectId, input.kind, input.decisionId];
    const existingSet = this.statement(
      "SELECT 1 AS present FROM decision_capture_binding_sets WHERE project_id = ? AND decision_kind = ? AND decision_id = ?",
    ).get(...setKey);
    this.statement(
      "INSERT INTO decision_capture_binding_sets (project_id, decision_kind, decision_id, entity_id, bindings, bound_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(project_id, decision_kind, decision_id) DO NOTHING",
    ).run(input.projectId, input.kind, input.decisionId, input.entityId, input.proof.refs.length, input.at);
    this.chargeRow(
      "decision_capture_binding_sets",
      input.projectId,
      "project_id = ? AND decision_kind = ? AND decision_id = ?",
      setKey,
      existingSet === undefined,
    );
  }

  /**
   * Attach a canonical capture to a link that had none, or correct one that
   * was not enough (M21-T18, M21-T19).
   *
   * Used when a decision — an approval, a completion — reaches a link that was
   * recorded before anyone knew it would be leant on. The link's identity is
   * untouched: only the capture it can be read from is added.
   *
   * A correction names the blob it read (`replacing`), so the pointer moves
   * off exactly that capture and off no other: an idempotent attach can never
   * freeze a partial proof in place, and two callers cannot race one link into
   * pointing at a capture neither of them checked. Nothing is deleted — the
   * capture it replaces keeps its own content address in the store.
   *
   * The compare-and-set is honest about losing (D-363): the association is
   * appended **only** when the pointer really moved, and a caller that lost
   * the race is told `false` rather than left to assume it won. An attach that
   * finds the pointer already on this exact blob is the same write repeated,
   * and appends nothing.
   *
   * `gate` is context, not a verdict: a correction taken while a gate was
   * being prepared is recorded as a preparation, because the decision it was
   * for may still be refused after this returns.
   */
  attachCapture(
    projectId: string,
    linkId: string,
    blobId: string,
    replacing?: string | undefined,
    context?: { gate?: string | undefined; actor?: ProjectWorkActor | undefined } | undefined,
  ): boolean {
    return this.write(() => {
      // The capture this correction points at was stored by an earlier
      // transaction and stays readable whether or not the pointer moves, so a
      // refusal for space here says the pointer did not move — never that
      // nothing was saved (review H-1).
      this.prepared = preparedCorrection(context?.gate);
      const changes = Number(
        replacing !== undefined
          ? this.statement(
              "UPDATE repository_links SET capture_blob_id = ? WHERE project_id = ? AND link_id = ? AND capture_blob_id = ?",
            ).run(blobId, projectId, linkId, replacing).changes
          : this.statement(
              "UPDATE repository_links SET capture_blob_id = ? WHERE project_id = ? AND link_id = ? AND capture_blob_id IS NULL",
            ).run(blobId, projectId, linkId).changes,
      );
      if (changes !== 1) return false;
      // The pointer really moved, so the row costs what it costs now.
      this.chargeRow("repository_links", projectId, "link_id = ?", [linkId]);
      // The row exists: the compare-and-set just moved it. Its creator stands
      // in when the caller named no actor of its own.
      const link = this.statement("SELECT created_by_json FROM repository_links WHERE project_id = ? AND link_id = ?").get(
        projectId,
        linkId,
      ) as { created_by_json: string };
      this.appendCaptureAssociation({
        projectId,
        linkId,
        blobId,
        at: this.now(),
        reason: "gate_preparation",
        actor: context?.actor ?? (JSON.parse(link.created_by_json) as ProjectWorkActor),
        ...(context?.gate ? { gate: context.gate } : {}),
        ...(replacing !== undefined ? { supersedesBlobId: replacing } : {}),
      });
      return true;
    });
  }

  /**
   * Does an approval, a completion or a piece of acceptance evidence rest on
   * this repository link?
   *
   * Any of these makes the link part of a decision's record: a decision that
   * bound this link's proof (D-363), the evidence that names it, an acceptance
   * the host confirmed on it, or an approved or completed subject it was
   * recorded against.
   */
  private decisionRestsOn(projectId: string, entityId: string, linkId: string): boolean {
    // The strongest answer first, because it is the exact one: a decision
    // recorded that it was made on this link's proof.
    const bound = this.statement(
      "SELECT 1 AS present FROM decision_capture_bindings WHERE project_id = ? AND link_id = ? LIMIT 1",
    ).get(projectId, linkId) as { present: number } | undefined;
    if (bound) return true;
    const named = this.statement(
      "SELECT 1 AS present FROM evidence WHERE project_id = ? AND entity_id = ? AND repository_link_id = ? LIMIT 1",
    ).get(projectId, entityId, linkId) as { present: number } | undefined;
    if (named) return true;
    const accepted = this.statement(
      "SELECT acceptance_json FROM repository_links WHERE project_id = ? AND link_id = ?",
    ).get(projectId, linkId) as { acceptance_json: string | null } | undefined;
    if (accepted?.acceptance_json) return true;
    const entity = this.statement("SELECT state FROM entities WHERE entity_id = ?").get(entityId) as { state: string } | undefined;
    return entity?.state === "approved" || entity?.state === "done";
  }

  unlink(input: { projectId: string; entityId: string; expectedRevisionId: string; linkId: string } & ProjectWorkWriteOrigin): {
    removed: boolean;
    seq: number;
    replayed?: boolean;
  } {
    return this.once(input.projectId, "project/work/unlink", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      const now = this.now();
      // A link a decision rests on is not something an agent takes away, and
      // not something anybody erases (review F7, D-332). Creating an
      // `implemented_by` is a person's act; destroying one has to be at least
      // as deliberate, and a *record* of what was accepted survives either
      // way — a correction supersedes, it does not delete the provenance the
      // approval or the completion was read against.
      const provenance = this.statement(
        "SELECT relation FROM repository_links WHERE project_id = ? AND link_id = ? AND entity_id = ?",
      ).get(input.projectId, input.linkId, entity.entity_id) as { relation: string } | undefined;
      if (provenance && (provenance.relation === "implemented_by" || provenance.relation === "verified_at")) {
        if (input.origin.actor.kind !== "person") {
          throw new ProjectWorkRefusedError(
            "Only a person removes what a decision was made on. Record what is wrong with it as evidence, and propose the change instead.",
          );
        }
        if (this.decisionRestsOn(input.projectId, entity.entity_id, input.linkId)) {
          throw new ProjectWorkRefusedError(
            "A decision on this work was made against that record, so it stays. Accept the corrected state as a new delivery or a new acceptance: the old one is superseded, never erased.",
          );
        }
      }
      let removed = 0;
      const edgeWhere = "project_id = ? AND link_id = ? AND (subject_entity = ? OR object_entity = ?)";
      const edgeParams = [input.projectId, input.linkId, entity.entity_id, entity.entity_id];
      this.creditRows("edges", input.projectId, edgeWhere, edgeParams);
      removed += Number(this.statement(`DELETE FROM edges WHERE ${edgeWhere}`).run(...edgeParams).changes);
      const linkParams = [input.projectId, input.linkId, entity.entity_id];
      for (const [table, where] of [
        ["repository_links", "project_id = ? AND link_id = ? AND entity_id = ?"],
        ["execution_links", "project_id = ? AND link_id = ? AND entity_id = ?"],
        ["evidence", "project_id = ? AND evidence_id = ? AND entity_id = ?"],
        ["decisions", "project_id = ? AND decision_id = ? AND entity_id = ?"],
      ] as const) {
        this.creditRows(table, input.projectId, where, linkParams);
        const changes = Number(this.statement(`DELETE FROM ${table} WHERE ${where}`).run(...linkParams).changes);
        removed += changes;
        if (table === "repository_links" && changes > 0) {
          // A repository link that really goes takes its own capture history
          // with it: those rows key on the project, so leaving them would
          // leave charged history nothing can reach. The guard above has
          // already refused the case where a decision rests on it.
          this.creditRows("repository_link_captures", input.projectId, "project_id = ? AND link_id = ?", [input.projectId, input.linkId]);
          this.statement("DELETE FROM repository_link_captures WHERE project_id = ? AND link_id = ?").run(input.projectId, input.linkId);
        }
      }
      if (removed === 0) throw new ProjectWorkNotFoundError("That link is not one this item has.");
      this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, entity.entity_id);
      this.touchEntity(input.projectId, entity.entity_id);
      const seq = this.raise(input.projectId, {
        change: "unlink",
        entityId: entity.entity_id,
        entityKind: entity.kind as ProjectWorkKind,
        key: entity.key,
        title: entity.title,
        state: entity.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
      });
      return { removed: true, seq };
    });
  }

  // ----------------------------------------------------------------- tasks

  /** An explicit Task transition. A run ending is never one of these. */
  taskAction(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    action: ProjectTaskAction;
    evidenceId?: string | undefined;
    note?: string | undefined;
    /**
     * The captures the gate prepared this completion on (D-363), bound to the
     * completion's own event sequence inside this transaction.
     */
    proof?: DecisionProofPreparation | undefined;
  } & ProjectWorkWriteOrigin): {
    entity: ProjectWorkEntity;
    transition: { from: ProjectTaskState; to: ProjectTaskState };
    seq: number;
    replayed?: boolean;
    readiness?: TaskReadiness;
    cascaded?: Array<{ entityId: string; key: string; from: ProjectTaskState; to: ProjectTaskState }>;
  } {
    return this.once(input.projectId, "project/task/action", input.idempotencyKey, () => {
      // As in `approve`: evidence the gate kept in an earlier transaction is
      // still there, so a refusal here says the completion was not recorded,
      // not that nothing was saved.
      if (input.proof) this.prepared = preparedDecision(input.proof.gate);
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      if (entity.kind !== "task") throw new ProjectWorkRefusedError("Only a task has task actions.");
      const from = entity.state as ProjectTaskState;
      const note = input.note?.trim();
      // A cancellation is a decision about work somebody planned. The record
      // says why, or it does not happen.
      if (input.action === "cancel" && !note) {
        throw new ProjectWorkRefusedError("Say why this task is being cancelled, so the record says what happened to it.");
      }
      const facts = this.engine.facts(input.projectId, this.toEngineEntity(entity), input.evidenceId);
      const outcome = taskActionTransition(input.action, {
        from,
        trigger: input.origin.actor.kind,
        unmetDependencies: facts.unmetDependencies,
        hasAcceptanceEvidence: facts.hasAcceptanceEvidence,
        hasPassingVerification: facts.hasPassingVerification,
        planStale: facts.planStale,
        designStale: facts.designStale,
        ...(facts.staleUpstream ? { staleUpstream: facts.staleUpstream } : {}),
        blockingComments: Number(entity.blocking_comments),
      });
      if (!outcome.ok) {
        throw new ProjectWorkRefusedError(
          outcome.reason,
          facts.staleUpstream && (facts.planStale || facts.designStale)
            ? { refused: "stale_upstream", upstream: facts.staleUpstream }
            : undefined,
        );
      }
      const to = TASK_ACTION_TARGET[input.action];
      const now = this.now();
      this.statement("UPDATE entities SET state = ?, updated_at = ? WHERE entity_id = ?").run(to, now, entity.entity_id);
      this.touchEntity(input.projectId, entity.entity_id);
      this.refreshAttention(entity.entity_id);
      if (input.action === "cancel" && note) {
        this.insertEvidence({
          projectId: input.projectId,
          entityId: entity.entity_id,
          revisionId: entity.current_revision_id,
          kind: "review",
          role: "deviation",
          summary: `Cancelled: ${note}`,
          outcome: "inconclusive",
          at: now,
          origin: input.origin,
        });
      }
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "state",
        entityId: entity.entity_id,
        entityKind: "task",
        key: entity.key,
        title: updated.title,
        state: to,
        revisionId: entity.current_revision_id,
        at: now,
        actorLabel: input.origin.actor.label,
        ...(input.origin.sessionId ? { sessionId: input.origin.sessionId } : {}),
      });
      // A completion has no id of its own, so the decision it is bound under is
      // the sequence it was raised at: exact, monotonic, and two completions in
      // one millisecond still have two keys (D-363).
      if (input.proof) {
        this.bindDecisionProof({
          projectId: input.projectId,
          kind: "task_completion",
          decisionId: String(seq),
          entityId: entity.entity_id,
          proof: input.proof,
          at: now,
        });
      }
      // Whatever was waiting on this Task now knows where it stands.
      const cascaded = this.applyCascade(input.projectId, { keys: [entity.key] }, now);
      return {
        entity: this.toEntity(updated),
        transition: { from, to },
        seq,
        readiness: this.engine.readiness(input.projectId, this.toEngineEntity(updated)),
        ...(cascaded.length > 0 ? { cascaded } : {}),
      };
    });
  }

  /**
   * The rows the Plan/Task engine reads (M21-T15).
   *
   * Every query is the store's own, so the engine holds no SQL and no schema
   * knowledge, and the rules it decides can be read in one file.
   */
  private engineReader(): TaskEngineReader {
    const toEngine = (row: EntityRow): EngineEntity => this.toEngineEntity(row);
    return {
      entity: (projectId, entityId) => {
        const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as
          | EntityRow
          | undefined;
        return row ? toEngine(row) : undefined;
      },
      entityByKey: (projectId, key) => {
        const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND key = ?").get(projectId, key) as EntityRow | undefined;
        return row ? toEngine(row) : undefined;
      },
      allEntities: (projectId) =>
        (this.statement("SELECT * FROM entities WHERE project_id = ?").all(projectId) as EntityRow[]).map(toEngine),
      tasks: (projectId, states) => {
        const rows = states
          ? (this.statement(
              `SELECT * FROM entities WHERE project_id = ? AND kind = 'task' AND archived_at IS NULL AND state IN (${states
                .map(() => "?")
                .join(",")}) ORDER BY key_number ASC`,
            ).all(projectId, ...states) as EntityRow[])
          : (this.statement(
              "SELECT * FROM entities WHERE project_id = ? AND kind = 'task' AND archived_at IS NULL ORDER BY key_number ASC",
            ).all(projectId) as EntityRow[]);
        return rows.map(toEngine);
      },
      body: (projectId, entityId) => {
        const entity = this.statement("SELECT current_revision_id FROM entities WHERE project_id = ? AND entity_id = ?").get(
          projectId,
          entityId,
        ) as { current_revision_id: string } | undefined;
        if (!entity) return undefined;
        const revision = this.statement("SELECT body FROM revisions WHERE project_id = ? AND revision_id = ?").get(
          projectId,
          entity.current_revision_id,
        ) as { body: string } | undefined;
        return revision ? (JSON.parse(revision.body) as ProjectWorkBody) : undefined;
      },
      evidence: (projectId, entityId) =>
        (
          this.statement("SELECT evidence_id, kind, role, outcome FROM evidence WHERE project_id = ? AND entity_id = ?").all(
            projectId,
            entityId,
          ) as Array<{ evidence_id: string; kind: string; role: string; outcome: string }>
        ).map((row) => ({
          evidenceId: row.evidence_id,
          kind: row.kind as EngineEvidence["kind"],
          role: row.role as EngineEvidence["role"],
          outcome: row.outcome as EngineEvidence["outcome"],
        })),
      upstream: (projectId, entityId) =>
        (
          this.statement(
            `SELECT e.* FROM edges JOIN entities e ON e.entity_id = edges.object_entity
              WHERE edges.project_id = ? AND edges.subject_entity = ?`,
          ).all(projectId, entityId) as EntityRow[]
        ).map(toEngine),
      repositoryPaths: (projectId, entityId) => {
        const rows = this.statement("SELECT target_json FROM repository_links WHERE project_id = ? AND entity_id = ?").all(
          projectId,
          entityId,
        ) as Array<{ target_json: string }>;
        const paths: string[] = [];
        for (const row of rows) {
          const target = JSON.parse(row.target_json) as { state?: RepositoryStateRef; change?: RepositoryChangeRef };
          for (const ref of [target.state, target.change?.base, target.change?.head]) {
            if (ref?.path && !paths.includes(ref.path)) paths.push(ref.path);
          }
        }
        // What the attempts actually wrote, from git (M21-T18). This is the
        // *observed* side of a scope conflict: a Task that did not declare a
        // package and wrote in it anyway is visible to the next attempt, and
        // nothing a tool call said contributes a path here.
        const attempts = this.statement(
          "SELECT repositories_json FROM execution_links WHERE project_id = ? AND entity_id = ? AND repositories_json IS NOT NULL",
        ).all(projectId, entityId) as Array<{ repositories_json: string }>;
        for (const attempt of attempts) {
          const repositories = JSON.parse(attempt.repositories_json) as AttemptRepositoryRecord[];
          for (const repository of repositories) {
            for (const path of repository.changedPaths) {
              if (!paths.includes(path)) paths.push(path);
            }
          }
        }
        return paths;
      },
    };
  }

  /**
   * What the gate engine reads (M21-T8).
   *
   * Deliberately a different reader from the Task engine's: a gate asks about
   * linked artifacts, approvals and blocking comments, and a Task asks about
   * dependencies, evidence and scope. One reader that answered both would make
   * every change to either of them a change to both.
   */
  private gateReader(): GateReader {
    const toGate = (row: EntityRow): GateEntity => ({
      entityId: row.entity_id,
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      title: row.title,
      state: row.state as ProjectWorkState,
      currentRevisionId: row.current_revision_id,
      currentDigest: row.current_digest,
      archived: row.archived_at !== null,
      blockingComments: Number(row.blocking_comments),
    });
    return {
      entity: (projectId, entityId) => {
        const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as EntityRow | undefined;
        return row ? toGate(row) : undefined;
      },
      body: (projectId, revisionId) => {
        const row = this.statement("SELECT body FROM revisions WHERE project_id = ? AND revision_id = ?").get(projectId, revisionId) as
          | { body: string }
          | undefined;
        return row ? (JSON.parse(row.body) as ProjectWorkBody) : undefined;
      },
      neighbours: (projectId, entityId) =>
        (
          this.statement(
            `SELECT e.* FROM edges
               JOIN entities e ON e.entity_id = CASE WHEN edges.subject_entity = ? THEN edges.object_entity ELSE edges.subject_entity END
              WHERE edges.project_id = ? AND (edges.subject_entity = ? OR edges.object_entity = ?)`,
          ).all(entityId, projectId, entityId, entityId) as EntityRow[]
        ).map(toGate),
      approvals: (projectId, entityId) =>
        (
          this.statement("SELECT approval_id FROM approvals WHERE project_id = ? AND entity_id = ? ORDER BY at ASC, rowid ASC").all(
            projectId,
            entityId,
          ) as Array<{ approval_id: string }>
        ).map((row) => this.readApproval(projectId, row.approval_id)),
      blockingComments: (projectId, entityId) => this.openBlockingComments(projectId, entityId),
      planGraph: (projectId, planEntityId) => {
        const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, planEntityId) as
          | EntityRow
          | undefined;
        if (!row || row.kind !== "plan") return undefined;
        const body = JSON.parse(this.revisionRow(projectId, row.current_revision_id).body) as ProjectWorkBody;
        return body.kind === "plan" ? this.engine.planGraph(projectId, body.plan, row.key) : undefined;
      },
    };
  }

  /** The open blocking comments on one entity, named for a refusal (M21-T8). */
  private openBlockingComments(projectId: string, entityId: string): BlockingCommentRef[] {
    const rows = this.statement(
      "SELECT c.comment_id AS comment_id, c.state AS state, c.text AS text, c.orphaned AS orphaned, e.key AS key FROM comments c " +
        "JOIN entities e ON e.entity_id = c.entity_id " +
        "WHERE c.project_id = ? AND c.entity_id = ? AND c.blocking = 1 AND c.state != 'resolved' ORDER BY c.created_at ASC",
    ).all(projectId, entityId) as Array<{ comment_id: string; state: string; text: string; orphaned: number; key: string }>;
    return rows.map((row) => ({
      commentId: row.comment_id,
      entityId,
      key: row.key,
      state: row.state as BlockingCommentRef["state"],
      excerpt: row.text.split("\n", 1)[0]?.slice(0, 200) ?? "",
      ...(row.orphaned === 1 ? { orphaned: true } : {}),
    }));
  }

  /**
   * Where this entity's gates stand (M21-T8).
   *
   * A Spec answers for itself; a Design or a Plan answers for the Spec it is
   * linked to, because that is whose lifecycle the gate belongs to. Anything
   * with no Spec in reach has no gates, and says so by answering `undefined`.
   */
  gateReport(projectId: string, entityId: string): GateReport | undefined {
    const entity = this.gateReader().entity(projectId, entityId);
    if (!entity) return undefined;
    const spec = this.gates.specFor(projectId, entity);
    return spec ? this.gates.report(projectId, spec) : undefined;
  }

  private toEngineEntity(row: EntityRow): EngineEntity {
    return {
      projectId: row.project_id,
      entityId: row.entity_id,
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      title: row.title,
      state: row.state as ProjectWorkState,
      currentRevisionId: row.current_revision_id,
      blockingComments: Number(row.blocking_comments),
    };
  }

  /**
   * Apply what the dependency graph implies, inside the write that caused it.
   *
   * These are `system` transitions and nothing else: a dependency reaching
   * `done` makes the Tasks waiting on it ready, and reopening one puts them
   * back to blocked. Each is checked against the same transition rules a
   * person's move is, so a move the rules refuse simply does not happen.
   */
  private applyCascade(projectId: string, changed: { keys?: readonly string[]; entityIds?: readonly string[] }, at: string): CascadeIntent[] {
    const applied: CascadeIntent[] = [];
    for (const intent of this.engine.cascade(projectId, changed)) {
      const row = this.entityRow(projectId, intent.entityId);
      const facts = this.engine.facts(projectId, this.toEngineEntity(row));
      const move = taskTransition({
        from: intent.from,
        to: intent.to,
        trigger: "system",
        unmetDependencies: facts.unmetDependencies,
      });
      if (!move.ok) continue;
      this.statement("UPDATE entities SET state = ?, updated_at = ? WHERE entity_id = ?").run(intent.to, at, intent.entityId);
      this.touchEntity(projectId, intent.entityId);
      this.refreshAttention(intent.entityId);
      const updated = this.entityRow(projectId, intent.entityId);
      this.raise(projectId, {
        change: "state",
        entityId: intent.entityId,
        entityKind: "task",
        key: intent.key,
        title: updated.title,
        state: intent.to,
        revisionId: updated.current_revision_id,
        at,
      });
      applied.push(intent);
    }
    return applied;
  }

  /**
   * Write one evidence record the store itself is the author of.
   *
   * Two things need it: an attempt that ended, and a cancellation's reason.
   * Both are the Task's durable record of what happened, and neither is ever
   * `acceptance` — nothing the store writes by itself can complete a Task.
   */
  private insertEvidence(input: {
    projectId: string;
    entityId: string;
    revisionId: string;
    kind: ProjectWorkEvidence["kind"];
    role: ProjectWorkEvidence["role"];
    summary: string;
    detail?: string | undefined;
    outcome: ProjectWorkEvidence["outcome"];
    at: string;
    origin: ProjectWorkOrigin;
  }): ProjectWorkEvidence {
    const evidenceId = mintEvidenceId();
    this.statement(
      "INSERT INTO evidence (evidence_id, project_id, entity_id, revision_id, kind, role, summary, detail, blob_id, outcome, at, origin_json, repository_link_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      evidenceId,
      input.projectId,
      input.entityId,
      input.revisionId,
      input.kind,
      input.role,
      input.summary,
      input.detail ?? null,
      null,
      input.outcome,
      input.at,
      JSON.stringify(input.origin),
      null,
    );
    this.chargeRow("evidence", input.projectId, "evidence_id = ?", [evidenceId], true);
    return {
      projectId: input.projectId,
      evidenceId,
      entityId: input.entityId,
      revisionId: input.revisionId,
      kind: input.kind,
      role: input.role,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      outcome: input.outcome,
      at: input.at,
      origin: input.origin,
    };
  }

  /** The derived readiness of one Task, for a read or a write's answer. */
  taskReadiness(projectId: string, entityId: string): TaskReadiness | undefined {
    const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as EntityRow | undefined;
    if (!row || row.kind !== "task") return undefined;
    return this.engine.readiness(projectId, this.toEngineEntity(row));
  }

  /** The other active Tasks writing where this one does (M21-T15). */
  taskConflicts(projectId: string, entityId: string): TaskConflict[] {
    const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as EntityRow | undefined;
    if (!row || row.kind !== "task") return [];
    return this.engine.conflicts(projectId, this.toEngineEntity(row));
  }

  /** The report a Plan answers with: its graph, its order and its orphans. */
  planGraph(projectId: string, entityId: string): PlanGraphReport | undefined {
    const row = this.statement("SELECT * FROM entities WHERE project_id = ? AND entity_id = ?").get(projectId, entityId) as EntityRow | undefined;
    if (!row || row.kind !== "plan") return undefined;
    const body = JSON.parse(this.revisionRow(projectId, row.current_revision_id).body) as ProjectWorkBody;
    if (body.kind !== "plan") return undefined;
    return this.engine.planGraph(projectId, body.plan, row.key);
  }

  /**
   * Refuse a Plan whose Task graph cannot be executed, and hand back the
   * report the accepted one produces.
   *
   * Called inside the write, before the revision is stored: a cycle, a key
   * this project never minted or a dependency on a Task the Plan stopped
   * listing is a refusal naming the keys, never a stored graph nothing can
   * order.
   */
  private requirePlanGraph(projectId: string, body: ProjectWorkBody, planKey?: string): PlanGraphReport | undefined {
    if (body.kind !== "plan") return undefined;
    const report = this.engine.planGraph(projectId, body.plan, planKey);
    const problem = report.problems[0];
    if (problem) throw new ProjectWorkRefusedError(problem.message);
    return report;
  }

  /**
   * Only a person accepts the risk of two Tasks writing the same files.
   *
   * `scope.sharedWith` is that acceptance, recorded in a revision so it says
   * who decided it and when. An agent's revision may keep one a person
   * already made; it may not add one.
   */
  private requireSharedScopeAuthority(previous: ProjectTaskBody | undefined, next: ProjectWorkBody, origin: ProjectWorkOrigin): void {
    if (next.kind !== "task") return;
    const added = (next.task.scope.sharedWith ?? []).filter((key) => !(previous?.scope.sharedWith ?? []).includes(key));
    if (added.length === 0) return;
    if (origin.actor.kind !== "person") {
      throw new ProjectWorkRefusedError(
        `Only you can accept the risk of two tasks writing the same files (${added.join(", ")}).`,
      );
    }
  }

  /** Join a Task to a session, run, checkpoint, branch or command. */
  linkExecution(input: {
    projectId: string;
    entityId: string;
    expectedRevisionId: string;
    execution: {
      kind: ExecutionLink["kind"];
      targetId: string;
      attempt?: number | undefined;
      profileId?: string | undefined;
      branch?: string | undefined;
      repositoryId?: string | undefined;
      baseCommitObjectId?: string | undefined;
      startedAt?: string | undefined;
      endedAt?: string | undefined;
      outcome?: ExecutionLink["outcome"] | undefined;
    };
    /** What git said each repository did during it, resolved by the caller. */
    repositories?: readonly AttemptRepositoryRecord[] | undefined;
    /** The checkpoint namespace this attempt's refs were read from. */
    checkpointKey?: string | undefined;
    /**
     * The attempt this call is closing, when the caller knows which one it is
     * (review F2). An id that names no open attempt on this Task is refused,
     * never resolved to whichever one happens to be newest.
     */
    executionLinkId?: string | undefined;
  } & ProjectWorkWriteOrigin): {
    link: ExecutionLink;
    entity: ProjectWorkEntity;
    seq: number;
    replayed?: boolean;
    attemptEvidence?: ProjectWorkEvidence;
    conflicts?: TaskConflict[];
  } {
    return this.once(input.projectId, "project/task/link-execution", input.idempotencyKey, () => {
      const entity = this.entityRow(input.projectId, input.entityId);
      this.requireCurrent(entity, input.expectedRevisionId);
      if (entity.kind !== "task") throw new ProjectWorkRefusedError("Only a task links an execution attempt.");
      const now = this.now();
      const ending = input.execution.outcome !== undefined || input.execution.endedAt !== undefined;
      // An attempt that ends is the attempt that started, not a second one
      // (M21-T18): the row that carries its base commit and its checkpoints is
      // the row that has to carry its terminal outcome, or the record of what
      // happened is split in two and neither half is an attempt.
      //
      // Which open attempt is decided by identity, never by recency. The row
      // is already narrowed by kind and target, so two different sessions can
      // never collide; two attempts of the *same* target are told apart by the
      // checkpoint namespace the caller is reading, or by the link it names.
      // A caller whose identity matches no open attempt is refused rather than
      // closing a row that is not its own (review F2).
      type OpenRow = { link_id: string; attempt: number; started_at: string; base_commit: string | null; repositories_json: string | null; checkpoint_key: string | null };
      let open: OpenRow | undefined;
      if (ending) {
        const rows = this.statement(
          "SELECT link_id, attempt, started_at, base_commit, repositories_json, checkpoint_key FROM execution_links " +
            "WHERE project_id = ? AND entity_id = ? AND kind = ? AND target_id = ? AND ended_at IS NULL " +
            "ORDER BY attempt DESC",
        ).all(input.projectId, entity.entity_id, input.execution.kind, input.execution.targetId) as OpenRow[];
        const named = input.executionLinkId;
        if (named !== undefined) {
          open = rows.find((row) => row.link_id === named);
          if (!open) {
            throw new ProjectWorkRefusedError(
              "That attempt is not open on this task, so it cannot be closed. Read the task's attempts and close the one this session started.",
            );
          }
        } else if (input.checkpointKey !== undefined && rows.some((row) => row.checkpoint_key !== null)) {
          open = rows.find((row) => row.checkpoint_key === input.checkpointKey);
          if (!open) {
            throw new ProjectWorkRefusedError(
              "No attempt this conversation started is open on this task, so there is nothing here for it to close.",
            );
          }
        } else {
          open = rows[0];
        }
      }
      const attempt =
        input.execution.attempt ??
        open?.attempt ??
        Number((this.statement("SELECT COALESCE(MAX(attempt), 0) AS n FROM execution_links WHERE entity_id = ?").get(entity.entity_id) as { n: number }).n) + 1;
      const linkId = open?.link_id ?? mintLinkId();
      // Facts the caller could not read again keep what the open attempt
      // recorded: a base commit and a checkpoint list are history, and a
      // closing call that happened to be unable to read git must not erase it.
      const repositories =
        input.repositories ??
        (open?.repositories_json ? (JSON.parse(open.repositories_json) as AttemptRepositoryRecord[]) : undefined);
      const link: ExecutionLink = {
        projectId: input.projectId,
        linkId,
        entityId: entity.entity_id,
        kind: input.execution.kind,
        targetId: input.execution.targetId,
        attempt,
        ...(input.execution.profileId ? { profileId: input.execution.profileId } : {}),
        ...(input.execution.branch ? { branch: input.execution.branch } : {}),
        ...(input.execution.repositoryId ? { repositoryId: input.execution.repositoryId } : {}),
        ...(input.execution.baseCommitObjectId ?? open?.base_commit
          ? { baseCommitObjectId: (input.execution.baseCommitObjectId ?? open?.base_commit) as string }
          : {}),
        startedAt: open?.started_at ?? input.execution.startedAt ?? now,
        ...(ending ? { endedAt: input.execution.endedAt ?? now } : {}),
        ...(input.execution.outcome ? { outcome: input.execution.outcome } : {}),
        createdBy: input.origin.actor,
        ...(repositories ? { repositories: [...repositories] } : {}),
      };
      if (open) {
        this.statement(
          "UPDATE execution_links SET profile_id = COALESCE(?, profile_id), branch = COALESCE(?, branch), " +
            "repository_id = COALESCE(?, repository_id), base_commit = COALESCE(?, base_commit), ended_at = ?, outcome = ?, " +
            // The checkpoint namespace an attempt was recorded under is its
            // identity, not a field a later call may re-point: a second
            // session's key must never end up on this session's row (F2).
            "repositories_json = COALESCE(?, repositories_json), checkpoint_key = COALESCE(checkpoint_key, ?) WHERE link_id = ?",
        ).run(
          link.profileId ?? null,
          link.branch ?? null,
          link.repositoryId ?? null,
          link.baseCommitObjectId ?? null,
          link.endedAt ?? null,
          link.outcome ?? null,
          input.repositories ? JSON.stringify(input.repositories) : null,
          input.checkpointKey ?? null,
          linkId,
        );
        this.chargeRow("execution_links", input.projectId, "link_id = ?", [linkId]);
      } else {
        this.statement(
          "INSERT INTO execution_links (link_id, project_id, entity_id, kind, target_id, attempt, profile_id, branch, repository_id, base_commit, started_at, ended_at, outcome, created_by_json, repositories_json, checkpoint_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          linkId,
          input.projectId,
          entity.entity_id,
          link.kind,
          link.targetId,
          attempt,
          link.profileId ?? null,
          link.branch ?? null,
          link.repositoryId ?? null,
          link.baseCommitObjectId ?? null,
          link.startedAt,
          link.endedAt ?? null,
          link.outcome ?? null,
          JSON.stringify(input.origin.actor),
          repositories ? JSON.stringify(repositories) : null,
          input.checkpointKey ?? null,
        );
        this.chargeRow("execution_links", input.projectId, "link_id = ?", [linkId], true);
      }
      // An attempt that ended is evidence and nothing else. The Task's state
      // is untouched here, on purpose: no run, however it finished, completes
      // a Task (leap, "Plan and Project Task contract").
      const attemptEvidence =
        ending
          ? this.insertEvidence({
              projectId: input.projectId,
              entityId: entity.entity_id,
              revisionId: entity.current_revision_id,
              kind: "command_output",
              role: "supporting",
              summary: `Attempt ${attempt} ended: ${link.outcome ?? "finished"}.`,
              // What the attempt changed, from git and from nowhere else
              // (M21-T18): the checkpoints it made and the files between the
              // first and the last of them. A model's account of its own work
              // is not what this sentence is made of.
              detail: [`${link.kind} ${link.targetId}`, ...changeSummary(link.repositories ?? [])].join(" · "),
              outcome: link.outcome === "completed" ? "passed" : link.outcome === "failed" ? "failed" : "inconclusive",
              at: now,
              origin: input.origin,
            })
          : undefined;
      this.statement("UPDATE entities SET updated_at = ? WHERE entity_id = ?").run(now, entity.entity_id);
      this.touchEntity(input.projectId, entity.entity_id);
      const updated = this.entityRow(input.projectId, input.entityId);
      const seq = this.raise(input.projectId, {
        change: "execution",
        entityId: entity.entity_id,
        entityKind: "task",
        key: entity.key,
        title: updated.title,
        state: updated.state as ProjectWorkState,
        at: now,
        actorLabel: input.origin.actor.label,
        ...(input.origin.sessionId ? { sessionId: input.origin.sessionId } : {}),
      });
      // Before another attempt writes: who else is working in these files.
      const conflicts = this.engine.conflicts(input.projectId, this.toEngineEntity(updated));
      return {
        link,
        entity: this.toEntity(updated),
        seq,
        ...(attemptEvidence ? { attemptEvidence } : {}),
        ...(conflicts.length > 0 ? { conflicts } : {}),
      };
    });
  }

  // --------------------------------------------------------------- staleness

  /**
   * Mark what a material change to an approved artifact made stale.
   *
   * Runs inside the revising transaction, over the edges that exist. A Task is
   * not marked stale — a Task has no such state — but a stale Plan or Design
   * upstream of it is what `taskFacts` reads when it refuses a start.
   */
  private applyStale(projectId: string, changedEntityId: string, priorState: ProjectWorkState, at: string): Set<string> {
    if (priorState !== "approved") return new Set<string>();
    const entities = this.statement("SELECT entity_id, kind, key, state FROM entities WHERE project_id = ?").all(projectId) as Array<{
      entity_id: string;
      kind: string;
      key: string;
      state: string;
    }>;
    const edges = this.statement("SELECT link_id, relation, subject_entity, object_entity FROM edges WHERE project_id = ?").all(projectId) as Array<{
      link_id: string;
      relation: string;
      subject_entity: string;
      object_entity: string;
    }>;
    const graphEntities: StaleGraphEntity[] = entities.map((row) => ({
      entityId: row.entity_id,
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      state: row.state as ProjectWorkState,
    }));
    const graphEdges: StaleGraphEdge[] = edges.map((row) => ({
      linkId: row.link_id,
      relation: row.relation as StaleGraphEdge["relation"],
      subject: { entityId: row.subject_entity },
      object: { entityId: row.object_entity },
    }));
    const changed = this.entityRow(projectId, changedEntityId);
    const result = propagateStale({ changed: { entityId: changedEntityId, state: priorState }, entities: graphEntities, edges: graphEdges });
    for (const impact of result.stale) {
      const cause = {
        upstreamEntityId: changedEntityId,
        upstreamKey: changed.key,
        upstreamRevisionId: changed.current_revision_id,
        relation: impact.relation,
        at,
      };
      this.statement("UPDATE entities SET state = 'stale', stale_json = ?, needs_attention = 1, updated_at = ? WHERE entity_id = ?").run(
        JSON.stringify(cause),
        at,
        impact.entityId,
      );
      this.touchEntity(projectId, impact.entityId);
      const row = this.entityRow(projectId, impact.entityId);
      this.raise(projectId, {
        change: "stale",
        entityId: impact.entityId,
        entityKind: impact.kind,
        key: impact.key,
        title: row.title,
        state: "stale",
        at,
      });
    }
    for (const paused of result.paused) {
      // A paused Task keeps its state — it is the upstream that is stale — but
      // it is something waiting on a person, so it joins the queue.
      this.statement("UPDATE entities SET needs_attention = 1, updated_at = ? WHERE entity_id = ?").run(at, paused.entityId);
      this.touchEntity(projectId, paused.entityId);
    }
    return new Set<string>([...result.stale, ...result.paused].map((impact) => impact.entityId));
  }

  /**
   * Invalidate the gates a material change reached (M21-T8, D-332).
   *
   * Two ways a decision stops meaning what it said, and no third:
   *
   * - it **covers** the revision that just changed, so the digest set it
   *   records is no longer what the project holds;
   * - it belongs to an artifact the change made **stale**, which is exactly
   *   the reachable downstream `propagateStale` returns — never the whole
   *   project, and never an artifact with no link to the change (D-352).
   *
   * A revision whose bytes are identical invalidates nothing: the digest is
   * the test of "material", not the fact that someone pressed save.
   */
  private invalidateApprovals(
    projectId: string,
    changedEntityId: string,
    change: { previousDigest: string; digest: string; reached: ReadonlySet<string> },
    at: string,
  ): string[] {
    if (change.digest === change.previousDigest) return [];
    const rows = this.statement(
      "SELECT approval_id, entity_id, covers_json FROM approvals WHERE project_id = ? AND invalidated_at IS NULL",
    ).all(projectId) as Array<{ approval_id: string; entity_id: string; covers_json: string }>;
    const invalidated: string[] = [];
    for (const row of rows) {
      const covers = JSON.parse(row.covers_json) as ApprovedRevision[];
      const coversChanged = covers.some((covered) => covered.entityId === changedEntityId && covered.digest !== change.digest);
      if (!coversChanged && !change.reached.has(row.entity_id)) continue;
      this.statement("UPDATE approvals SET invalidated_at = ? WHERE approval_id = ?").run(at, row.approval_id);
      this.chargeRow("approvals", projectId, "approval_id = ?", [row.approval_id]);
      invalidated.push(row.approval_id);
    }
    return invalidated;
  }

  // ----------------------------------------------------------------- blobs

  /** Store bytes for this project and return the handle to read them back. */
  putBlob(input: { projectId: string; entityId?: string | undefined; mediaType: string; data: Uint8Array }): StoredBlob {
    return this.write(() => {
      const stored = putBlob(this.db, { ...input, now: this.now() });
      // The row's own metadata is charged as well as its payload, and the
      // payload only on the insert that really stored it: the same capture
      // stored twice still costs one copy (D-365).
      if (stored.inserted) this.chargeRow("blobs", input.projectId, "blob_id = ?", [stored.blobId], true);
      return stored;
    });
  }

  /** A ranged read. `undefined` when this project has no such blob. */
  readBlob(input: { projectId: string; blobId: string; offset?: number | undefined; limit?: number | undefined }): BlobRange | undefined {
    return readBlobRange(this.db, {
      projectId: input.projectId,
      blobId: input.blobId,
      offset: input.offset ?? 0,
      limit: input.limit ?? 512 * 1024,
    });
  }

  /** Bytes this project's blobs cost. */
  blobBytes(projectId: string): number {
    return blobBytes(this.db, projectId);
  }

  /**
   * Let go of a **derived** blob's bytes, keeping its row, its size and the
   * reason it went (M21-T4).
   *
   * This is the only thing a budget may ever reclaim: a preview, a rendered
   * capture, a cached export. A read of a released blob is answered with that
   * label and its original size, never with empty bytes pretending to be the
   * content (leap, "Security, privacy and resource rules"). Canonical
   * revisions, comments and approvals have no such path — a full budget
   * refuses the write instead.
   */
  releaseDerived(input: { projectId: string; blobId: string; reason: "quota" | "retention" | "migration"; detail: string }): number {
    return this.write(() => {
      const freed = releaseBlob(this.db, input.projectId, input.blobId, { reason: input.reason, detail: input.detail });
      // The row stays, and so does its metadata charge; what comes back is the
      // payload it let go, minus the label it now carries saying so.
      if (freed > 0) this.chargeRow("blobs", input.projectId, "blob_id = ?", [input.blobId]);
      return freed;
    });
  }

  // ----------------------------------------------------------------- reads

  /** One page of the project's backlog, or everything after `sinceSeq`. */
  list(query: ProjectWorkListQuery): ProjectWorkListPage {
    const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
    const seq = this.seq(query.projectId);
    const filters: string[] = ["project_id = ?"];
    const params: unknown[] = [query.projectId];
    if (query.kinds && query.kinds.length > 0) {
      filters.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
      params.push(...query.kinds);
    }
    if (query.states && query.states.length > 0) {
      filters.push(`state IN (${query.states.map(() => "?").join(",")})`);
      params.push(...query.states);
    }
    if (query.needsYou === true) filters.push("needs_attention = 1");
    if (query.includeArchived !== true) filters.push("archived_at IS NULL");
    if (query.updatedSince) {
      filters.push("updated_at > ?");
      params.push(query.updatedSince);
    }
    let removed: string[] | undefined;
    let reset = false;
    if (query.sinceSeq !== undefined) {
      const since = this.eventsSince(query.projectId, query.sinceSeq);
      reset = since.reset;
      if (!reset) {
        const touched = new Set<string>();
        const gone = new Set<string>();
        for (const event of since.events) {
          if (event.change.change === "deleted") gone.add(event.change.entityId);
          else touched.add(event.change.entityId);
        }
        removed = [...gone];
        if (touched.size === 0) {
          return { projectId: query.projectId, seq, items: [], counts: this.counts(query.projectId), ...(removed.length > 0 ? { removed } : {}) };
        }
        filters.push(`entity_id IN (${[...touched].map(() => "?").join(",")})`);
        params.push(...touched);
      }
    }
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        filters.push("(updated_seq < ? OR (updated_seq = ? AND entity_id < ?))");
        params.push(decoded.updatedSeq, decoded.updatedSeq, decoded.entityId);
      }
    }
    const rows = this.statement(
      `SELECT * FROM entities WHERE ${filters.join(" AND ")} ORDER BY updated_seq DESC, entity_id DESC LIMIT ?`,
    ).all(...params, limit + 1) as EntityRow[];
    const page = rows.slice(0, limit);
    const items = page
      .filter((row) => (query.hasLinks === undefined ? true : this.linkCounts(row).total > 0 === query.hasLinks))
      .map((row) => this.toListItem(row));
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(Number(last.updated_seq), last.entity_id) : undefined;
    return {
      projectId: query.projectId,
      seq,
      items,
      counts: this.counts(query.projectId),
      ...(nextCursor ? { nextCursor } : {}),
      ...(removed && removed.length > 0 ? { removed } : {}),
      ...(reset ? { reset: true } : {}),
    };
  }

  private linkCounts(row: EntityRow): { edges: number; repository: number; execution: number; total: number } {
    const edges = Number(
      (this.statement("SELECT COUNT(*) AS n FROM edges WHERE project_id = ? AND (subject_entity = ? OR object_entity = ?)").get(
        row.project_id,
        row.entity_id,
        row.entity_id,
      ) as { n: number }).n,
    );
    const repository = Number(
      (this.statement("SELECT COUNT(*) AS n FROM repository_links WHERE project_id = ? AND entity_id = ?").get(row.project_id, row.entity_id) as {
        n: number;
      }).n,
    );
    const execution = Number(
      (this.statement("SELECT COUNT(*) AS n FROM execution_links WHERE project_id = ? AND entity_id = ?").get(row.project_id, row.entity_id) as {
        n: number;
      }).n,
    );
    return { edges, repository, execution, total: edges + repository + execution };
  }

  private toListItem(row: EntityRow): ProjectWorkListItem {
    const counts = this.linkCounts(row);
    const stale = row.stale_json ? (JSON.parse(row.stale_json) as { upstreamKey: string }) : undefined;
    const item: ProjectWorkListItem = {
      ref: this.refOf(row),
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      title: row.title,
      state: row.state as ProjectWorkState,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      revisionCount: Number(row.revision_count),
      needsAttention: row.needs_attention === 1,
      blockingComments: Number(row.blocking_comments),
      ...(stale ? { staleBecauseKey: stale.upstreamKey } : {}),
      archived: row.archived_at !== null,
      linkCounts: { edges: counts.edges, repository: counts.repository, execution: counts.execution },
    };
    if (row.kind === "task") {
      const facts = this.engine.facts(row.project_id, this.toEngineEntity(row));
      return { ...item, unmetDependencies: facts.unmetDependencies };
    }
    return item;
  }

  private counts(projectId: string): ProjectWorkCounts {
    const rows = this.statement(
      "SELECT kind, COUNT(*) AS n, SUM(needs_attention) AS attention FROM entities WHERE project_id = ? AND archived_at IS NULL GROUP BY kind",
    ).all(projectId) as Array<{ kind: string; n: number; attention: number | null }>;
    const byKind = Object.fromEntries(PROJECT_WORK_KINDS.map((kind) => [kind, 0])) as Record<ProjectWorkKind, number>;
    let total = 0;
    let needsAttention = 0;
    for (const row of rows) {
      byKind[row.kind as ProjectWorkKind] = Number(row.n);
      total += Number(row.n);
      needsAttention += Number(row.attention ?? 0);
    }
    return { total, needsAttention, byKind };
  }

  /** What is waiting on a person in this project, newest first. */
  attention(projectId: string, limit = 50): { needsYou: number; items: ProjectWorkAttentionItem[]; truncated: boolean } {
    const total = Number(
      (this.statement("SELECT COUNT(*) AS n FROM entities WHERE project_id = ? AND needs_attention = 1 AND archived_at IS NULL").get(projectId) as {
        n: number;
      }).n,
    );
    const rows = this.statement(
      "SELECT * FROM entities WHERE project_id = ? AND needs_attention = 1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?",
    ).all(projectId, limit) as EntityRow[];
    const items: ProjectWorkAttentionItem[] = rows.map((row) => ({
      entityId: row.entity_id,
      kind: row.kind as ProjectWorkKind,
      key: row.key,
      title: row.title,
      // A blocked Task and a Task paused by a stale Plan are two different
      // things to a person, so the engine decides a Task's reason (M21-T15).
      reason:
        row.kind === "task"
          ? this.engine.taskAttentionReason(projectId, this.toEngineEntity(row))
          : Number(row.blocking_comments) > 0
            ? "blocking_comment"
            : row.state === "stale"
              ? "stale"
              : "gate",
      at: row.updated_at,
    }));
    return { needsYou: total, items, truncated: total > items.length };
  }

  /** One entity at one exact revision, with the related records asked for. */
  get(query: {
    projectId: string;
    entityId?: string | undefined;
    key?: string | undefined;
    revisionId?: string | undefined;
    body?: { mode: "full" | "none" | "range"; offset?: number | undefined; limit?: number | undefined } | undefined;
    include?:
      | { comments?: boolean | undefined; approvals?: boolean | undefined; evidence?: boolean | undefined; links?: boolean | undefined; history?: boolean | undefined }
      | undefined;
  }): ProjectWorkDetail {
    const entity = query.entityId
      ? this.entityRow(query.projectId, query.entityId)
      : this.entityRowByKey(query.projectId, query.key ?? "");
    const revision = this.revisionRow(query.projectId, query.revisionId ?? entity.current_revision_id);
    if (revision.entity_id !== entity.entity_id) throw new ProjectWorkRefusedError("That revision belongs to another item.");
    const truncated: string[] = [];
    const include = query.include ?? {};
    const wantsLinks = include.links !== false;
    const edges = wantsLinks ? this.readEdges(query.projectId, entity.entity_id, truncated) : [];
    const repositoryLinks = wantsLinks ? this.readRepositoryLinks(query.projectId, entity.entity_id, truncated) : [];
    const executionLinks = wantsLinks ? this.readExecutionLinks(query.projectId, entity.entity_id, truncated) : [];
    const comments = include.comments !== false ? this.readComments(query.projectId, entity.entity_id, truncated) : [];
    const approvals = include.approvals !== false ? this.readApprovals(query.projectId, entity.entity_id, truncated) : [];
    const evidence = include.evidence !== false ? this.readEvidence(query.projectId, entity.entity_id, truncated) : [];
    const decisions = include.evidence !== false ? this.readDecisions(query.projectId, entity.entity_id, truncated) : [];
    const history = include.history === true ? this.readHistory(query.projectId, entity.entity_id) : undefined;
    // Derived on every read, never stored: readiness follows the dependencies'
    // states, and a conflict is always on the answer rather than found later
    // by whoever wrote second (M21-T15).
    const engineEntity = this.toEngineEntity(entity);
    const readiness = entity.kind === "task" ? this.engine.readiness(query.projectId, engineEntity) : undefined;
    const conflicts = entity.kind === "task" ? this.engine.conflicts(query.projectId, engineEntity) : undefined;
    const planBody = entity.kind === "plan" ? (JSON.parse(revision.body) as ProjectWorkBody) : undefined;
    const planGraph =
      planBody?.kind === "plan" ? this.engine.planGraph(query.projectId, planBody.plan, entity.key) : undefined;
    // Where the three gates stand, for a Spec and for the Design or Plan a
    // Spec's gate is decided on. Absent for everything else: nothing ungated
    // waits on a gate (M21-T8, D-352).
    const gates = this.gateReport(query.projectId, entity.entity_id);
    return {
      ref: this.refOf(entity, revision),
      entity: this.toEntity(entity),
      revision: this.toRevision(revision),
      fence: { entityId: entity.entity_id, revisionId: revision.revision_id, digest: revision.digest, seq: this.seq(query.projectId) },
      ...(readiness ? { readiness } : {}),
      ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
      ...(planGraph ? { planGraph } : {}),
      ...(gates ? { gates } : {}),
      ...(query.body?.mode === "none" ? {} : { body: this.bodyPage(revision, query.body) }),
      edges,
      repositoryLinks,
      executionLinks,
      comments,
      approvals,
      evidence,
      decisions,
      ...(history ? { history } : {}),
      truncated,
    };
  }

  /**
   * A page of a revision's canonical body.
   *
   * `full` returns the parsed body as well, so a caller that asked for all of
   * it does not parse the same bytes twice. `range` hands back a UTF-8 slice
   * with `totalBytes` and `nextOffset`, cut on a character boundary.
   */
  private bodyPage(revision: RevisionRow, request?: { mode: "full" | "none" | "range"; offset?: number | undefined; limit?: number | undefined }): ProjectWorkBodyPage {
    const buffer = Buffer.from(revision.body, "utf8");
    const totalBytes = buffer.byteLength;
    if (!request || request.mode === "full") {
      return { encoding: "application/json", totalBytes, offset: 0, bytes: totalBytes, text: revision.body, body: JSON.parse(revision.body) as ProjectWorkBody };
    }
    const offset = Math.min(Math.max(0, request.offset ?? 0), totalBytes);
    let end = Math.min(totalBytes, offset + Math.max(1, request.limit ?? 64 * 1024));
    // Never cut a character in half.
    while (end > offset && end < totalBytes && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    const text = buffer.toString("utf8", offset, end);
    return {
      encoding: "application/json",
      totalBytes,
      offset,
      bytes: end - offset,
      ...(end < totalBytes ? { nextOffset: end } : {}),
      text,
      ...(offset === 0 && end === totalBytes ? { body: JSON.parse(revision.body) as ProjectWorkBody } : {}),
    };
  }

  private readEdges(projectId: string, entityId: string, truncated: string[]): ProjectWorkEdge[] {
    const rows = this.statement(
      `SELECT edges.*, s.kind AS subject_kind, s.key AS subject_key, o.kind AS object_kind, o.key AS object_key FROM edges
         JOIN entities s ON s.entity_id = edges.subject_entity
         JOIN entities o ON o.entity_id = edges.object_entity
        WHERE edges.project_id = ? AND (edges.subject_entity = ? OR edges.object_entity = ?)
        ORDER BY edges.created_at ASC LIMIT ?`,
    ).all(projectId, entityId, entityId, RELATED_MAX + 1) as Array<Record<string, string>>;
    if (rows.length > RELATED_MAX) truncated.push("edges");
    return rows.slice(0, RELATED_MAX).map((row) => ({
      projectId,
      linkId: row["link_id"] as string,
      relation: row["relation"] as ProjectWorkEdge["relation"],
      subject: {
        entityId: row["subject_entity"] as string,
        revisionId: row["subject_revision"] as string,
        kind: row["subject_kind"] as ProjectWorkKind,
        key: row["subject_key"] as string,
      },
      object: {
        entityId: row["object_entity"] as string,
        revisionId: row["object_revision"] as string,
        kind: row["object_kind"] as ProjectWorkKind,
        key: row["object_key"] as string,
      },
      createdAt: row["created_at"] as string,
      origin: JSON.parse(row["origin_json"] as string) as ProjectWorkOrigin,
      ...(row["note"] ? { note: row["note"] } : {}),
    }));
  }

  private readRepositoryLinks(projectId: string, entityId: string, truncated: string[]): RepositoryLink[] {
    const rows = this.statement(
      "SELECT * FROM repository_links WHERE project_id = ? AND entity_id = ? ORDER BY created_at ASC LIMIT ?",
    ).all(projectId, entityId, RELATED_MAX + 1) as Array<Record<string, unknown>>;
    if (rows.length > RELATED_MAX) truncated.push("repositoryLinks");
    return rows.slice(0, RELATED_MAX).map((row) => ({
      projectId,
      linkId: row["link_id"] as string,
      subject: JSON.parse(row["subject_json"] as string) as ProjectWorkRef,
      relation: row["relation"] as RepositoryLink["relation"],
      repositoryId: row["repository_id"] as string,
      target: JSON.parse(row["target_json"] as string) as RepositoryLink["target"],
      ...(row["published_path"] ? { publishedPath: row["published_path"] as string } : {}),
      createdBy: JSON.parse(row["created_by_json"] as string) as RepositoryLink["createdBy"],
      createdAt: row["created_at"] as string,
      ...(row["supersedes_link_id"] ? { supersedesLinkId: row["supersedes_link_id"] as string } : {}),
      ...(row["source_unavailable"] === 1 ? { sourceUnavailable: true } : {}),
      ...(row["capture_blob_id"] ? { captureBlobId: row["capture_blob_id"] as string } : {}),
      ...(row["execution_link_id"] ? { executionLinkId: row["execution_link_id"] as string } : {}),
      ...(row["display_json"] ? { display: JSON.parse(row["display_json"] as string) as RepositoryLinkContext } : {}),
      ...(row["acceptance_json"] ? { acceptance: JSON.parse(row["acceptance_json"] as string) as RepositoryLinkAcceptance } : {}),
    }));
  }

  /** Every repository link on one entity, unbounded, for the host's own rules. */
  repositoryLinksOf(projectId: string, entityId: string): RepositoryLink[] {
    return this.readRepositoryLinks(projectId, entityId, []);
  }

  private readExecutionLinks(projectId: string, entityId: string, truncated: string[]): ExecutionLink[] {
    const rows = this.statement(
      "SELECT * FROM execution_links WHERE project_id = ? AND entity_id = ? ORDER BY attempt ASC, started_at ASC LIMIT ?",
    ).all(projectId, entityId, RELATED_MAX + 1) as Array<Record<string, unknown>>;
    if (rows.length > RELATED_MAX) truncated.push("executionLinks");
    return rows.slice(0, RELATED_MAX).map((row) => ({
      projectId,
      linkId: row["link_id"] as string,
      entityId: row["entity_id"] as string,
      kind: row["kind"] as ExecutionLink["kind"],
      targetId: row["target_id"] as string,
      attempt: Number(row["attempt"]),
      ...(row["profile_id"] ? { profileId: row["profile_id"] as string } : {}),
      ...(row["branch"] ? { branch: row["branch"] as string } : {}),
      ...(row["repository_id"] ? { repositoryId: row["repository_id"] as string } : {}),
      ...(row["base_commit"] ? { baseCommitObjectId: row["base_commit"] as string } : {}),
      startedAt: row["started_at"] as string,
      ...(row["ended_at"] ? { endedAt: row["ended_at"] as string } : {}),
      ...(row["outcome"] ? { outcome: row["outcome"] as NonNullable<ExecutionLink["outcome"]> } : {}),
      ...(row["target_unavailable"] === 1 ? { targetUnavailable: true } : {}),
      createdBy: JSON.parse(row["created_by_json"] as string) as ExecutionLink["createdBy"],
      ...(row["repositories_json"]
        ? { repositories: JSON.parse(row["repositories_json"] as string) as AttemptRepositoryRecord[] }
        : {}),
    }));
  }

  /**
   * The attempt this session or run has open on this Task, if any (M21-T18).
   *
   * An attempt that has not ended is the one a closing call is closing, and
   * the one whose `startedAt` bounds the window its checkpoints are read from.
   */
  openAttemptFor(
    projectId: string,
    entityId: string,
    kind: ExecutionLink["kind"],
    targetId: string,
    checkpointKey?: string,
  ): ExecutionLink | undefined {
    const rows = this.statement(
      "SELECT link_id, checkpoint_key FROM execution_links WHERE project_id = ? AND entity_id = ? AND kind = ? AND target_id = ? AND ended_at IS NULL " +
        "ORDER BY attempt DESC",
    ).all(projectId, entityId, kind, targetId) as Array<{ link_id: string; checkpoint_key: string | null }>;
    // The caller's own conversation first, when it said which one it is: two
    // attempts of one target are otherwise told apart only by recency, and
    // recency is not identity (review F2).
    const mine = checkpointKey === undefined ? undefined : rows.find((row) => row.checkpoint_key === checkpointKey);
    const row = mine ?? (checkpointKey !== undefined && rows.some((entry) => entry.checkpoint_key !== null) ? undefined : rows[0]);
    return row ? this.executionLink(projectId, row.link_id) : undefined;
  }

  /** The checkpoint namespace an attempt's refs were read from, when known. */
  attemptCheckpointKey(projectId: string, linkId: string): string | undefined {
    const row = this.statement("SELECT checkpoint_key FROM execution_links WHERE project_id = ? AND link_id = ?").get(projectId, linkId) as
      | { checkpoint_key: string | null }
      | undefined;
    return row?.checkpoint_key ?? undefined;
  }

  /** One attempt by its link id, with what git said it did (M21-T18). */
  executionLink(projectId: string, linkId: string): ExecutionLink | undefined {
    const row = this.statement("SELECT entity_id FROM execution_links WHERE project_id = ? AND link_id = ?").get(projectId, linkId) as
      | { entity_id: string }
      | undefined;
    if (!row) return undefined;
    return this.readExecutionLinks(projectId, row.entity_id, []).find((link) => link.linkId === linkId);
  }

  private readComments(projectId: string, entityId: string, truncated: string[]): ProjectWorkComment[] {
    const rows = this.statement("SELECT comment_id FROM comments WHERE project_id = ? AND entity_id = ? ORDER BY created_at ASC LIMIT ?").all(
      projectId,
      entityId,
      RELATED_MAX + 1,
    ) as Array<{ comment_id: string }>;
    if (rows.length > RELATED_MAX) truncated.push("comments");
    return rows.slice(0, RELATED_MAX).map((row) => this.readComment(projectId, row.comment_id));
  }

  private readApprovals(projectId: string, entityId: string, truncated: string[]): ProjectWorkApproval[] {
    const rows = this.statement("SELECT approval_id FROM approvals WHERE project_id = ? AND entity_id = ? ORDER BY at ASC LIMIT ?").all(
      projectId,
      entityId,
      RELATED_MAX + 1,
    ) as Array<{ approval_id: string }>;
    if (rows.length > RELATED_MAX) truncated.push("approvals");
    return rows.slice(0, RELATED_MAX).map((row) => this.readApproval(projectId, row.approval_id));
  }

  private readEvidence(projectId: string, entityId: string, truncated: string[]): ProjectWorkEvidence[] {
    const rows = this.statement("SELECT * FROM evidence WHERE project_id = ? AND entity_id = ? ORDER BY at ASC LIMIT ?").all(
      projectId,
      entityId,
      RELATED_MAX + 1,
    ) as Array<Record<string, unknown>>;
    if (rows.length > RELATED_MAX) truncated.push("evidence");
    return rows.slice(0, RELATED_MAX).map((row) => ({
      projectId,
      evidenceId: row["evidence_id"] as string,
      entityId: row["entity_id"] as string,
      revisionId: row["revision_id"] as string,
      kind: row["kind"] as ProjectWorkEvidence["kind"],
      role: row["role"] as ProjectWorkEvidence["role"],
      summary: row["summary"] as string,
      ...(row["detail"] ? { detail: row["detail"] as string } : {}),
      ...(row["blob_id"] ? { blobId: row["blob_id"] as string } : {}),
      outcome: row["outcome"] as ProjectWorkEvidence["outcome"],
      at: row["at"] as string,
      origin: JSON.parse(row["origin_json"] as string) as ProjectWorkOrigin,
      ...(row["repository_link_id"] ? { repositoryLinkId: row["repository_link_id"] as string } : {}),
    }));
  }

  private readDecisions(projectId: string, entityId: string, truncated: string[]): ProjectWorkDecision[] {
    const rows = this.statement("SELECT * FROM decisions WHERE project_id = ? AND entity_id = ? ORDER BY at ASC LIMIT ?").all(
      projectId,
      entityId,
      RELATED_MAX + 1,
    ) as Array<Record<string, unknown>>;
    if (rows.length > RELATED_MAX) truncated.push("decisions");
    return rows.slice(0, RELATED_MAX).map((row) => ({
      projectId,
      decisionId: row["decision_id"] as string,
      entityId: row["entity_id"] as string,
      revisionId: row["revision_id"] as string,
      title: row["title"] as string,
      rationale: row["rationale"] as string,
      consequences: JSON.parse(row["consequences_json"] as string) as string[],
      at: row["at"] as string,
      origin: JSON.parse(row["origin_json"] as string) as ProjectWorkOrigin,
      ...(row["supersedes_decision_id"] ? { supersedesDecisionId: row["supersedes_decision_id"] as string } : {}),
    }));
  }

  private readHistory(projectId: string, entityId: string): ProjectWorkRevision[] {
    const rows = this.statement("SELECT * FROM revisions WHERE project_id = ? AND entity_id = ? ORDER BY idx DESC LIMIT ?").all(
      projectId,
      entityId,
      RELATED_MAX,
    ) as RevisionRow[];
    return rows.map((row) => this.toRevision(row));
  }

  /**
   * The value-only search projection.
   *
   * An exact key match always outranks a text match (D-355), then a title
   * match, then the body's projected values. Nothing binary, no digests, no
   * paths and no hidden metadata are searched or returned.
   */
  search(query: { projectId?: string | undefined; query: string; kinds?: readonly ProjectWorkKind[] | undefined; limit?: number | undefined }): {
    results: ProjectWorkSearchResult[];
    truncated: boolean;
  } {
    // Every projection is fenced to the revision it was built from, and a
    // stale one is rebuilt before anything is scored against it — never
    // served as if it were current (M21-T4).
    this.repairProjections(query.projectId);
    const limit = Math.min(Math.max(1, query.limit ?? 20), 100);
    const text = query.query.trim();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (query.projectId) {
      filters.push("s.project_id = ?");
      params.push(query.projectId);
    } else {
      // Work in a removed project stays readable by id but does not show up in
      // an open search: the person took it off their list.
      filters.push("p.removed_at IS NULL");
    }
    if (query.kinds && query.kinds.length > 0) {
      filters.push(`s.kind IN (${query.kinds.map(() => "?").join(",")})`);
      params.push(...query.kinds);
    }
    const like = `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    filters.push("(s.key = ? OR s.title LIKE ? ESCAPE '\\' OR s.values_text LIKE ? ESCAPE '\\')");
    params.push(text.toUpperCase(), like, like);
    const rows = this.statement(
      `SELECT s.*, e.state AS state, e.current_revision_id AS current_revision_id, e.current_digest AS current_digest, e.title AS entity_title
         FROM search_projection s
         JOIN entities e ON e.entity_id = s.entity_id
         JOIN projects p ON p.project_id = s.project_id
        WHERE ${filters.join(" AND ")}
        LIMIT ?`,
    ).all(...params, limit + 1) as Array<Record<string, string>>;
    const scored = rows.slice(0, limit + 1).map((row) => {
      const exactKey = row["key"] === text.toUpperCase();
      const titleMatch = (row["title"] ?? "").toLowerCase().includes(text.toLowerCase());
      const matches: ProjectWorkSearchResult["matches"] = [];
      if (exactKey) matches.push({ field: "key", snippet: row["key"] as string });
      if (titleMatch) matches.push({ field: "title", snippet: row["title"] as string });
      if (!exactKey && !titleMatch) matches.push({ field: "body", snippet: snippet(row["values_text"] ?? "", text) });
      const result: ProjectWorkSearchResult = {
        ref: {
          projectId: row["project_id"] as string,
          kind: row["kind"] as ProjectWorkKind,
          entityId: row["entity_id"] as string,
          revisionId: row["current_revision_id"] as string,
          digest: row["current_digest"] as string,
          label: row["entity_title"] as string,
          key: row["key"] as string,
        },
        kind: row["kind"] as ProjectWorkKind,
        key: row["key"] as string,
        title: row["entity_title"] as string,
        state: row["state"] as ProjectWorkState,
        score: exactKey ? 1000 : titleMatch ? 100 : 10,
        exactKey,
        matches,
      };
      return result;
    });
    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return { results: scored.slice(0, limit), truncated: rows.length > limit };
  }

  /**
   * Rebuild the search projections whose fence is behind their entity.
   *
   * A projection row names the revision it was built from. They agree after
   * every create and every revise, so this normally finds nothing; it exists
   * for the cases where they cannot: a migration that adds a projected field,
   * a row written by an older release, an entity whose projection was lost.
   * The repair is bounded per call, and an orphan projection — one whose
   * entity is gone — is dropped rather than searched.
   */
  private repairProjections(projectId?: string): number {
    const where = projectId ? "s.project_id = ?" : "1 = 1";
    const params: unknown[] = projectId ? [projectId] : [];
    const stale = this.statement(
      `SELECT s.entity_id AS entity_id, s.project_id AS project_id, e.entity_id AS live
         FROM search_projection s
         LEFT JOIN entities e ON e.entity_id = s.entity_id AND e.current_revision_id = s.revision_id
        WHERE ${where} AND e.entity_id IS NULL
        LIMIT ?`,
    ).all(...params, PROJECTION_REPAIR_MAX) as Array<{ entity_id: string; project_id: string; live: string | null }>;
    if (stale.length === 0) return 0;
    return this.write(() => {
      let repaired = 0;
      for (const row of stale) {
        const entity = this.statement("SELECT * FROM entities WHERE entity_id = ?").get(row.entity_id) as EntityRow | undefined;
        if (!entity) {
          this.statement("DELETE FROM search_projection WHERE entity_id = ?").run(row.entity_id);
          repaired += 1;
          continue;
        }
        const revision = this.statement("SELECT * FROM revisions WHERE revision_id = ?").get(entity.current_revision_id) as RevisionRow | undefined;
        if (!revision) {
          // Nothing to rebuild it from. Text that cannot be fenced to a stored
          // revision is not searched at all.
          this.statement("DELETE FROM search_projection WHERE entity_id = ?").run(row.entity_id);
          repaired += 1;
          continue;
        }
        this.writeSearchProjection(entity, revision.revision_id, JSON.parse(revision.body) as ProjectWorkBody);
        repaired += 1;
      }
      return repaired;
    });
  }

  /** What one entity's search projection was built from, for the fence tests. */
  projectionFence(projectId: string, entityId: string): { revisionId: string; current: boolean } | undefined {
    const row = this.statement(
      `SELECT s.revision_id AS revision_id, e.current_revision_id AS current_revision_id
         FROM search_projection s JOIN entities e ON e.entity_id = s.entity_id
        WHERE s.project_id = ? AND s.entity_id = ?`,
    ).get(projectId, entityId) as { revision_id: string; current_revision_id: string } | undefined;
    if (!row) return undefined;
    return { revisionId: row.revision_id, current: row.revision_id === row.current_revision_id };
  }

  // ------------------------------------------------------------- integrity

  /**
   * Is this database sound?
   *
   * SQLite's own check, plus the three invariants this store adds: every
   * entity's current revision exists, every revision belongs to an entity that
   * exists, and every key is unique within its project.
   */
  integrityCheck(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const rows = this.db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const value = Object.values(row)[0];
      if (typeof value === "string" && value !== "ok") problems.push(`database: ${value}`);
    }
    const danglingCurrent = this.db
      .prepare("SELECT COUNT(*) AS n FROM entities e WHERE NOT EXISTS (SELECT 1 FROM revisions r WHERE r.revision_id = e.current_revision_id)")
      .get() as { n: number };
    if (Number(danglingCurrent.n) > 0) problems.push(`${danglingCurrent.n} item(s) point at a revision that is not stored.`);
    const orphanRevisions = this.db
      .prepare("SELECT COUNT(*) AS n FROM revisions r WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.entity_id = r.entity_id)")
      .get() as { n: number };
    if (Number(orphanRevisions.n) > 0) problems.push(`${orphanRevisions.n} revision(s) belong to an item that is gone.`);
    const duplicateKeys = this.db
      .prepare("SELECT COUNT(*) AS n FROM (SELECT project_id, key FROM entities GROUP BY project_id, key HAVING COUNT(*) > 1)")
      .get() as { n: number };
    if (Number(duplicateKeys.n) > 0) problems.push(`${duplicateKeys.n} key(s) are used twice in one project.`);
    return { ok: problems.length === 0, problems };
  }

  /** The canonical bytes of one revision, for an export or a digest check. */
  canonicalBody(projectId: string, revisionId: string): string {
    return this.revisionRow(projectId, revisionId).body;
  }

  /** Re-digest a revision's stored bytes. Used by the integrity surfaces. */
  verifyRevisionDigest(projectId: string, revisionId: string): boolean {
    const row = this.revisionRow(projectId, revisionId);
    return bodyDigest(JSON.parse(row.body)).digest === row.digest;
  }

  /** The states a kind may hold, for a client that validates before it writes. */
  statesFor(kind: ProjectWorkKind): readonly ProjectWorkState[] {
    return statesForKind(kind);
  }

  /** The canonical JSON of any value, so callers digest exactly what we store. */
  static canonical(value: unknown): string {
    return canonicalJson(value);
  }
}

/** `?` for each id, so a scoped `IN (…)` is always parameterised. */
function placeholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(",");
}

/**
 * Where an association page stopped: the link, and the sequence inside it.
 *
 * Plain rather than encoded, and parsed strictly: ids are base64url and hold
 * no colon, so the last one separates the two halves and anything else is not
 * a cursor this host minted.
 */
function associationCursor(cursor: string): { linkId: string; seq: number } | undefined {
  const at = cursor.lastIndexOf(":");
  if (at <= 0) return undefined;
  const seq = Number.parseInt(cursor.slice(at + 1), 10);
  if (!Number.isSafeInteger(seq)) return undefined;
  return { linkId: cursor.slice(0, at), seq };
}

/** Where a binding page stopped: the decision, and the link inside it. */
function decisionCursor(cursor: string): { decisionId: string; linkId: string } | undefined {
  const at = cursor.lastIndexOf(":");
  if (at <= 0) return undefined;
  return { decisionId: cursor.slice(0, at), linkId: cursor.slice(at + 1) };
}

function encodeCursor(updatedSeq: number, entityId: string): string {
  return Buffer.from(`${updatedSeq}|${entityId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedSeq: number; entityId: string } | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const at = decoded.lastIndexOf("|");
    if (at <= 0) return undefined;
    const updatedSeq = Number.parseInt(decoded.slice(0, at), 10);
    if (!Number.isSafeInteger(updatedSeq)) return undefined;
    return { updatedSeq, entityId: decoded.slice(at + 1) };
  } catch {
    return undefined;
  }
}

/** A bounded window of a projected value around the match. Never the whole body. */
function snippet(values: string, query: string): string {
  const at = values.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return values.slice(0, 160);
  const from = Math.max(0, at - 60);
  return values.slice(from, from + 160);
}
