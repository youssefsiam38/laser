/**
 * A `project/work/get` answer with a gate report, comments and a body, as the
 * host builds one (M21-T8). Not a test file.
 *
 * The gate report here is shaped exactly like `GateEngine`'s: the requirements
 * carry the host's own sentences, `covers` is the complete digest set, and
 * `refusal` is the one thing the card is allowed to say about why a decision
 * cannot be recorded.
 */
import type {
  ApprovalGate,
  ApprovedRevision,
  BlockingCommentRef,
  ClientRequests,
  GateReport,
  GateRequirementReport,
  GateStatusReport,
  ProjectWorkApproval,
  ProjectWorkAnchor,
  ProjectWorkComment,
  ProjectWorkKind,
  SpecBody,
} from "@lasercode/protocol";
import { GATE_OUTCOMES } from "@lasercode/protocol";

type Detail = ClientRequests["project/work/get"]["result"];

const KEY_PREFIX: Record<ProjectWorkKind, string> = { spec: "SPEC", research: "RES", design: "DES", plan: "PLAN", task: "TASK" };
const DIGEST = "a".repeat(64);

export function reviewSpecBody(over: Partial<SpecBody> = {}): SpecBody {
  return {
    form: "brief",
    brief: "People cannot review a design from their phone.",
    outcomes: ["A person can approve a design on a phone."],
    nonGoals: [],
    requirements: [{ id: "r1", text: "The review footer is reachable with one thumb.", level: "must" }],
    acceptance: [{ id: "a1", text: "A gate can be approved at 320px.", machineVerifiable: false }],
    constraints: [],
    gated: true,
    ...over,
  };
}

export function comment(over: Partial<ProjectWorkComment> & { commentId: string }): ProjectWorkComment {
  return {
    projectId: "p1",
    entityId: "e1",
    revisionId: "r1",
    anchor: { target: "entity" } as ProjectWorkAnchor,
    text: "Something to say.",
    state: "open",
    blocking: false,
    createdAt: "2026-02-02T09:00:00.000Z",
    origin: { actor: { kind: "person", label: "You" } },
    ...over,
  };
}

export function blockingRef(over: Partial<BlockingCommentRef> & { commentId: string }): BlockingCommentRef {
  return { entityId: "e1", key: "SPEC-4", state: "open", excerpt: "One thumb, not two.", ...over };
}

export function gateStatus(
  gate: ApprovalGate,
  over: Partial<GateStatusReport> & { requirements?: GateRequirementReport[] } = {},
): GateStatusReport {
  return {
    gate,
    state: "ready",
    subject: { entityId: "e1", kind: "spec", key: "SPEC-4", title: "Phone review", revisionId: "r1", digest: DIGEST, state: "needs_review" },
    requirements: [{ role: "spec_brief", satisfied: true, detail: "SPEC-4's brief, at the revision on screen." }],
    covers: [{ entityId: "e1", kind: "spec", key: "SPEC-4", revisionId: "r1", digest: DIGEST }],
    outcomes: [...GATE_OUTCOMES[gate]],
    blockingComments: [],
    ...over,
  };
}

export function gateReport(over: Partial<GateReport> = {}): GateReport {
  return {
    specEntityId: "e1",
    specKey: "SPEC-4",
    gated: true,
    next: "brief",
    gates: [
      gateStatus("brief"),
      gateStatus("design", {
        state: "waiting",
        subject: undefined as unknown as GateStatusReport["subject"],
        requirements: [
          { role: "design", satisfied: false, problem: "missing", detail: "SPEC-4 has no design linked to it. Link the design this gate covers, or record why this spec needs none." },
        ],
        covers: [],
        refusal: "SPEC-4 has no design linked to it. Link the design this gate covers, or record why this spec needs none.",
      }),
      gateStatus("build", {
        state: "waiting",
        subject: undefined as unknown as GateStatusReport["subject"],
        requirements: [{ role: "plan", satisfied: false, problem: "missing", detail: "SPEC-4 has no plan linked to it. The build gate approves a plan and its tasks." }],
        covers: [],
        refusal: "SPEC-4 has no plan linked to it. The build gate approves a plan and its tasks.",
      }),
    ],
    ...over,
  };
}

export function approval(over: Partial<ProjectWorkApproval> & { approvalId: string }): ProjectWorkApproval {
  return {
    projectId: "p1",
    entityId: "e1",
    gate: "brief",
    decision: "approved",
    covers: [{ entityId: "e1", kind: "spec", key: "SPEC-4", revisionId: "r1", digest: DIGEST } satisfies ApprovedRevision],
    at: "2026-02-02T10:00:00.000Z",
    origin: { actor: { kind: "person", label: "You" } },
    ...over,
  };
}

/** The whole `project/work/get` answer the inspector reads. */
export function reviewDetail(options: {
  kind?: ProjectWorkKind;
  number?: number;
  spec?: SpecBody;
  comments?: ProjectWorkComment[];
  approvals?: ProjectWorkApproval[];
  gates?: GateReport | undefined;
  state?: Detail["entity"]["state"];
} = {}): Detail {
  const kind = options.kind ?? "spec";
  const number = options.number ?? 4;
  const key = `${KEY_PREFIX[kind]}-${number}`;
  const body = { kind: "spec" as const, spec: options.spec ?? reviewSpecBody() };
  const text = JSON.stringify(body);
  return {
    ref: { projectId: "p1", kind, entityId: "e1", revisionId: "r1", digest: DIGEST, label: key, key },
    entity: {
      projectId: "p1",
      entityId: "e1",
      kind,
      key,
      keyNumber: number,
      title: "Phone review",
      state: options.state ?? "needs_review",
      currentRevisionId: "r1",
      currentDigest: DIGEST,
      revisionCount: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
      blockingComments: (options.comments ?? []).filter((candidate) => candidate.blocking && candidate.state !== "resolved").length,
      needsAttention: true,
    },
    revision: {
      projectId: "p1",
      entityId: "e1",
      revisionId: "r1",
      kind,
      index: 1,
      digest: DIGEST,
      title: "Phone review",
      createdAt: "2026-02-02T00:00:00.000Z",
      origin: { actor: { kind: "person", label: "You" } },
      bodyBytes: text.length,
      state: options.state ?? "needs_review",
    },
    fence: { entityId: "e1", revisionId: "r1", digest: DIGEST, seq: 7 },
    body: { encoding: "application/json", totalBytes: text.length, offset: 0, bytes: text.length, text, body },
    edges: [],
    repositoryLinks: [],
    executionLinks: [],
    comments: options.comments ?? [],
    approvals: options.approvals ?? [],
    evidence: [],
    decisions: [],
    ...(options.gates === undefined ? { gates: gateReport() } : { gates: options.gates }),
    truncated: [],
  } as unknown as Detail;
}
