/**
 * The world the four lifecycle tools are evaluated in (M26-T3's recipe,
 * step 4; M21-T17).
 *
 * The lifecycle tools reach the host's own store over the worker bridge, and
 * an evaluation must not write into a person's real project work — so the one
 * substitution is the host: a small in-memory authority that answers the
 * bridge's sixteen methods the way the real one does for everything a fixture
 * exercises. It keeps revisions, refuses a stale `expectedRevisionId` with
 * the same typed conflict, replays an idempotency key, and refuses a write to
 * another project by naming the owner — because "the model recovered from the
 * refusal" is a measure, and a refusal that did not read like the real one
 * would prove nothing.
 *
 * Everything above it is real: the registered specs, the handlers, D-277's
 * label stripping and the `ToolError` every refusal travels in.
 */
import { createHash } from "node:crypto";
import {
  ErrorCodes,
  PROJECT_WORK_CONFLICT_CODE,
  ProtocolError,
  initialStateForKind,
  isRecord,
  projectWorkKey,
  type ClientRequests,
  type ProjectWorkBody,
  type ProjectWorkEntity,
  type ProjectWorkKind,
  type ProjectWorkOrigin,
  type ProjectWorkRef,
  type ProjectWorkMethod,
  type ProjectWorkRevision,
  type ProjectWorkState,
  type ResearchOperation,
  convergenceOf,
  verificationSummary,
  type ClientRequests as Requests,
  type VerificationBridgeResult,
  type VerificationCriterion,
  type VerificationEnvelope,
  type VerificationFinding,
  type VerificationPlan,
  type VerificationReport,
  type VerificationSourceRef,
} from "@lasercode/protocol";
import { projectWorkFailure, type ProjectWorkBridge, type ProjectWorkExecutionShape, type ProjectWorkSessionIdentity } from "../project-work/bridge.js";

/** One item of the fixture's project, as its world declares it. */
export interface ToolEvalProjectWorkItem {
  kind: ProjectWorkKind;
  title: string;
  /** The typed body, as the fixture wrote it. */
  body: ProjectWorkBody;
  state?: ProjectWorkState;
  /** Comments already on it: text, and whether they block a gate. */
  comments?: Array<{ text: string; blocking?: boolean }>;
}

const AT = "2026-01-01T09:00:00.000Z";
const PROJECT_ID = "prj_eval";
/** A second project, so a wrong-project write can be refused by name. */
const OTHER_PROJECT_ID = "prj_other";
const OTHER_PROJECT_NAME = "another project";

interface Stored {
  entity: ProjectWorkEntity;
  revisions: ProjectWorkRevision[];
  bodies: Map<string, ProjectWorkBody>;
  comments: Array<{ commentId: string; revisionId: string; text: string; blocking: boolean; state: "open" | "addressed" | "resolved"; anchor: unknown }>;
  evidence: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A scripted host authority, and the bridge the tools see in front of it. */
export class ScriptedProjectWorkWorld implements ProjectWorkBridge {
  private readonly items = new Map<string, Stored>();
  private readonly replay = new Map<string, unknown>();
  private readonly ordinals = new Map<ProjectWorkKind, number>();
  private seq = 0;
  private nextId = 1;
  /** Every call the tools made, for a test that wants to assert on them. */
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private research: { attention?: unknown; staleRefs: string[] } | undefined;

  constructor(
    private readonly options: {
      items?: ToolEvalProjectWorkItem[];
      /** False for a projectless chat: reads work, writes have nowhere to go. */
      hasProject?: boolean;
      identity?: ProjectWorkSessionIdentity;
      execution?: ProjectWorkExecutionShape;
      task?: { entityId: string; key: string };
    } = {},
  ) {
    for (const item of options.items ?? []) this.seed(item);
  }

  // --------------------------------------------------------------- the bridge

  projectId(): string | undefined {
    return this.options.hasProject === false ? undefined : PROJECT_ID;
  }

  identity(): ProjectWorkSessionIdentity {
    return this.options.identity ?? { label: "Evaluation run", sessionId: "ses_eval", runId: "run_eval" };
  }

  async execution(): Promise<ProjectWorkExecutionShape> {
    return this.options.execution ?? { workspace: "worktree", checkout: "<checkout>", branch: "agents/eval", baseCommitObjectId: "0123abc" };
  }

