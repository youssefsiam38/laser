/**
 * One session's door to the project lifecycle (M21-T17).
 *
 * Everything a model tool does to project work goes through here, and here
 * goes through the host: the authority is the host's store (leap, "Protocol
 * and authority"), this is a typed forwarder with the session's own identity
 * stamped on it. Nothing in this file writes a file, holds project state or
 * decides anything a person or the host is entitled to decide — the one
 * judgement it makes is which refusal a failure reads as, so a model gets the
 * contract's `{ code, message, committed, next }` instead of a wire error.
 */
import {
  ErrorCodes,
  PROJECT_WORK_BRIDGE_METHOD,
  PROJECT_WORK_CONFLICT_CODE,
  PROJECT_WORK_QUOTA_CODE,
  ProtocolError,
  isRecord,
  toolError,
  type ClientRequests,
  type ProjectWorkBridgeAttempt,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkMethod,
  type ResearchOperation,
  type ToolError,
  type VerificationBridgeResult,
  type VerificationEnvelope,
} from "@lasercode/protocol";

/** The link a worker has to its host. One method; the host answers it. */
export type ProjectWorkHostLink = (method: string, params: unknown) => Promise<unknown>;

/** Who is calling, as provenance. The host decides the authority. */
export interface ProjectWorkSessionIdentity {
  /** The agent label a write is recorded under. */
  label: string;
  /** The engine session this tool call happened in. */
  sessionId?: string;
  /** The agent run, when this session is one. */
  runId?: string;
}

/** What an implementation attempt is running in, as the worker knows it. */
export interface ProjectWorkExecutionShape {
  /** A worktree of its own, or the project's own checkout. */
  workspace: "worktree" | "shared";
  checkout: string;
  branch?: string;
  baseCommitObjectId?: string;
  /** The Model Profile the session runs on. Intent, never a raw model name. */
  profileId?: string;
  /**
   * The session file this attempt runs in (M21-T18).
   *
   * The host derives the checkpoint ref namespace from it, so the attempt
   * records **this** session's checkpoints rather than every checkpoint in the
   * checkout. Like the checkout, it is sent to the host and never returned to
   * a model. Absent, the attempt still records the checkpoints in its own time
   * window and each one still says which session's ref it came from.
   */
  sessionPath?: string;
}

/** A refusal in the contract's shape, thrown by every handler in this area. */
export class ProjectWorkToolFailure extends Error {
  readonly toolError: ToolError;
  constructor(error: ToolError) {
    super(error.message);
    this.name = "ProjectWorkToolFailure";
    this.toolError = error;
  }
}

export function refuseProjectWork(code: string, message: string, next: string, committed = false): never {
  throw new ProjectWorkToolFailure(toolError({ code, message, committed, next }));
}

/**
 * What one Laser project-work tool needs. One interface, so a fixture can
 * script it and the module can wire it without knowing about the transport.
 */
export interface ProjectWorkBridge {
  /** The project this session works in; absent in a projectless chat. */
  projectId(): string | undefined;
  /** Who this session is, for provenance on a write. */
  identity(): ProjectWorkSessionIdentity;
  /**
   * What an attempt started here would be running in. Asynchronous because
   * the branch and the base commit are read from git, not remembered.
   */
  execution(): Promise<ProjectWorkExecutionShape>;
  /** The Task this session was opened to work on, when it was opened for one. */
  task(): { entityId: string; key: string } | undefined;
  /** Forward one lifecycle call to the host authority. */
  call<M extends ProjectWorkMethod>(
    method: M,
    params: ClientRequests[M]["params"],
    extras?: { research?: ResearchOperation; attempt?: ProjectWorkBridgeAttempt; verify?: VerificationEnvelope },
  ): Promise<ClientRequests[M]["result"]>;
  /** The last research write's after-effects, when the last call was one. */
  lastResearchResult(): ProjectWorkBridgeResult["researchResult"] | undefined;
  /**
   * Ask the host what a Task has to satisfy (M21-T19).
   *
   * A read of the Task, carrying the verification envelope: the criteria come
   * back derived from the host's own store at exact revisions, so a verifier
   * cannot choose what it is judged against.
   */
  verify(
    params: ClientRequests["project/work/get"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "plan" }>,
  ): Promise<{ result: ClientRequests["project/work/get"]["result"]; verify: VerificationBridgeResult }>;
  /**
   * Hand the command runs back and take the stored report.
   *
   * The link params supply the fence and the idempotency key; the record's
   * content is the host's own, built from its own evaluation.
   */
  verifyReport(
    params: ClientRequests["project/work/link"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "report" }>,
  ): Promise<{ result: ClientRequests["project/work/link"]["result"]; verify: VerificationBridgeResult }>;
}

