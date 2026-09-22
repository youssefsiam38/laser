/**
 * One session's whole project-work surface (M21-T17).
 *
 * This is what the worker hands the companion extension: the tools this
 * session really has, and what to put in front of the model at the start of
 * every turn. It is the only place that decides **which** tools exist, and it
 * decides it from what the session actually has rather than from a flag:
 *
 * | The session has | It gets |
 * | --- | --- |
 * | no link to the host authority | nothing at all |
 * | a link but no project (a Chat) | `inspect_project_work`, for cross-project reads |
 * | a project | the four lifecycle tools |
 * | a design index | the three Design Index tools as well |
 * | research adapters | the four Research tools as well |
 *
 * And at every model-call boundary it answers with one of two things: the
 * `/design implement @Design` hand-off, when this turn's input asked for one,
 * or the implementation context packet, when this session is an attempt on a
 * Task. Both are built here and neither is ever cached across a turn.
 */
import type { HostGroundingBridge } from "../design/host/ground.js";
import type { ProjectWorkBridge as ExtensionProjectWorkBridge, ProjectWorkToolBinding } from "@lasercode/pi-extension";
import type { ResearchAdapterId } from "@lasercode/protocol";
import {
  DESIGN_INDEX_TOOL_RECOVERY,
  GROUND_HOST_PAGE_SPEC,
  groundHostPageTool,
  type GroundHostPageInput,
  INSPECT_DESIGN_INDEX_SPEC,
  BUILD_DESIGN_INDEX_SPEC,
  REVIEW_DESIGN_INDEX_SPEC,
  buildDesignIndexTool,
  inspectDesignIndex,
  reviewDesignIndexTool,
  type DesignIndexBridge,
  type BuildDesignIndexInput,
  type InspectDesignIndexInput,
  type ReviewDesignIndexInput,
} from "../design/index/tools.js";
import type { ReviewActor } from "../design/index/review.js";
import {
  PROPOSE_FOUNDATION_RECOVERY,
  PROPOSE_FOUNDATION_SPEC,
  proposeFoundationTool,
  type FoundationModelAccess,
  type ProposeFoundationInput,
} from "../design/foundation/index.js";
import type { ResearchLedger } from "../research/budget.js";
import type { ResearchRunService } from "../research/runs.js";
import {
  RESEARCH_TOOL_RECOVERY,
  readSourceTool,
  recordFindingTool,
  researchToolSpecs,
  resolveQuestionTool,
  searchSourcesTool,
  type ReadSourceInput,
  type RecordFindingInput,
  type ResearchBridge,
  type ResolveQuestionInput,
  type SearchSourcesInput,
} from "../research/tools.js";
import { buildContextPacket } from "./context-packet.js";
import { buildDesignHandoff, designImplementRef } from "./design-handoff.js";
import { attemptEnvelope, type ProjectWorkBridge } from "./bridge.js";
import {
  INSPECT_PROJECT_WORK_SPEC,
  PROJECT_WORK_TOOL_RECOVERY,
  REPORT_PROJECT_TASK_SPEC,
  REQUEST_PROJECT_REVIEW_SPEC,
  WRITE_PROJECT_ARTIFACT_SPEC,
  inspectProjectWork,
  reportProjectTask,
  requestProjectReview,
  writeProjectArtifact,
  type InspectProjectWorkInput,
  type ReportProjectTaskInput,
  type RequestProjectReviewInput,
  type WriteProjectArtifactInput,
} from "./tools.js";
import {
  VERIFY_PROJECT_TASK_SPEC,
  VERIFY_TOOL_RECOVERY,
  VerificationService,
  verifyProjectTask,
  type VerifyProjectTaskInput,
} from "./verification/index.js";

