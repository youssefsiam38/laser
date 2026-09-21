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
import type { ProjectWorkBridge } from "./bridge.js";
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
   */
  foundationModels?: FoundationModelAccess | undefined;
  /** This session's research run, and the adapters it may use. */
  research?: { bridge: ResearchBridge; adapters: readonly ResearchAdapterId[] } | undefined;
  /** The Task this session is an attempt on, when it was opened for one. */
  task?: { entityId: string; key: string } | undefined;
  /** The project's own instructions, for the context packet. */
  projectInstructions?: () => string | undefined;
  /** Who a design review decision is recorded as. */
  reviewActor?: ReviewActor;
}

/** The worker's implementation of what the companion module consumes. */
export class ProjectWorkSession implements ExtensionProjectWorkBridge {
  /** Attempts already linked in this session, so a turn links one once. */
  private attemptLinked = false;
  /** Hand-offs already delivered, keyed by the prompt that asked for them. */
  private readonly handedOff = new Set<string>();

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
    ];
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
              run: (input: Record<string, unknown>) =>
                proposeFoundationTool(
                  {
                    work: this.options.bridge!,
                    ...(this.options.foundationModels ? { access: this.options.foundationModels } : {}),
                  },
                  input as unknown as ProposeFoundationInput,
                ),
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
    // The specs are built from the adapters this session really has, so a
    // switched-off source is not an option the model can pick and fail on.
    return researchToolSpecs(adapters).flatMap((spec) => {
      const run = handlers[spec.name];
      const recovery = RESEARCH_TOOL_RECOVERY[spec.name];
      return run && recovery ? [{ spec, run, recovery }] : [];
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
        { attempt: { workspace: shape.workspace, checkout: shape.checkout } },
      );
    } catch {
      // Reported by nothing: the model is told what the Task is either way,
      // and `report_project_task` is the recovery a turn can still take.
    }
  }
}