  task(): { entityId: string; key: string } | undefined {
    return this.options.task;
  }

  lastResearchResult(): { attention?: never; staleRefs: string[] } | undefined {
    return this.research as { attention?: never; staleRefs: string[] } | undefined;
  }

  /**
   * The verification plan, as the host derives it (M21-T19).
   *
   * The same shape and the same rule the real authority uses for what a
   * fixture exercises: the criteria come from the Task's own revision, the
   * commands are the ones it declared, and a run cannot add to either.
   */
  async verify(
    params: Requests["project/work/get"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "plan" }>,
  ): Promise<{ result: Requests["project/work/get"]["result"]; verify: VerificationBridgeResult }> {
    void envelope;
    const result = (await this.call("project/work/get", params)) as Requests["project/work/get"]["result"];
    const stored = this.items.get(result.entity.entityId)!;
    return { result, verify: { plan: this.planFor(stored) } };
  }

  /**
   * The report, evaluated here rather than taken from the caller: a verifier
   * hands back exit codes, and the authority decides what they mean.
   */
  async verifyReport(
    params: Requests["project/work/link"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "report" }>,
  ): Promise<{ result: Requests["project/work/link"]["result"]; verify: VerificationBridgeResult }> {
    const link = params.link as { entityId: string };
    const stored = this.items.get(link.entityId)!;
    const plan = this.planFor(stored);
    const runs = new Map(envelope.commands.map((run) => [run.command, run]));
    const findings: VerificationFinding[] = plan.criteria.map((criterion) => {
      if (criterion.kind === "review") {
        const blocking = (stored.entity.blockingComments ?? 0) > 0;
        return {
          criterionId: criterion.id,
          outcome: blocking ? ("failed" as const) : ("satisfied" as const),
          detail: blocking ? "A blocking comment is open." : "Nothing is open.",
          evidenceIds: [],
        };
      }
      const run = criterion.command ? runs.get(criterion.command) : undefined;
      if (!run) {
        return {
          criterionId: criterion.id,
          outcome: "needs_person" as const,
          detail: "No command decides this one.",
          evidenceIds: [],
          steps: ["Check it and record what you saw."],
        };
      }
      return {
        criterionId: criterion.id,
        outcome: run.status === "passed" ? ("satisfied" as const) : ("failed" as const),
        detail: `${run.command} exited ${String(run.exitCode ?? "without a code")}.`,
        evidenceIds: [],
        commands: [run.command],
      };
    });
    const convergence = convergenceOf({ criteria: plan.criteria, findings, blockers: plan.blockers });
    const withoutSummary: Omit<VerificationReport, "summary"> = {
      version: 1,
      runId: envelope.runId,
      task: plan.task,
      startedAt: envelope.startedAt,
      endedAt: envelope.endedAt,
      authorities: plan.authorities,
      criteria: plan.criteria,
      commands: envelope.commands,
      findings,
      deviations: (envelope.deviations ?? []).map((deviation) => ({ ...deviation, state: "proposed" as const })),
      blockers: plan.blockers,
      personDecisions: findings
        .filter((finding) => finding.outcome === "needs_person")
        .map((finding) => ({ criterionId: finding.criterionId, question: finding.detail, steps: finding.steps ?? [] })),
      converged: convergence.converged,
      outcome: convergence.outcome,
      truncated: [],
    };
    const report: VerificationReport = { ...withoutSummary, summary: verificationSummary(withoutSummary) };
    const evidence = {
      projectId: PROJECT_ID,
      evidenceId: `evd_${String(this.nextId++)}`,
      entityId: stored.entity.entityId,
      revisionId: stored.entity.currentRevisionId,
      kind: "verification",
      role: report.converged ? "acceptance" : "supporting",
      summary: `Verification: ${report.summary}`,
      outcome: report.converged ? "passed" : report.outcome === "failed" ? "failed" : "inconclusive",
      at: AT,
      origin: this.origin(),
    };
    stored.evidence.push(evidence);
    if (report.converged && stored.entity.state === "in_progress") {
      stored.entity = { ...stored.entity, state: "needs_review" };
    }
    this.seq += 1;
    return {
      result: { link: { type: "evidence", evidence } as never, seq: this.seq },
      verify: { report, evidenceId: evidence.evidenceId, blobId: "blb_eval", taskState: stored.entity.state },
    };
  }

