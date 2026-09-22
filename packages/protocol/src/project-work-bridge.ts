/**
 * The worker → host bridge for project work (M21-T17, D-356.a).
 *
 * A model tool runs inside the engine session, which lives in the worker. The
 * authority over a project's work lives in the host and nowhere else (leap,
 * "Protocol and authority"), so a tool that wants to read a Spec or record a
 * Task attempt asks the host over the link the host already owns — the fd-3
 * pipe it spawned the worker on — and this file is the shape of that ask.
 *
 * One request family, not sixteen:
 *
 *     project/work/bridge { agent, request: { method, params }, research?, attempt? }
 *
 * `request` is a closed union over the sixteen lifecycle methods and their
 * existing strict param schemas, so a method added to the family is reachable
 * from a tool the day it lands, and a params object that would be refused at
 * the client boundary is refused here in exactly the same words.
 *
 * Three things are deliberately **not** in the envelope:
 *
 *   - **Who the caller is.** `agent` is provenance — a label, the session and
 *     run a write came from — and the host stamps the actor *kind* itself
 *     (`source: "worker"` ⇒ `agent`), so "only a person approves" (D-332)
 *     cannot be claimed by a request body.
 *   - **Which project the caller belongs to.** The host spawned this worker
 *     for one directory and resolves the owning project from that directory
 *     (D-356.c). A mutation naming another project is refused with
 *     {@link ProjectWorkWrongProject}; a read of another project is allowed,
 *     which is what makes a cross-project mention useful.
 *   - **A research body.** A research write crosses as its operation
 *     (D-351.a/D-356.d); the host applies it and stores the body the applier
 *     returned, so a tool that skipped the worker's pre-check changes nothing.
 */
import { z } from "zod";
import type { MethodPolicy } from "./method-policy.js";
import type { ClientRequests } from "./messages.js";
import {
  PROJECT_WORK_METHODS,
  projectWorkParamsSchemas,
  type ProjectWorkMethod,
} from "./project-work-methods.js";
import { researchOperationSchema, type ResearchAttention, type ResearchOperation } from "./research.js";
import {
  verificationEnvelopeSchema,
  type VerificationBridgeResult,
  type VerificationEnvelope,
} from "./project-work-verification.js";

/** The one method the worker link carries for project work. */
export const PROJECT_WORK_BRIDGE_METHOD = "project/work/bridge";
export type ProjectWorkBridgeMethod = typeof PROJECT_WORK_BRIDGE_METHOD;

/** One forwarded lifecycle call: the method, and exactly that method's params. */
export type ProjectWorkBridgeRequest = {
  [M in ProjectWorkMethod]: { method: M; params: ClientRequests[M]["params"] };
}[ProjectWorkMethod];

/** How long a label, a session id or a run id may be on this envelope. */
export const PROJECT_WORK_BRIDGE_LABEL_MAX = 200;

/**
 * Who, as provenance. The host decides the actor *class* and the actor
 * *kind*; this only says which agent, in which session, on which run.
 */
export interface ProjectWorkBridgeAgent {
  label: string;
  sessionId?: string;
  runId?: string;
}

/** What an attempt ran in, recorded beside its execution link (D-356.e). */
export interface ProjectWorkBridgeAttempt {
  /** A worktree of its own, or the project's own checkout. */
  workspace: "worktree" | "shared";
  /** The directory the attempt ran in. Stored; never returned to a model. */
  checkout: string;
  /**
   * The session file the attempt runs in (M21-T18). The host derives the
   * checkpoint ref namespace from it and stores the derived key only; like
   * the checkout, the path itself is never returned to a model.
   */
  sessionPath?: string;
}