export interface ProjectWorkSessionOptions {
  /** The typed bridge to the host authority. Absent: no tools at all. */
  bridge?: ProjectWorkBridge | undefined;
  /** The directory this session runs in, for the first project resolution. */
  cwd?: string;
  /** This project's design index, when the feature is on for this session. */
  design?: DesignIndexBridge | undefined;
  /** Static host grounding for this project (M21-T12); needs the design index to be offered. */
  hostGrounding?: HostGroundingBridge | undefined;
  /**
   * The models Foundation mode proposes with (M21-T14), when this machine has
   * a Design-index profile. Absent is a working state, not a broken one: each
   * step falls back to the documented neutral foundation and says so.
   *
   * A thunk, resolved once per tool call: the profile design work runs on is a
   * setting, and a session open for hours must not keep proposing on the
   * profile that was assigned when it opened.
   */
  foundationModels?: FoundationModelAccess | (() => FoundationModelAccess | undefined) | undefined;
  /**
   * This session's research run, and the adapters it may use.
   *
   * `runs` and `ledger` are what make the loop a visible Command (M21-T26):
   * the registry publishes the fleet row and answers a Stop from it, and the
   * ledger is the budget that row shows and the stop that ends the loop.
   * Absent in an evaluation fixture, which has no fleet and no person: the
   * tools then work exactly as before, with no row.
   */
  research?:
    | {
        bridge: ResearchBridge;
        adapters: readonly ResearchAdapterId[];
        runs?: ResearchRunService | undefined;
        ledger?: ResearchLedger | undefined;
        /** Cut what the adapters are doing now, when a person stops the run. */
        abort?: (() => void) | undefined;
      }
    | undefined;
  /** The Task this session is an attempt on, when it was opened for one. */
  task?: { entityId: string; key: string } | undefined;
  /** The project's own instructions, for the context packet. */
  projectInstructions?: () => string | undefined;
  /**
   * This session's own file, for a verification run started from it
   * (M21-T19). A run belongs to the conversation that asked for it and
   * appears in the fleet under it; the path is the worker's, never a model's.
   */
  sessionPath?: () => string | undefined;
  /** Who a design review decision is recorded as. */
  reviewActor?: ReviewActor;
  /**
   * The worker's verification runs (M21-T19).
   *
   * Shared with the person's own `pi/project/verify/*` surface on purpose:
   * a run a model starts and a run a person starts are the same run, in the
   * same registry, stoppable from either side.
   */
  verification?: VerificationService | undefined;
  /**
   * This session is an evaluation fixture, not a person's conversation.
   *
   * The only thing it buys is the fallback below: a fixture world may run the
   * verify tool over its own scripted bridge without the worker's registry,
   * because nothing in it is a run a person could be waiting on. Production
   * never sets it, and the invariant that a run is always visible in the
   * fleet therefore does not rest on every future call site remembering to
   * pass `verification` — it rests on this being false everywhere else.
   */
  evaluation?: boolean;
}

/** The worker's implementation of what the companion module consumes. */
export class ProjectWorkSession implements ExtensionProjectWorkBridge {
  /** Attempts already linked in this session, so a turn links one once. */
  private attemptLinked = false;
  /** Hand-offs already delivered, keyed by the prompt that asked for them. */
  private readonly handedOff = new Set<string>();
  /** This session's verification runs, once something has asked for them. */
  private ownVerification: VerificationService | undefined;

  constructor(private readonly options: ProjectWorkSessionOptions) {}

  /**
   * Learn which project this session belongs to, before its tools are
   * registered.
   *
   * The host resolves it from the directory it spawned this worker for and
   * says so on the answer; nothing here decides it. A host with no project
   * work for this folder simply refuses, and the session keeps the read-only
   * surface a projectless chat has — which is the correct answer, not a
   * failure.
   */
  async resolveProject(): Promise<string | undefined> {
    const bridge = this.options.bridge;
    if (!bridge || bridge.projectId() !== undefined) return bridge?.projectId();
    const cwd = this.options.cwd;
    if (cwd === undefined) return undefined;
    try {
      await bridge.call("project/work/list", { cwd, limit: 1 });
    } catch {
      return undefined;
    }
    return bridge.projectId();
  }

  lifecycleTools(): ProjectWorkToolBinding[] {
    const bridge = this.options.bridge;
    if (!bridge) return [];
    const read: ProjectWorkToolBinding = {
      spec: INSPECT_PROJECT_WORK_SPEC,
      recovery: PROJECT_WORK_TOOL_RECOVERY["inspect_project_work"]!,
      run: (input) => inspectProjectWork(bridge, input as unknown as InspectProjectWorkInput),
    };
    // A projectless Chat reads across projects and writes nowhere: the leap's
    // rule is that a mutation is routed to the owning project, which means a
    // session with no project of its own has nothing to write to here.
    if (bridge.projectId() === undefined) return [read];
    return [
      read,
      {
        spec: WRITE_PROJECT_ARTIFACT_SPEC,
        recovery: PROJECT_WORK_TOOL_RECOVERY["write_project_artifact"]!,
        run: (input) => writeProjectArtifact(bridge, input as unknown as WriteProjectArtifactInput),
      },
      {
        spec: REQUEST_PROJECT_REVIEW_SPEC,
        recovery: PROJECT_WORK_TOOL_RECOVERY["request_project_review"]!,
        run: (input) => requestProjectReview(bridge, input as unknown as RequestProjectReviewInput),
      },
      {
        spec: REPORT_PROJECT_TASK_SPEC,
        recovery: PROJECT_WORK_TOOL_RECOVERY["report_project_task"]!,
        run: (input) => reportProjectTask(bridge, input as unknown as ReportProjectTaskInput),
      },
      // Verifying needs a checkout to run the task's commands in, so it is
      // offered only to a session that has one. An absent tool is absent,
      // never listed as unavailable (D-356.g).
      ...(this.verification() && this.options.cwd !== undefined
        ? [
            {
              spec: VERIFY_PROJECT_TASK_SPEC,
              recovery: VERIFY_TOOL_RECOVERY,
              run: (input: Record<string, unknown>) =>
                verifyProjectTask(
                  {
                    bridge,
                    service: this.verification()!,
                    cwd: this.options.cwd!,
                    sessionPath: () => this.options.sessionPath?.(),
                  },
                  input as unknown as VerifyProjectTaskInput,
                ),
            },
          ]
        : []),
    ];
  }