  /** The criteria one Task declares: its acceptance, its commands, its reviews. */
  private planFor(stored: Stored): VerificationPlan {
    const body = stored.bodies.get(stored.entity.currentRevisionId)!;
    const task = body.kind === "task" ? body.task : undefined;
    const source: VerificationSourceRef = {
      authority: "task",
      entityId: stored.entity.entityId,
      kind: stored.entity.kind,
      key: stored.entity.key,
      revisionId: stored.entity.currentRevisionId,
      digest: stored.entity.currentDigest,
      title: stored.entity.title,
    };
    const criteria: VerificationCriterion[] = [];
    for (const item of task?.acceptance ?? []) {
      criteria.push({
        id: `task:${item.id}`,
        authority: "task",
        kind: "acceptance",
        text: item.text,
        required: true,
        machineVerifiable: item.machineVerifiable,
        source,
        ...(item.command !== undefined ? { command: item.command } : {}),
      });
    }
    (task?.verificationCommands ?? []).forEach((command, index) => {
      criteria.push({
        id: `task:command:${String(index)}`,
        authority: "task",
        kind: "command",
        text: `${command} passes.`,
        required: true,
        machineVerifiable: true,
        source,
        command,
      });
    });
    criteria.push({
      id: "task:review",
      authority: "task",
      kind: "review",
      text: "Nothing blocking is left on this task.",
      required: true,
      machineVerifiable: true,
      source,
    });
    return {
      task: source,
      authorities: [source],
      criteria,
      commands: task?.verificationCommands ?? [],
      blockers:
        (stored.entity.blockingComments ?? 0) > 0
          ? [{ kind: "blocking_comment" as const, detail: `${stored.entity.key} has a blocking comment nobody has resolved.`, key: stored.entity.key }]
          : [],
      truncated: [],
    };
  }

  async call<M extends ProjectWorkMethod>(
    method: M,
    params: ClientRequests[M]["params"],
    extras?: { research?: ResearchOperation; attempt?: { workspace: "worktree" | "shared"; checkout: string } },
  ): Promise<ClientRequests[M]["result"]> {
    void extras;
    this.calls.push({ method, params });
    const record = isRecord(params) ? (params as Record<string, unknown>) : {};
    const key = typeof record["idempotencyKey"] === "string" ? `${method}:${record["idempotencyKey"]}` : undefined;
    if (key && this.replay.has(key)) return this.replay.get(key) as ClientRequests[M]["result"];
    let answer: unknown;
    try {
      answer = this.route(method, record);
    } catch (error) {
      // The refusal a tool meets is the one the real bridge produces from the
      // host's error, so a fixture recovers from exactly what it would
      // recover from in the product.
      throw projectWorkFailure(error, method);
    }
    if (key) this.replay.set(key, answer);
    return answer as ClientRequests[M]["result"];
  }

  /** The entity a fixture's recorded call has to name. */
  entity(key: string): Stored | undefined {
    return [...this.items.values()].find((item) => item.entity.key === key);
  }

  // ---------------------------------------------------------------- the store

  private seed(item: ToolEvalProjectWorkItem): void {
    const created = this.create(item.kind, item.title, item.body, item.state);
    for (const comment of item.comments ?? []) {
      created.comments.push({
        commentId: `cmt_${String(this.nextId++)}`,
        revisionId: created.entity.currentRevisionId,
        text: comment.text,
        blocking: comment.blocking === true,
        state: "open",
        anchor: { target: "entity" },
      });
    }
    created.entity.blockingComments = created.comments.filter((comment) => comment.blocking && comment.state !== "resolved").length;
  }

  private create(kind: ProjectWorkKind, title: string, body: ProjectWorkBody, state?: ProjectWorkState): Stored {
    const ordinal = (this.ordinals.get(kind) ?? 0) + 1;
    this.ordinals.set(kind, ordinal);
    const entityId = `ent_${String(this.nextId++)}`;
    const revisionId = `rev_${String(this.nextId++)}`;
    const digest = digestOf(body);
    const entity: ProjectWorkEntity = {
      projectId: PROJECT_ID,
      entityId,
      kind,
      key: projectWorkKey(kind, ordinal),
      keyNumber: ordinal,
      title,
      state: state ?? initialStateForKind(kind),
      currentRevisionId: revisionId,
      currentDigest: digest,
      revisionCount: 1,
      createdAt: AT,
      updatedAt: AT,
    };
    const stored: Stored = {
      entity,
      revisions: [this.revision(entity, revisionId, digest, 1)],
      bodies: new Map([[revisionId, body]]),
      comments: [],
      evidence: [],
      executions: [],
    };
    this.items.set(entityId, stored);
    this.seq += 1;
    return stored;
  }

