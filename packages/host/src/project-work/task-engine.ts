/**
 * The Plan DAG and Project Task engine (M21-T15).
 *
 * The store owns storage; this owns the rules that turn stored rows into the
 * answers the leap's "Plan and Project Task contract" requires:
 *
 * - **A Plan's Task graph is validated before it is written.** A cycle is
 *   refused with the keys it goes round, a key this project never minted is
 *   refused, and a dependency pointing at a Task the Plan stopped listing is
 *   refused. Dropping a Task from a Plan is allowed and **recorded** as an
 *   orphan, because a person may reshape a Plan and must not lose sight of the
 *   work that fell out of it.
 * - **Readiness is derived, never stored.** A Task is ready exactly when every
 *   declared dependency is satisfied; the unmet ones are named by key on every
 *   read and in every refusal (D-355), and a dependency reaching `done` moves
 *   the Tasks waiting on it from `blocked` to `ready` — and back, when a
 *   dependency is reopened.
 * - **A stale upstream pauses, it does not fail.** A stale Plan or Design
 *   stops a not-yet-started Task from starting and stops any Task from
 *   reaching `done`; a running attempt is left alone. The refusal names the
 *   upstream by key, and the error carries its exact revision.
 * - **Scope conflicts are always on the answer.** Two active Tasks whose
 *   declared paths/packages — or whose recorded repository changes — overlap
 *   are reported on every read of either one and on every execution link, with
 *   whether a person accepted the shared-checkout risk.
 *
 * Everything here reads through {@link TaskEngineReader}: no SQL, no clock, no
 * transaction and no event. The store supplies the rows and applies whatever
 * the engine decides, which is what keeps these rules testable in one place.
 */
import {
  isActiveTaskState,
  overlappingScope,
  unmetTaskDependencies,
  validatePlanGraph,
  type EvidenceKind,
  type EvidenceRole,
  type PlanBody,
  type PlanGraphReport,
  type ProjectTaskBody,
  type ProjectTaskState,
  type ProjectWorkBody,
  type ProjectWorkKind,
  type ProjectWorkState,
  type StaleUpstreamRef,
  type TaskConflict,
  type TaskReadiness,
  type TaskScope,
} from "@lasercode/protocol";

/** One entity, as the engine needs it: identity, key, state and its revision. */
export interface EngineEntity {
  projectId: string;
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  currentRevisionId: string;
  blockingComments: number;
}

export interface EngineEvidence {
  evidenceId: string;
  kind: EvidenceKind;
  role: EvidenceRole;
  outcome: "passed" | "failed" | "inconclusive";
}

/** What the engine reads. Implemented by the store, and by nothing else. */
export interface TaskEngineReader {
  entity(projectId: string, entityId: string): EngineEntity | undefined;
  entityByKey(projectId: string, key: string): EngineEntity | undefined;
  /** Every entity of the project, for the Plan graph's existence checks. */
  allEntities(projectId: string): EngineEntity[];
  /** Tasks, optionally only those in the given states. */
  tasks(projectId: string, states?: readonly ProjectWorkState[]): EngineEntity[];
  /** The parsed body of an entity's current revision. */
  body(projectId: string, entityId: string): ProjectWorkBody | undefined;
  evidence(projectId: string, entityId: string): EngineEvidence[];
  /** The entities this one points at through an edge: its upstreams. */
  upstream(projectId: string, entityId: string): EngineEntity[];
  /** Repository-relative paths recorded on this entity's repository links. */
  repositoryPaths(projectId: string, entityId: string): string[];
}

/** What a Task transition needs to know, all of it read from the store. */
export interface TaskFacts {
  unmetDependencies: string[];
  hasAcceptanceEvidence: boolean;
  hasPassingVerification: boolean;
  planStale: boolean;
  designStale: boolean;
  staleUpstream?: StaleUpstreamRef;
}

/** One state change the graph implies, for the store to apply. */
export interface CascadeIntent {
  entityId: string;
  key: string;
  from: ProjectTaskState;
  to: ProjectTaskState;
}

/** The Task states a dependency's move may change on its own. */
const CASCADE_STATES: readonly ProjectWorkState[] = ["ready", "blocked"];