/** What an attempt envelope carries. The host stores it; a model never sees it. */
export function attemptEnvelope(shape: ProjectWorkExecutionShape): ProjectWorkBridgeAttempt {
  return {
    workspace: shape.workspace,
    checkout: shape.checkout,
    ...(shape.sessionPath ? { sessionPath: shape.sessionPath } : {}),
  };
}

export interface HostProjectWorkBridgeOptions {
  link: ProjectWorkHostLink;
  /**
   * Who is calling, resolved when it is asked for: a session learns its own
   * id as it opens, and a run only exists once one has started.
   */
  identity: () => ProjectWorkSessionIdentity;
  execution: () => Promise<ProjectWorkExecutionShape>;
  /** The project id, once this session has learnt it. */
  projectId?: string | undefined;
  task?: () => { entityId: string; key: string } | undefined;
}

/**
 * The real bridge: every call is one `project/work/bridge` request over the
 * worker's own link to the host.
 */
export class HostProjectWorkBridge implements ProjectWorkBridge {
  private research: ProjectWorkBridgeResult["researchResult"] | undefined;
  private resolvedProjectId: string | undefined;

  constructor(private readonly options: HostProjectWorkBridgeOptions) {
    this.resolvedProjectId = options.projectId;
  }

  projectId(): string | undefined {
    return this.resolvedProjectId;
  }

  /**
   * Where a write of this session's is being made from (review F3).
   *
   * `based_on` is the host's record of the code an artifact revision was
   * derived from, and the host reads git in the directory the call names. A
   * run working in a worktree of its own would otherwise have its writes
   * recorded against the project root the worker was spawned for — two records
   * of the same session disagreeing about where it was. Attaching the shape
   * here, once, means every write takes the run's own checkout, whichever tool
   * made it.
   *
   * Only creates and revises: nothing else in the family records `based_on`,
   * and an envelope on a read would be provenance about nothing.
   */
  private async writeEnvelope(method: ProjectWorkMethod): Promise<ProjectWorkBridgeAttempt | undefined> {
    if (method !== "project/work/create" && method !== "project/work/revise") return undefined;
    try {
      return attemptEnvelope(await this.options.execution());
    } catch {
      // A checkout that cannot be read leaves the write without provenance,
      // exactly as a session with no checkout does. The revision is the point.
      return undefined;
    }
  }

  identity(): ProjectWorkSessionIdentity {
    return this.options.identity();
  }

  execution(): Promise<ProjectWorkExecutionShape> {
    return this.options.execution();
  }

  task(): { entityId: string; key: string } | undefined {
    return this.options.task?.();
  }

  lastResearchResult(): ProjectWorkBridgeResult["researchResult"] | undefined {
    return this.research;
  }

  async call<M extends ProjectWorkMethod>(
    method: M,
    params: ClientRequests[M]["params"],
    extras?: { research?: ResearchOperation; attempt?: ProjectWorkBridgeAttempt; verify?: VerificationEnvelope },
  ): Promise<ClientRequests[M]["result"]> {
    return (await this.send(method, params, extras)).result as ClientRequests[M]["result"];
  }

  async verify(
    params: ClientRequests["project/work/get"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "plan" }>,
  ): Promise<{ result: ClientRequests["project/work/get"]["result"]; verify: VerificationBridgeResult }> {
    const answer = await this.send("project/work/get", params, { verify: envelope });
    return { result: answer.result as ClientRequests["project/work/get"]["result"], verify: answer.verifyResult ?? {} };
  }

  async verifyReport(
    params: ClientRequests["project/work/link"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "report" }>,
  ): Promise<{ result: ClientRequests["project/work/link"]["result"]; verify: VerificationBridgeResult }> {
    const answer = await this.send("project/work/link", params, { verify: envelope });
    return { result: answer.result as ClientRequests["project/work/link"]["result"], verify: answer.verifyResult ?? {} };
  }