  /** The models Foundation mode may use on this call, or nothing. */
  private foundationAccess(): FoundationModelAccess | undefined {
    const models = this.options.foundationModels;
    return typeof models === "function" ? models() : models;
  }

  /**
   * This session's verification runs.
   *
   * The worker's own registry, or nothing. A run started through this tool is
   * a Command of this conversation: it takes a row in the fleet, it pins the
   * session while it works, and a person stops it from that row (M21-T19).
   * Only the worker's registry can do any of that — it is the one holding
   * `publishTask` and `holdsSession` — so a session that was not given it
   * does not get a private one to start invisible runs with. The tool is
   * simply not offered, which is the honest answer and the one the fleet's
   * "nothing runs unseen" rule needs.
   *
   * The single exception is an evaluation fixture, which says it is one: its
   * scripted world has no fleet, no person and no run to lose.
   */
  private verification(): VerificationService | undefined {
    const bridge = this.options.bridge;
    if (!bridge) return undefined;
    if (this.options.verification) return this.options.verification;
    if (this.options.evaluation !== true) return undefined;
    this.ownVerification ??= new VerificationService({ bridgeFor: () => bridge });
    return this.ownVerification;
  }

  designTools(): ProjectWorkToolBinding[] {
    const design = this.options.design;
    if (!design) return [];
    const actor: ReviewActor = this.options.reviewActor ?? { kind: "agent", label: "Agent" };
    return [
      {
        spec: INSPECT_DESIGN_INDEX_SPEC,
        recovery: DESIGN_INDEX_TOOL_RECOVERY["inspect_design_index"]!,
        run: (input) => inspectDesignIndex(design, input as unknown as InspectDesignIndexInput),
      },
      {
        spec: BUILD_DESIGN_INDEX_SPEC,
        recovery: DESIGN_INDEX_TOOL_RECOVERY["build_design_index"]!,
        run: (input) => buildDesignIndexTool(design, input as unknown as BuildDesignIndexInput),
      },
      {
        spec: REVIEW_DESIGN_INDEX_SPEC,
        recovery: DESIGN_INDEX_TOOL_RECOVERY["review_design_index"]!,
        run: (input) => reviewDesignIndexTool(design, input as unknown as ReviewDesignIndexInput, actor),
      },
      // Foundation mode is the design surface of a project that has no index
      // to compose from, and its proposals are stored as project work — so it
      // is offered exactly when this session has both a design surface and a
      // project to keep the proposal in.
      ...(this.options.bridge && this.options.bridge.projectId() !== undefined
        ? [
            {
              spec: PROPOSE_FOUNDATION_SPEC,
              recovery: PROPOSE_FOUNDATION_RECOVERY,
              run: (input: Record<string, unknown>) => {
                const access = this.foundationAccess();
                return proposeFoundationTool(
                  {
                    work: this.options.bridge!,
                    ...(access ? { access } : {}),
                  },
                  input as unknown as ProposeFoundationInput,
                );
              },
            },
          ]
        : []),
      ...(this.options.hostGrounding
        ? [
            {
              spec: GROUND_HOST_PAGE_SPEC,
              recovery: DESIGN_INDEX_TOOL_RECOVERY["ground_host_page"] ?? { code: "host_page_failed", next: "name a route or template file this project has" },
              run: (input: Record<string, unknown>) => groundHostPageTool(this.options.hostGrounding!, input as unknown as GroundHostPageInput),
            },
          ]
        : []),
    ];
  }