export class TaskEngine {
  private readonly reader: TaskEngineReader;

  constructor(reader: TaskEngineReader) {
    this.reader = reader;
  }

  // ------------------------------------------------------------------- tasks

  /** The Task body of an entity, or `undefined` when it is not a Task. */
  taskBody(projectId: string, entityId: string): ProjectTaskBody | undefined {
    const body = this.reader.body(projectId, entityId);
    return body?.kind === "task" ? body.task : undefined;
  }

  /**
   * Everything a transition rests on.
   *
   * `evidenceId` narrows the acceptance check to one record, which is what a
   * completion that names its evidence asks for.
   */
  facts(projectId: string, task: EngineEntity, evidenceId?: string): TaskFacts {
    const body = this.taskBody(projectId, task.entityId);
    const dependencies = body?.dependencies ?? [];
    const states = new Map<string, { kind: ProjectWorkKind; state: ProjectWorkState }>();
    for (const key of dependencies) {
      const found = this.reader.entityByKey(projectId, key);
      if (found) states.set(key, { kind: found.kind, state: found.state });
    }
    const evidence = this.reader.evidence(projectId, task.entityId);
    const hasAcceptanceEvidence = evidence.some(
      (record) =>
        record.role === "acceptance" && record.outcome === "passed" && (evidenceId === undefined || record.evidenceId === evidenceId),
    );
    const upstream = this.reader.upstream(projectId, task.entityId);
    const stalePlan = upstream.find((row) => row.kind === "plan" && row.state === "stale");
    const staleDesign = upstream.find((row) => row.kind === "design" && row.state === "stale");
    const staleUpstream = stalePlan ?? staleDesign;
    return {
      unmetDependencies: unmetTaskDependencies(dependencies, states),
      hasAcceptanceEvidence,
      hasPassingVerification: evidence.some((record) => record.outcome === "passed"),
      planStale: stalePlan !== undefined,
      designStale: staleDesign !== undefined,
      ...(staleUpstream
        ? {
            staleUpstream: {
              entityId: staleUpstream.entityId,
              kind: staleUpstream.kind,
              key: staleUpstream.key,
              revisionId: staleUpstream.currentRevisionId,
            } satisfies StaleUpstreamRef,
          }
        : {}),
    };
  }

  /** The derived readiness of one Task, as every read of it reports it. */
  readiness(projectId: string, task: EngineEntity): TaskReadiness {
    const facts = this.facts(projectId, task);
    return {
      ready: facts.unmetDependencies.length === 0,
      unmetDependencies: facts.unmetDependencies,
      ...(facts.staleUpstream ? { stalePausedBy: facts.staleUpstream } : {}),
      hasAcceptanceEvidence: facts.hasAcceptanceEvidence,
      hasPassingVerification: facts.hasPassingVerification,
      blockingComments: task.blockingComments,
    };
  }

  /**
   * What the dependency graph implies after one entity's state moved.
   *
   * A Task waiting on it becomes `ready` when nothing is unmet any more, and a
   * `ready` Task goes back to `blocked` when its dependency was reopened.
   * Nothing else moves: a Task somebody is working on, has sent for review,
   * finished or cancelled is a person's business, not the graph's.
   */
  cascade(projectId: string, changed: { keys?: readonly string[]; entityIds?: readonly string[] }): CascadeIntent[] {
    const keys = new Set(changed.keys ?? []);
    const entityIds = new Set(changed.entityIds ?? []);
    if (keys.size === 0 && entityIds.size === 0) return [];
    const intents: CascadeIntent[] = [];
    for (const candidate of this.reader.tasks(projectId, CASCADE_STATES)) {
      const body = this.taskBody(projectId, candidate.entityId);
      if (!body) continue;
      if (!entityIds.has(candidate.entityId) && !body.dependencies.some((key) => keys.has(key))) continue;
      const facts = this.facts(projectId, candidate);
      const from = candidate.state as ProjectTaskState;
      if (from === "ready" && facts.unmetDependencies.length > 0) {
        intents.push({ entityId: candidate.entityId, key: candidate.key, from, to: "blocked" });
        continue;
      }
      if (from === "blocked" && facts.unmetDependencies.length === 0) {
        intents.push({ entityId: candidate.entityId, key: candidate.key, from, to: "ready" });
      }
    }
    return intents;
  }