  private revision(stored: { entityId: string; kind: ProjectWorkKind; title: string; state: ProjectWorkState }, revisionId: string, digest: string, index: number): ProjectWorkRevision {
    return {
      projectId: PROJECT_ID,
      entityId: stored.entityId,
      revisionId,
      kind: stored.kind,
      index,
      title: stored.title,
      digest,
      bodyBytes: 0,
      createdAt: AT,
      origin: this.origin(),
      state: stored.state,
    };
  }

  private origin(): ProjectWorkOrigin {
    return { actor: { kind: "agent", label: this.identity().label } };
  }

  private refOf(stored: Stored): ProjectWorkRef {
    return {
      projectId: PROJECT_ID,
      kind: stored.entity.kind,
      entityId: stored.entity.entityId,
      revisionId: stored.entity.currentRevisionId,
      digest: stored.entity.currentDigest,
      label: stored.entity.title,
      key: stored.entity.key,
    };
  }

  private find(record: Record<string, unknown>): Stored {
    const entityId = record["entityId"];
    const key = record["key"];
    const found =
      typeof entityId === "string"
        ? this.items.get(entityId)
        : typeof key === "string"
          ? [...this.items.values()].find((item) => item.entity.key === key)
          : undefined;
    if (!found) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That is not something this project has. Call inspect_project_work with action list to see what it does.");
    }
    return found;
  }

  private fence(stored: Stored, record: Record<string, unknown>): void {
    const expected = record["expectedRevisionId"];
    if (typeof expected !== "string" || expected === stored.entity.currentRevisionId) return;
    throw new ProtocolError(
      PROJECT_WORK_CONFLICT_CODE,
      `${stored.entity.key} has moved on since you read it: you sent revision ${expected}, and it is now at ${stored.entity.currentRevisionId}.`,
      {
        conflict: "revision",
        current: this.refOf(stored),
        expectedRevisionId: expected,
      },
    );
  }

  /** A mutation aimed at another project, refused the way the host refuses it. */
  private fenceProject(method: string, record: Record<string, unknown>): void {
    const named = record["projectId"];
    if (typeof named !== "string" || named === PROJECT_ID) return;
    if (method.startsWith("project/work/get") || method === "project/work/list" || method === "project/work/search") return;
    throw new ProtocolError(
      ErrorCodes.InvalidParams,
      `That work belongs to ${OTHER_PROJECT_NAME}, and this session is working in a different project, so it cannot be changed from here. Open a session in ${OTHER_PROJECT_NAME} to work on it — reading it from here is fine.`,
      { refused: "wrong_project", owningProjectId: OTHER_PROJECT_ID, owningProjectName: OTHER_PROJECT_NAME, offer: "open_session" },
    );
  }