  private async send<M extends ProjectWorkMethod>(
    method: M,
    params: ClientRequests[M]["params"],
    extras?: { research?: ResearchOperation; attempt?: ProjectWorkBridgeAttempt; verify?: VerificationEnvelope },
  ): Promise<ProjectWorkBridgeResult> {
    const attempt = extras?.attempt ?? (await this.writeEnvelope(method));
    const envelope: ProjectWorkBridgeParams = {
      agent: this.options.identity(),
      request: { method, params } as ProjectWorkBridgeParams["request"],
      ...(extras?.research ? { research: extras.research } : {}),
      ...(attempt ? { attempt } : {}),
      ...(extras?.verify ? { verify: extras.verify } : {}),
    };
    let answer: ProjectWorkBridgeResult;
    try {
      answer = (await this.options.link(PROJECT_WORK_BRIDGE_METHOD, envelope)) as ProjectWorkBridgeResult;
    } catch (error) {
      throw projectWorkFailure(error, method);
    }
    this.research = answer.researchResult;
    // The host is the authority on which project this session belongs to, and
    // it says so on every answer: a session that started without one learns
    // it from its first call rather than guessing from its directory.
    if (answer.projectId) this.resolvedProjectId = answer.projectId;
    return answer;
  }
}

/** Every failure a bridge call can end in, as the one shape a model reads. */
export function projectWorkFailure(error: unknown, method: ProjectWorkMethod | string): ProjectWorkToolFailure {
  if (error instanceof ProjectWorkToolFailure) return error;
  if (error instanceof ProtocolError) {
    const data = isRecord(error.data) ? error.data : undefined;
    if (error.code === PROJECT_WORK_CONFLICT_CODE) {
      const current = isRecord(data?.["current"]) ? (data["current"] as { revisionId?: unknown; key?: unknown }) : undefined;
      const revisionId = typeof current?.revisionId === "string" ? current.revisionId : undefined;
      const key = typeof current?.key === "string" ? current.key : "it";
      return new ProjectWorkToolFailure(
        toolError({
          code: "stale_revision",
          message: error.message,
          committed: false,
          next: revisionId
            ? `call inspect_project_work on ${key} to read it as it is now, then send the same write with expected_revision_id ${revisionId}`
            : "call inspect_project_work to read it as it is now, then send the same write with the revision it returns",
        }),
      );
    }
    if (error.code === PROJECT_WORK_QUOTA_CODE) {
      return new ProjectWorkToolFailure(
        toolError({
          code: "project_work_full",
          message: error.message,
          committed: false,
          next: "say what you were trying to record and ask the person to free space in this project's work",
        }),
      );
    }
    if (data?.["refused"] === "wrong_project") {
      const name = typeof data["owningProjectName"] === "string" ? data["owningProjectName"] : "another project";
      return new ProjectWorkToolFailure(
        toolError({
          code: "wrong_project",
          message: error.message,
          committed: false,
          next: `tell the person that this belongs to ${name} and offer to open a session there; you can still read it from here with inspect_project_work`,
        }),
      );
    }
    if (typeof data?.["refused"] === "string" && typeof data["next"] === "string") {
      return new ProjectWorkToolFailure(
        toolError({ code: data["refused"], message: error.message, committed: false, next: data["next"] }),
      );
    }
    if (error.code === ErrorCodes.ProjectUntrusted) {
      return new ProjectWorkToolFailure(
        toolError({
          code: "project_untrusted",
          message: error.message,
          committed: false,
          next: "tell the person this project's folder has to be trusted in Projects before its work can be changed",
        }),
      );
    }
    return new ProjectWorkToolFailure(
      toolError({
        code: "project_work_refused",
        message: error.message,
        committed: false,
        next: "call inspect_project_work to read the current state, then try the call again with what it returns",
      }),
    );
  }
  return new ProjectWorkToolFailure(
    toolError({
      code: "project_work_unavailable",
      message: error instanceof Error && error.message.trim() !== "" ? error.message : `The app could not answer ${method}.`,
      committed: false,
      next: "tell the person that this project's work could not be reached, and carry on with what does not need it",
    }),
  );
}