export interface ProjectWorkBridgeParams {
  agent: ProjectWorkBridgeAgent;
  request: ProjectWorkBridgeRequest;
  /**
   * A research write, as its operation. Present only with
   * `project/work/revise` on a research entity; the host applies it against
   * its own current body and ignores the body in `request.params`.
   */
  research?: ResearchOperation;
  /** Present only with `project/task/link-execution`. */
  attempt?: ProjectWorkBridgeAttempt;
  /**
   * A verification step (M21-T19).
   *
   * Like a research write, it crosses as what it *is* rather than as its
   * result: `plan` asks the host to derive the criteria from its own store at
   * exact revisions, and `report` hands back the command runs a verifier alone
   * can produce. The host evaluates every criterion itself and decides whether
   * anything converged, so a tool that skipped the worker's own rules — or
   * lied about an exit code's meaning — changes nothing about the verdict.
   *
   * `plan` travels with a `project/work/get` of the Task; `report` with the
   * `project/work/link` that stores the report as evidence. The host uses the
   * link only for its fence and its idempotency key: the record's kind, role,
   * summary and outcome are the host's own.
   */
  verify?: VerificationEnvelope;
}

export interface ProjectWorkBridgeResult {
  /** The method that was forwarded, echoed so a caller can narrow the result. */
  method: ProjectWorkMethod;
  /** Exactly what the host's own handler answered. */
  result: unknown;
  /** The project the host resolved for this worker. */
  projectId?: string;
  /** A research write's after-effects, for the tool that asked for it. */
  researchResult?: {
    attention?: ResearchAttention;
    /** Spec/Design decisions the host marked stale because of this write. */
    staleRefs: string[];
  };
  /** A verification step's answer: the plan, or the stored report (M21-T19). */
  verifyResult?: VerificationBridgeResult;
}

/**
 * The data a wrong-project refusal carries (leap, "Cross-session mentions and
 * context"): which project owns the entity, and the offer Laser makes instead
 * of doing the write in the wrong checkout.
 */
export interface ProjectWorkWrongProject {
  refused: "wrong_project";
  owningProjectId: string;
  /** The project's own name, so the refusal can name it to a person. */
  owningProjectName: string;
  /** Always `open_session`: the M21 offer to open a session in that project. */
  offer: "open_session";
}

const label = z.string().min(1).max(PROJECT_WORK_BRIDGE_LABEL_MAX);

const bridgeAgentSchema = z
  .object({
    label,
    sessionId: z.string().min(1).max(PROJECT_WORK_BRIDGE_LABEL_MAX).optional(),
    runId: z.string().min(1).max(PROJECT_WORK_BRIDGE_LABEL_MAX).optional(),
  })
  .strict();

const bridgeAttemptSchema = z
  .object({
    workspace: z.enum(["worktree", "shared"]),
    checkout: z.string().min(1).max(4096),
    sessionPath: z.string().min(1).max(4096).optional(),
  })
  .strict();

/**
 * The forwarded call, as a closed union: one branch per method, each carrying
 * that method's own strict schema. Built from the table rather than written
 * out, so the two can never disagree.
 */
const bridgeRequestSchemas = PROJECT_WORK_METHODS.map((method) =>
  z.object({ method: z.literal(method), params: projectWorkParamsSchemas[method] }).strict(),
);
const bridgeRequestSchema = z.union(
  bridgeRequestSchemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);

export const projectWorkBridgeParamsSchema = z
  .object({
    agent: bridgeAgentSchema,
    request: bridgeRequestSchema,
    research: researchOperationSchema.optional(),
    attempt: bridgeAttemptSchema.optional(),
    verify: verificationEnvelopeSchema.optional(),
  })
  .strict();

/**
 * Parse one envelope. The host calls this before it looks at anything else:
 * the worker link is trusted, but a malformed frame is still a refusal rather
 * than something the authority has to reason about.
 */
export function parseProjectWorkBridgeParams(params: unknown): ProjectWorkBridgeParams {
  return projectWorkBridgeParamsSchema.parse(params) as ProjectWorkBridgeParams;
}

/**
 * The policy row for the bridge.
 *
 * `project_write` because that is the authority a forwarded mutation
 * exercises, and `native` because a worker is a local process this host
 * spawned and nothing else may ever present itself as one: a page, a paired
 * device or a relay peer reaches project work through the client methods,
 * which decide for themselves that the caller is a person.
 */
export const PROJECT_WORK_BRIDGE_POLICY: Readonly<Record<ProjectWorkBridgeMethod, MethodPolicy>> = {
  "project/work/bridge": {
    scope: "project_write",
    reach: "native",
    refusal: "Project work can only be changed by this machine's own app.",
  },
};