  private route(method: string, record: Record<string, unknown>): unknown {
    this.fenceProject(method, record);
    switch (method) {
      case "project/work/list": {
        const items = [...this.items.values()];
        return {
          projectId: PROJECT_ID,
          seq: this.seq,
          items: items.map((item) => ({
            ref: this.refOf(item),
            kind: item.entity.kind,
            key: item.entity.key,
            title: item.entity.title,
            state: item.entity.state,
            updatedAt: item.entity.updatedAt,
            createdAt: item.entity.createdAt,
            revisionCount: item.entity.revisionCount,
            needsAttention: (item.entity.blockingComments ?? 0) > 0,
            blockingComments: item.entity.blockingComments ?? 0,
            archived: false,
            linkCounts: { edges: 0, repository: 0, execution: item.executions.length },
          })),
          counts: {
            total: items.length,
            needsAttention: items.filter((item) => (item.entity.blockingComments ?? 0) > 0).length,
            byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 },
          },
        };
      }
      case "project/work/search": {
        const query = String(record["query"] ?? "").toLowerCase();
        const hits = [...this.items.values()].filter((item) => item.entity.title.toLowerCase().includes(query) || item.entity.key.toLowerCase() === query);
        return {
          results: hits.map((item) => ({
            ref: this.refOf(item),
            kind: item.entity.kind,
            key: item.entity.key,
            title: item.entity.title,
            state: item.entity.state,
            score: 1,
            exactKey: item.entity.key.toLowerCase() === query,
            matches: [{ field: "title", snippet: item.entity.title }],
          })),
          truncated: false,
        };
      }
      case "project/work/get": {
        const stored = this.find(record);
        const body = stored.bodies.get(stored.entity.currentRevisionId)!;
        const text = JSON.stringify(body);
        const wants = isRecord(record["body"]) ? (record["body"] as { mode?: string; offset?: number; limit?: number }) : { mode: "none" };
        const include = isRecord(record["include"]) ? (record["include"] as Record<string, boolean>) : {};
        const offset = wants.offset ?? 0;
        const limit = wants.limit ?? text.length;
        const slice = text.slice(offset, offset + limit);
        return {
          ref: this.refOf(stored),
          entity: stored.entity,
          revision: stored.revisions.at(-1)!,
          fence: { entityId: stored.entity.entityId, revisionId: stored.entity.currentRevisionId, digest: stored.entity.currentDigest, seq: this.seq },
          ...(wants.mode === "none"
            ? {}
            : {
                body: {
                  encoding: "application/json",
                  totalBytes: text.length,
                  offset,
                  bytes: slice.length,
                  text: slice,
                  ...(offset + slice.length < text.length ? { nextOffset: offset + slice.length } : {}),
                  ...(wants.mode === "full" ? { body } : {}),
                },
              }),
          edges: [],
          repositoryLinks: [],
          executionLinks: stored.executions,
          comments: include["comments"] ? stored.comments.map((comment) => ({ ...comment, projectId: PROJECT_ID, entityId: stored.entity.entityId, createdAt: AT, origin: this.origin() })) : [],
          approvals: [],
          evidence: include["evidence"] ? stored.evidence : [],
          decisions: [],
          ...(stored.entity.kind === "task"
            ? {
                readiness: {
                  ready: stored.entity.state === "ready" || stored.entity.state === "in_progress",
                  unmetDependencies: [],
                  hasAcceptanceEvidence: stored.evidence.some((row) => row["role"] === "acceptance" && row["outcome"] === "passed"),
                  hasPassingVerification: stored.evidence.some((row) => row["outcome"] === "passed"),
                  blockingComments: stored.entity.blockingComments ?? 0,
                },
              }
            : {}),
          truncated: [],
        };
      }
      case "project/work/create": {
        const stored = this.create(record["kind"] as ProjectWorkKind, String(record["title"]), record["body"] as ProjectWorkBody);
        return { ref: this.refOf(stored), entity: stored.entity, revision: stored.revisions.at(-1)!, seq: this.seq };
      }
      case "project/work/revise": {
        const stored = this.find(record);
        this.fence(stored, record);
        const body = record["body"] as ProjectWorkBody;
        const revisionId = `rev_${String(this.nextId++)}`;
        const digest = digestOf(body);
        stored.bodies.set(revisionId, body);
        stored.entity = { ...stored.entity, currentRevisionId: revisionId, currentDigest: digest, revisionCount: stored.entity.revisionCount + 1, ...(typeof record["title"] === "string" ? { title: record["title"] } : {}) };
        stored.revisions.push(this.revision(stored.entity, revisionId, digest, stored.entity.revisionCount));
        this.seq += 1;
        return { ref: this.refOf(stored), entity: stored.entity, revision: stored.revisions.at(-1)!, seq: this.seq };
      }
      case "project/work/comment": {
        const stored = this.find(record);
        this.fence(stored, record);
        const comment = {
          commentId: `cmt_${String(this.nextId++)}`,
          revisionId: String(record["revisionId"] ?? stored.entity.currentRevisionId),
          text: String(record["text"] ?? ""),
          blocking: record["blocking"] === true,
          state: "open" as const,
          anchor: record["anchor"],
        };
        stored.comments.push(comment);
        stored.entity = { ...stored.entity, blockingComments: stored.comments.filter((entry) => entry.blocking && entry.state !== "resolved").length };
        this.seq += 1;
        return { comment: { ...comment, projectId: PROJECT_ID, entityId: stored.entity.entityId, createdAt: AT, origin: this.origin() }, entity: stored.entity, seq: this.seq };
      }
      case "project/work/resolve-comment": {
        const stored = this.find(record);
        this.fence(stored, record);
        const comment = stored.comments.find((entry) => entry.commentId === record["commentId"]);
        if (!comment) throw new ProtocolError(ErrorCodes.InvalidParams, "That comment is not on this item.");
        comment.state = "addressed";
        this.seq += 1;
        return { comment: { ...comment, projectId: PROJECT_ID, entityId: stored.entity.entityId, createdAt: AT, origin: this.origin() }, entity: stored.entity, seq: this.seq };
      }
      case "project/work/review": {
        const stored = this.find(record);
        this.fence(stored, record);
        stored.entity = { ...stored.entity, state: record["action"] === "request_review" ? "needs_review" : "draft" };
        this.seq += 1;
        return { entity: stored.entity, seq: this.seq };
      }
      case "project/work/link": {
        const link = record["link"] as Record<string, unknown>;
        const stored = this.find({ entityId: link["entityId"] });
        this.fence(stored, record);
        if (link["type"] !== "evidence") return { link: { type: "edge", edge: {} }, seq: ++this.seq };
        const evidence = {
          projectId: PROJECT_ID,
          evidenceId: `evd_${String(this.nextId++)}`,
          entityId: stored.entity.entityId,
          revisionId: stored.entity.currentRevisionId,
          kind: link["kind"],
          role: link["role"],
          summary: link["summary"],
          outcome: link["outcome"],
          at: AT,
          origin: this.origin(),
        };
        stored.evidence.push(evidence);
        this.seq += 1;
        return { link: { type: "evidence", evidence }, seq: this.seq };
      }
      case "project/task/action": {
        const stored = this.find(record);
        this.fence(stored, record);
        const from = stored.entity.state;
        const to = TASK_TARGET[String(record["action"])] ?? from;
        if (to === "done" && !stored.evidence.some((row) => row["role"] === "acceptance" && row["outcome"] === "passed")) {
          throw new ProtocolError(
            ErrorCodes.InvalidParams,
            `${stored.entity.key} cannot be marked done: nothing has been recorded as acceptance evidence that passed.`,
            { refused: "no_acceptance_evidence", next: "record acceptance evidence that passed, then complete the task naming it" },
          );
        }
        stored.entity = { ...stored.entity, state: to };
        this.seq += 1;
        return { entity: stored.entity, transition: { from, to }, seq: this.seq };
      }
      case "project/task/link-execution": {
        const stored = this.find(record);
        this.fence(stored, record);
        const execution = record["execution"] as Record<string, unknown>;
        const link = {
          projectId: PROJECT_ID,
          linkId: `exe_${String(this.nextId++)}`,
          entityId: stored.entity.entityId,
          kind: execution["kind"],
          targetId: execution["targetId"],
          attempt: stored.executions.length + 1,
          ...(execution["profileId"] !== undefined ? { profileId: execution["profileId"] } : {}),
          ...(execution["branch"] !== undefined ? { branch: execution["branch"] } : {}),
          ...(execution["baseCommitObjectId"] !== undefined ? { baseCommitObjectId: execution["baseCommitObjectId"] } : {}),
          startedAt: AT,
          ...(execution["endedAt"] !== undefined ? { endedAt: execution["endedAt"] } : {}),
          ...(execution["outcome"] !== undefined ? { outcome: execution["outcome"] } : {}),
          createdBy: this.origin().actor,
        };
        stored.executions.push(link);
        this.seq += 1;
        return { link, entity: stored.entity, seq: this.seq };
      }
      default:
        throw new ProtocolError(ErrorCodes.Unsupported, `This evaluation world does not answer ${method}.`);
    }
  }
}

const TASK_TARGET: Record<string, ProjectWorkState> = {
  mark_ready: "ready",
  block: "blocked",
  start: "in_progress",
  submit_for_review: "needs_review",
  request_changes: "in_progress",
  complete: "done",
  reopen: "in_progress",
  cancel: "cancelled",
  return_to_draft: "draft",
};