  researchTools(): ProjectWorkToolBinding[] {
    const research = this.options.research;
    if (!research) return [];
    const { bridge, adapters } = research;
    const handlers: Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
      search_sources: (input) => searchSourcesTool(bridge, input as unknown as SearchSourcesInput),
      read_source: (input) => readSourceTool(bridge, input as unknown as ReadSourceInput),
      record_finding: (input) => recordFindingTool(bridge, input as unknown as RecordFindingInput),
      resolve_question: (input) => resolveQuestionTool(bridge, input as unknown as ResolveQuestionInput),
    };
    // The loop is a Command: the first of these calls opens a run in the
    // fleet under this conversation, every call moves its row on, and a
    // person can stop it from that row (M21-T26). Nothing about the call
    // itself changes — the registry wraps it, never replaces it.
    const runs = research.runs;
    const ledger = research.ledger;
    const watched =
      runs && ledger
        ? (tool: string, handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>) =>
            (input: Record<string, unknown>) =>
              runs.during(
                {
                  sessionPath: this.options.sessionPath?.(),
                  tool,
                  ledger,
                  ...(research.abort ? { abort: research.abort } : {}),
                },
                () => handler(input),
              )
        : (_tool: string, handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>) => handler;
    // The specs are built from the adapters this session really has, so a
    // switched-off source is not an option the model can pick and fail on.
    return researchToolSpecs(adapters).flatMap((spec) => {
      const run = handlers[spec.name];
      const recovery = RESEARCH_TOOL_RECOVERY[spec.name];
      return run && recovery ? [{ spec, run: watched(spec.name, run), recovery }] : [];
    });
  }

  /**
   * What this turn is given, rebuilt from the project's own record.
   *
   * A `/design implement` prompt is answered with the hand-off packet, once
   * per distinct prompt: a follow-up in the same session gets the ordinary
   * context instead of the design again. Otherwise a session that is an
   * attempt on a Task gets the implementation context packet — and, the first
   * time in this session, the attempt is linked before the model is called,
   * which is the leap's "an execution link before any prompt".
   */
  async turnContext(input: { prompt?: string }): Promise<string | undefined> {
    const bridge = this.options.bridge;
    if (!bridge) return undefined;
    const ref = input.prompt ? designImplementRef(input.prompt) : undefined;
    if (ref && !this.handedOff.has(ref)) {
      const packet = await buildDesignHandoff(bridge, ref);
      if (packet) {
        this.handedOff.add(ref);
        return packet.text;
      }
    }
    const task = this.options.task ?? bridge.task();
    if (!task) return undefined;
    await this.ensureAttempt(task);
    const packet = await buildContextPacket({
      bridge,
      task,
      ...(this.options.projectInstructions ? { projectInstructions: this.options.projectInstructions() } : {}),
    });
    return packet.text || undefined;
  }

  /**
   * Link this session to the Task as an attempt, before its first prompt.
   *
   * Once per session, and never fatal: a Task whose revision has moved on, or
   * a host that refuses, must not stop the person's turn — the packet still
   * goes in and the model can link the attempt itself with
   * `report_project_task`.
   */
  private async ensureAttempt(task: { entityId: string; key: string }): Promise<void> {
    const bridge = this.options.bridge;
    if (!bridge || this.attemptLinked) return;
    this.attemptLinked = true;
    const projectId = bridge.projectId();
    const identity = bridge.identity();
    const targetId = identity.runId ?? identity.sessionId;
    if (projectId === undefined || !targetId) return;
    const shape = await bridge.execution();
    try {
      const current = await bridge.call("project/work/get", {
        projectId,
        entityId: task.entityId,
        body: { mode: "none" as const },
        include: { links: true },
      });
      // An attempt this session already has is not started twice: a worker
      // that restarted and reopened the session is the same attempt.
      if (current.executionLinks.some((link) => link.targetId === targetId && link.endedAt === undefined)) return;
      await bridge.call(
        "project/task/link-execution",
        {
          projectId,
          entityId: task.entityId,
          expectedRevisionId: current.revision.revisionId,
          execution: {
            kind: identity.runId ? "agent_run" : "session",
            targetId,
            ...(shape.profileId !== undefined ? { profileId: shape.profileId } : {}),
            ...(shape.branch !== undefined ? { branch: shape.branch } : {}),
            ...(shape.baseCommitObjectId !== undefined ? { baseCommitObjectId: shape.baseCommitObjectId } : {}),
          },
          idempotencyKey: `attempt-${targetId}-${current.revision.revisionId}`,
        },
        { attempt: attemptEnvelope(shape) },
      );
    } catch {
      // Reported by nothing: the model is told what the Task is either way,
      // and `report_project_task` is the recovery a turn can still take.
    }
  }
}