  // --------------------------------------------------------------- conflicts

  /**
   * The other active Tasks that write where this one does.
   *
   * Declared scope is what the Task says (`scope.packages`, `scope.paths`);
   * observed scope is what its repository links recorded it actually touching.
   * A row marked `observed` overlaps only because of the second, which is the
   * case worth seeing: the Task did not say it would write there.
   */
  conflicts(projectId: string, task: EngineEntity): TaskConflict[] {
    const body = this.taskBody(projectId, task.entityId);
    if (!body) return [];
    if (!isActiveTaskState(task.state)) return [];
    const mineDeclared = declaredScope(body);
    const mineFull = withObserved(mineDeclared, this.reader.repositoryPaths(projectId, task.entityId));
    const accepts = new Set(body.scope.sharedWith ?? []);
    const conflicts: TaskConflict[] = [];
    for (const other of this.reader.tasks(projectId, ["ready", "in_progress", "needs_review"])) {
      if (other.entityId === task.entityId) continue;
      const otherBody = this.taskBody(projectId, other.entityId);
      if (!otherBody) continue;
      const theirDeclared = declaredScope(otherBody);
      const theirFull = withObserved(theirDeclared, this.reader.repositoryPaths(projectId, other.entityId));
      const full = overlappingScope(mineFull, theirFull);
      if (full.packages.length === 0 && full.paths.length === 0) continue;
      const declared = overlappingScope(mineDeclared, theirDeclared);
      conflicts.push({
        entityId: other.entityId,
        key: other.key,
        title: other.title,
        state: other.state as ProjectTaskState,
        overlap: full,
        observed: full.paths.length > declared.paths.length || full.packages.length > declared.packages.length,
        accepted: accepts.has(other.key) || (otherBody.scope.sharedWith ?? []).includes(task.key),
      });
    }
    return conflicts.sort((a, b) => a.key.localeCompare(b.key));
  }

  // -------------------------------------------------------------- plan graph

  /**
   * Validate one Plan body against the project, and report its orphans.
   *
   * `planKey` is absent while a Plan is being created — its key is allocated
   * inside the same write — and nothing can claim a Plan that does not exist
   * yet, so a create never has orphans.
   */
  planGraph(projectId: string, plan: PlanBody, planKey?: string): PlanGraphReport {
    const known = new Map<string, { kind: ProjectWorkKind; state: ProjectWorkState; entityId: string; title: string }>();
    for (const entity of this.reader.allEntities(projectId)) {
      known.set(entity.key, { kind: entity.kind, state: entity.state, entityId: entity.entityId, title: entity.title });
    }
    const claimed: string[] = [];
    if (planKey !== undefined) {
      for (const task of this.reader.tasks(projectId)) {
        const body = this.taskBody(projectId, task.entityId);
        if (body?.planKey === planKey) claimed.push(task.key);
      }
    }
    return validatePlanGraph({ phases: plan.phases, dependencies: plan.dependencies, known, claimed });
  }

  // --------------------------------------------------------------- attention

  /**
   * Why this Task is in the "needs you" queue.
   *
   * A blocked Task and a Task paused by a stale upstream are two different
   * things to a person: one is waiting on other work, the other is waiting on
   * a decision about an artifact that moved.
   */
  taskAttentionReason(projectId: string, task: EngineEntity): "blocking_comment" | "blocked_task" | "stale" | "gate" {
    if (task.blockingComments > 0) return "blocking_comment";
    if (task.state === "blocked") return "blocked_task";
    const upstream = this.reader.upstream(projectId, task.entityId);
    if (upstream.some((row) => (row.kind === "plan" || row.kind === "design") && row.state === "stale")) return "stale";
    return "gate";
  }
}

/** What a Task says it will write in. */
function declaredScope(body: ProjectTaskBody): TaskScope {
  return { packages: body.scope.packages, paths: body.scope.paths };
}

/** The declared scope plus the paths the Task's repository links recorded. */
function withObserved(scope: TaskScope, observed: readonly string[]): TaskScope {
  if (observed.length === 0) return scope;
  return { packages: scope.packages, paths: [...scope.paths, ...observed] };
}
