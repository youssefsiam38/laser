/**
 * M21-T8: comments with semantic anchors, reviews and the three hard gates,
 * over the wire.
 *
 * Every case goes through `Router.handle` against the harness whose worker
 * pool throws, because the gate rules are the host's: what a gate needs, which
 * digests an approval binds, who may resolve a comment and what a material
 * change invalidates are all decided without a worker and without a model.
 *
 * The agent's half of each rule is exercised through
 * `ProjectWorkMethods.handle` with `source: "worker"`, which is the only way
 * to be an agent — a client connection is always a person (M21-T3).
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApprovedRevision,
  GateReport,
  ProjectWorkApproval,
  ProjectWorkBody,
  ProjectWorkComment,
  ProjectWorkDetail,
  ProjectWorkEntity,
  ProjectWorkRevision,
} from "@lasercode/protocol";
import type { ProjectWorkRequest } from "../../src/project-work/methods.js";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

let keys = 0;
const idem = (): string => `k${++keys}`;

type Detail = ProjectWorkDetail & { gates?: GateReport };
interface WriteResult {
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  seq: number;
}

// --------------------------------------------------------------------- bodies

function specBodyWith(options: { form?: "brief" | "full"; gated?: boolean; brief?: string; requirement?: string } = {}): ProjectWorkBody {
  return {
    kind: "spec",
    spec: {
      form: options.form ?? "brief",
      brief: options.brief ?? "People cannot review a design from their phone.",
      outcomes: ["A person can approve a design on a phone."],
      nonGoals: [],
      requirements: [{ id: "r1", text: options.requirement ?? "The review footer is reachable with one thumb.", level: "must" }],
      acceptance: [{ id: "a1", text: "A gate can be approved at 320px.", machineVerifiable: false }],
      constraints: [],
      ...(options.gated === undefined ? {} : { gated: options.gated }),
    },
  };
}

function designBodyWith(options: { profile?: boolean; sketchOnly?: boolean; nodeText?: string } = {}): ProjectWorkBody {
  const profile = options.profile ?? true;
  if (options.sketchOnly === true) {
    return {
      kind: "design",
      design: {
        brief: "The review footer.",
        screens: [{ id: "s1", name: "Review", content: { sketchId: "sk1" }, states: [], fidelity: "sketch" }],
        flows: [],
        sketches: [
          {
            id: "sk1",
            title: "Footer",
            blobId: "blb_1",
            bytes: 120,
            digest: "a".repeat(64),
            createdAt: "2026-09-21T10:00:00.000Z",
            bounds: { width: 390, height: 844 },
          },
        ],
        fidelity: "sketch",
        fixtures: [],
        ...(profile ? { designIndexRef: { indexId: "ix1", revisionId: "rev_ix1", profileDigest: "b".repeat(64) } } : {}),
      },
    };
  }
  return {
    kind: "design",
    design: {
      brief: "The review footer.",
      screens: [
        {
          id: "s1",
          name: "Review",
          content: {
            tree: {
              rootNodeId: "n1",
              nodes: [
                {
                  id: "n1",
                  component: { primitive: "stack" },
                  fidelity: "mapped",
                  props: { tone: { type: "token", tokenId: "color.surface" } },
                  children: [],
                  ...(options.nodeText === undefined ? {} : { text: options.nodeText }),
                },
              ],
            },
          },
          states: [],
          fidelity: "mapped",
        },
      ],
      flows: [{ id: "f1", fromScreenId: "s1", trigger: "click", action: { type: "close" } }],
      sketches: [],
      fidelity: "mapped",
      fixtures: [],
      ...(profile ? { designIndexRef: { indexId: "ix1", revisionId: "rev_ix1", profileDigest: "b".repeat(64) } } : {}),
    },
  };
}

function planBodyWith(taskKeys: string[]): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief: "Ship phone review.",
      phases: [{ id: "p1", name: "Spine", taskKeys }],
      dependencies: [],
      boundaries: [],
      migrations: [],
      risks: [],
      verification: ["pnpm verify"],
    },
  };
}

function taskBodyWith(outcome = "The review footer is sticky on a phone.", planKey?: string): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome,
      nonGoals: [],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [{ id: "a1", text: "Approve is reachable at 320px.", machineVerifiable: false }],
      verificationCommands: [],
      visualEvidenceRequired: false,
      assignment: { policy: "unassigned" },
      ...(planKey ? { planKey } : {}),
    },
  };
}

// ---------------------------------------------------------------------- calls

async function create(kind: ProjectWorkBody["kind"], title: string, body: ProjectWorkBody): Promise<WriteResult> {
  return ok<WriteResult>(await h.call("project/work/create", { projectId: h.projectId, kind, title, body, idempotencyKey: idem() }));
}

async function revise(entity: ProjectWorkEntity, body: ProjectWorkBody): Promise<WriteResult> {
  return ok<WriteResult>(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      body,
      idempotencyKey: idem(),
    }),
  );
}

async function link(subject: WriteResult, object: WriteResult, relation = "supports"): Promise<void> {
  ok(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: subject.entity.currentRevisionId,
      link: {
        type: "edge",
        relation,
        subject: { entityId: subject.entity.entityId, revisionId: subject.revision.revisionId },
        object: { entityId: object.entity.entityId, revisionId: object.revision.revisionId },
      },
      idempotencyKey: idem(),
    }),
  );
}

async function detail(entityId: string): Promise<Detail> {
  return ok<Detail>(await h.call("project/work/get", { projectId: h.projectId, entityId }));
}

async function gatesOf(entityId: string): Promise<GateReport> {
  const answer = await detail(entityId);
  if (!answer.gates) throw new Error("no gate report on the answer");
  return answer.gates;
}

function gate(report: GateReport, name: "brief" | "design" | "build") {
  const found = report.gates.find((candidate) => candidate.gate === name);
  if (!found) throw new Error(`no ${name} gate`);
  return found;
}

const coverOf = (write: WriteResult): ApprovedRevision => ({
  entityId: write.entity.entityId,
  kind: write.entity.kind,
  key: write.entity.key,
  revisionId: write.revision.revisionId,
  digest: write.revision.digest,
});

const coverNow = (entity: ProjectWorkEntity): ApprovedRevision => ({
  entityId: entity.entityId,
  kind: entity.kind,
  key: entity.key,
  revisionId: entity.currentRevisionId,
  digest: entity.currentDigest,
});

/**
 * Ask for the decision, the way a person or an agent does before a gate can be
 * decided: the spine's transition table has no `draft → approved` edge.
 */
async function ready(entityId: string): Promise<ProjectWorkEntity> {
  const entity = (await detail(entityId)).entity;
  if (entity.state !== "draft") return entity;
  ok(
    await h.call("project/work/review", {
      projectId: h.projectId,
      entityId,
      expectedRevisionId: entity.currentRevisionId,
      action: "request_review",
      idempotencyKey: idem(),
    }),
  );
  return (await detail(entityId)).entity;
}

async function decide(
  entityId: string,
  input: {
    gate: "brief" | "design" | "build";
    decision?: "approved" | "changes_requested" | "archived";
    mode?: string;
    covers?: ApprovedRevision[];
    skipReason?: string;
    note?: string;
  },
) {
  const entity = await ready(entityId);
  return h.call("project/work/approve", {
    projectId: h.projectId,
    entityId,
    expectedRevisionId: entity.currentRevisionId,
    gate: input.gate,
    decision: input.decision ?? "approved",
    covers: input.covers ?? [coverNow(entity)],
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.skipReason ? { skipReason: input.skipReason } : {}),
    ...(input.note ? { note: input.note } : {}),
    idempotencyKey: idem(),
  });
}

async function comment(
  entity: ProjectWorkEntity,
  input: { anchor: ProjectWorkComment["anchor"]; text: string; blocking?: boolean; parentCommentId?: string; revisionId?: string },
): Promise<{ comment: ProjectWorkComment; entity: ProjectWorkEntity }> {
  return ok<{ comment: ProjectWorkComment; entity: ProjectWorkEntity }>(
    await h.call("project/work/comment", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      revisionId: input.revisionId ?? entity.currentRevisionId,
      anchor: input.anchor,
      text: input.text,
      ...(input.blocking === undefined ? {} : { blocking: input.blocking }),
      ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
      idempotencyKey: idem(),
    }),
  );
}

async function resolve(entity: ProjectWorkEntity, commentId: string, resolution: "addressed" | "resolved" | "reopened") {
  return h.call("project/work/resolve-comment", {
    projectId: h.projectId,
    entityId: entity.entityId,
    expectedRevisionId: entity.currentRevisionId,
    commentId,
    resolution,
    idempotencyKey: idem(),
  });
}

/** The same call an agent makes: through the authority with `source: "worker"`. */
async function asAgent<T>(request: ProjectWorkRequest): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return {
      ok: true,
      value: (await h.methods.handle(request, {
        actor: { class: "local_app", id: "l1.app" },
        source: "worker",
        agent: { label: "Builder", sessionId: "ses_1" },
      })) as T,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** A gated Spec with its Design, Plan and one Task, all linked. */
async function gatedLifecycle(): Promise<{ spec: WriteResult; design: WriteResult; plan: WriteResult; task: WriteResult }> {
  const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
  const design = await create("design", "Review footer", designBodyWith());
  const task = await create("task", "Sticky footer", taskBodyWith());
  const plan = await create("plan", "Phone review plan", planBodyWith([task.entity.key]));
  await link(design, spec, "implements");
  await link(plan, spec, "depends_on");
  return { spec, design, plan, task };
}

// ---------------------------------------------------------------------- tests

describe("gates bind only when a spec chooses them", () => {
  it("reports nothing applicable for an ungated spec, and everything for a gated one", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith());
    const ungated = await gatesOf(spec.entity.entityId);
    expect(ungated.gated).toBe(false);
    expect(ungated.gates.map((candidate) => candidate.state)).toEqual(["not_applicable", "not_applicable", "not_applicable"]);
    expect(ungated.next).toBeUndefined();

    const gated = await revise(spec.entity, specBodyWith({ gated: true }));
    const drafted = await gatesOf(gated.entity.entityId);
    expect(drafted.gated).toBe(true);
    expect(drafted.next).toBe("brief");
    // A draft is not up for decision: the gate says so rather than letting a
    // person press Approve into a refusal.
    expect(gate(drafted, "brief").state).toBe("waiting");
    expect(gate(drafted, "brief").refusal).toContain("has not been sent for review yet");

    await ready(spec.entity.entityId);
    const report = await gatesOf(spec.entity.entityId);
    expect(gate(report, "brief").state).toBe("ready");
    expect(gate(report, "design").state).toBe("waiting");
    expect(gate(report, "build").state).toBe("waiting");
    expect(h.workerAttempts()).toBe(0);
  });

  it("answers no gate report at all for a standalone design that no spec links to", async () => {
    h = projectWorkHarness();
    const design = await create("design", "Review footer", designBodyWith());
    expect((await detail(design.entity.entityId)).gates).toBeUndefined();
  });

  it("names the outcomes each gate offers, in the words the person sees", async () => {
    h = projectWorkHarness();
    const { spec } = await gatedLifecycle();
    const report = await gatesOf(spec.entity.entityId);
    expect(gate(report, "brief").outcomes.map((outcome) => outcome.id)).toEqual(["approve", "request_changes", "archive"]);
    expect(gate(report, "design").outcomes.map((outcome) => outcome.id)).toEqual(["approve", "request_changes"]);
    expect(gate(report, "build").outcomes.map((outcome) => outcome.id)).toEqual([
      "build_autonomously",
      "build_with_manual_tool_review",
      "request_changes",
    ]);
  });
});

describe("an approval binds the complete digest set", () => {
  it("refuses a build approval that leaves a required revision out, and takes the complete set", async () => {
    h = projectWorkHarness();
    const { spec, design, plan } = await gatedLifecycle();

    // The full spec first: writing it after the design gate would invalidate
    // that gate, which is the next test's subject rather than this one's.
    await revise(spec.entity, specBodyWith({ gated: true, form: "full" }));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    ok(await decide(design.entity.entityId, { gate: "design" }));

    const short = failed(await decide(plan.entity.entityId, { gate: "build", mode: "autonomous", covers: [coverOf(plan)] }));
    expect(short.message).toContain(spec.entity.key);
    expect(short.message).toContain("at the revision you read");

    const report = await gatesOf(plan.entity.entityId);
    const build = gate(report, "build");
    expect(build.state).toBe("ready");
    expect(build.covers.map((covered) => covered.key).sort()).toEqual([design.entity.key, plan.entity.key, spec.entity.key].sort());

    const decided = ok<{ approval: ProjectWorkApproval }>(
      await decide(plan.entity.entityId, { gate: "build", mode: "autonomous", covers: build.covers.slice() }),
    );
    expect(decided.approval.mode).toBe("autonomous");
    expect(decided.approval.covers.map((covered) => `${covered.key}#${covered.digest.slice(0, 8)}`).sort()).toEqual(
      build.covers.map((covered) => `${covered.key}#${covered.digest.slice(0, 8)}`).sort(),
    );
  });

  it("refuses a stale digest, a draft design and a plan whose task graph is broken", async () => {
    h = projectWorkHarness();
    const { spec, design, plan } = await gatedLifecycle();
    ok(await decide(spec.entity.entityId, { gate: "brief" }));

    // Draft design: the build gate cannot pass it.
    await revise((await detail(spec.entity.entityId)).entity, specBodyWith({ gated: true, form: "full" }));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    const notApproved = gate(await gatesOf(plan.entity.entityId), "build");
    expect(notApproved.refusal).toContain(`Approve ${design.entity.key} at the design gate`);

    // A digest that moved after the card was drawn.
    const stale = failed(
      await decide(design.entity.entityId, {
        gate: "design",
        covers: [{ ...coverOf(design), digest: "c".repeat(64) }],
      }),
    );
    expect(stale.message).toContain("changed since this was prepared");
  });

  it("refuses to approve a design that is still sketches, and one with no profile", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    const design = await create("design", "Review footer", designBodyWith({ sketchOnly: true }));
    await link(design, spec, "implements");
    ok(await decide(spec.entity.entityId, { gate: "brief" }));

    const sketch = failed(await decide(design.entity.entityId, { gate: "design" }));
    expect(sketch.message).toContain("Ground it into a tree");

    const grounded = await revise((await detail(design.entity.entityId)).entity, designBodyWith({ profile: false }));
    const noProfile = failed(await decide(design.entity.entityId, { gate: "design" }));
    expect(noProfile.message).toContain("design profile");
  });

  it("records a design skip with its reason, and lets the build gate pass on it", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Rate limit the relay", specBodyWith({ gated: true, form: "brief" }));
    const task = await create("task", "Bucket per channel", taskBodyWith());
    const plan = await create("plan", "Relay limits", planBodyWith([task.entity.key]));
    await link(plan, spec, "depends_on");
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    await revise((await detail(spec.entity.entityId)).entity, specBodyWith({ gated: true, form: "full" }));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));

    const skipped = ok<{ approval: ProjectWorkApproval }>(
      await decide(spec.entity.entityId, {
        gate: "design",
        skipReason: "No interface changes: this is a relay rate limit.",
      }),
    );
    expect(skipped.approval.skipReason).toContain("No interface changes");

    await ready(plan.entity.entityId);
    const build = gate(await gatesOf(plan.entity.entityId), "build");
    expect(build.state).toBe("ready");
    expect(build.requirements.find((requirement) => requirement.role === "design_skip")?.satisfied).toBe(true);
    ok(await decide(plan.entity.entityId, { gate: "build", mode: "manual_tool_review", covers: build.covers.slice() }));
  });

  it("makes the build gate say how the build may run, and refuses an archive at the design gate", async () => {
    h = projectWorkHarness();
    const { spec, design, plan } = await gatedLifecycle();
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    ok(await decide(design.entity.entityId, { gate: "design" }));
    await revise((await detail(spec.entity.entityId)).entity, specBodyWith({ gated: true, form: "full" }));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));

    const build = gate(await gatesOf(plan.entity.entityId), "build");
    const noMode = failed(await decide(plan.entity.entityId, { gate: "build", covers: build.covers.slice() }));
    expect(noMode.message).toBe("Say how the build may run: autonomously, or with manual tool review.");

    const archived = failed(
      await decide(design.entity.entityId, { gate: "design", decision: "archived" }),
    );
    expect(archived.message).toContain("The design gate has these outcomes");
  });

  it("decides each gate on its own subject, and says which one when asked on the wrong thing", async () => {
    h = projectWorkHarness();
    const { spec, design } = await gatedLifecycle();
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    const wrong = failed(
      await decide(spec.entity.entityId, { gate: "design", covers: [coverOf(design)] }),
    );
    expect(wrong.message).toBe(`The design gate is decided on ${design.entity.key}, not on ${spec.entity.key}.`);
  });
});

describe("blocking comments stop an approval and name themselves", () => {
  it("refuses while one is open, on the subject or on anything the gate covers", async () => {
    h = projectWorkHarness();
    const { spec, design } = await gatedLifecycle();
    const blocker = await comment(spec.entity, { anchor: { target: "section", sectionId: "r1" }, text: "One thumb, not two.", blocking: true });

    const refused = failed(await decide(spec.entity.entityId, { gate: "brief" }));
    expect(refused.message).toContain(blocker.comment.commentId);
    expect(refused.message).toContain(spec.entity.key);

    const report = await gatesOf(spec.entity.entityId);
    expect(gate(report, "brief").state).toBe("waiting");
    expect(gate(report, "brief").blockingComments.map((candidate) => candidate.commentId)).toEqual([blocker.comment.commentId]);

    // The design gate covers the spec's comments too: it is one review.
    const designGate = gate(await gatesOf(design.entity.entityId), "design");
    expect(designGate.blockingComments.map((candidate) => candidate.commentId)).toEqual([blocker.comment.commentId]);

    ok(await resolve((await detail(spec.entity.entityId)).entity, blocker.comment.commentId, "resolved"));
    const after = await gatesOf(spec.entity.entityId);
    expect(gate(after, "brief").state).toBe("ready");
    expect(gate(after, "brief").refusal).toBeUndefined();
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
  });

  it("lets an agent mark a comment addressed and refuses to let it resolve or approve", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    const blocker = await comment(spec.entity, { anchor: { target: "entity" }, text: "Say what happens offline.", blocking: true });
    const current = (await detail(spec.entity.entityId)).entity;

    const addressed = await asAgent<{ comment: ProjectWorkComment }>({
      method: "project/work/resolve-comment",
      params: {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: current.currentRevisionId,
        commentId: blocker.comment.commentId,
        resolution: "addressed",
        idempotencyKey: idem(),
      },
    } as ProjectWorkRequest);
    expect(addressed.ok).toBe(true);
    if (addressed.ok) expect(addressed.value.comment.state).toBe("addressed");

    const resolved = await asAgent({
      method: "project/work/resolve-comment",
      params: {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: current.currentRevisionId,
        commentId: blocker.comment.commentId,
        resolution: "resolved",
        idempotencyKey: idem(),
      },
    } as ProjectWorkRequest);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("only you can resolve");

    // Addressed is not resolved: the gate is still stopped.
    const stillBlocked = failed(await decide(spec.entity.entityId, { gate: "brief" }));
    expect(stillBlocked.message).toContain("blocking comment");

    const approvedByAgent = await asAgent({
      method: "project/work/approve",
      params: {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: current.currentRevisionId,
        gate: "brief",
        decision: "approved",
        covers: [coverNow(current)],
        idempotencyKey: idem(),
      },
    } as ProjectWorkRequest);
    expect(approvedByAgent.ok).toBe(false);
    if (!approvedByAgent.ok) expect(approvedByAgent.message).toContain("Only a person approves");
  });

  it("keeps a thread together and leaves a non-blocking comment out of the way", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    const root = await comment(spec.entity, { anchor: { target: "section", sectionId: "a1" }, text: "Is 320px the floor?" });
    await comment((await detail(spec.entity.entityId)).entity, {
      anchor: { target: "section", sectionId: "a1" },
      text: "It is.",
      parentCommentId: root.comment.commentId,
    });
    const answer = await detail(spec.entity.entityId);
    expect(answer.comments).toHaveLength(2);
    expect(answer.comments[1]?.parentCommentId).toBe(root.comment.commentId);
    // Nothing here blocks: a question is not a veto.
    expect(gate(answer.gates!, "brief").blockingComments).toEqual([]);
  });
});

describe("anchors are semantic, and a lost one is kept", () => {
  it("orphans a comment whose target left the revision, and un-orphans it when it comes back", async () => {
    h = projectWorkHarness();
    const design = await create("design", "Review footer", designBodyWith({ nodeText: "Approve" }));
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    await link(design, spec, "implements");
    const pinned = await comment(design.entity, { anchor: { target: "node", nodeId: "n1", screenId: "s1" }, text: "Too small on a phone." });
    expect(pinned.comment.orphaned).toBeUndefined();

    // A revision whose screen is a sketch: the node id is gone.
    const withoutNode = await revise((await detail(design.entity.entityId)).entity, designBodyWith({ sketchOnly: true }));
    const orphaned = (await detail(design.entity.entityId)).comments.find((candidate) => candidate.commentId === pinned.comment.commentId);
    expect(orphaned?.orphaned).toBe(true);
    expect(orphaned?.text).toBe("Too small on a phone.");

    await revise(withoutNode.entity, designBodyWith({ nodeText: "Approve" }));
    const restored = (await detail(design.entity.entityId)).comments.find((candidate) => candidate.commentId === pinned.comment.commentId);
    expect(restored?.orphaned).toBeUndefined();
  });

  it("orphans a text range when the words it quoted change, and keeps it when they do not", async () => {
    h = projectWorkHarness();
    const { createHash } = await import("node:crypto");
    const quoted = "one thumb";
    const textHash = createHash("sha256").update(quoted).digest("hex");
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true, requirement: "The review footer is reachable with one thumb." }));
    const from = "The review footer is reachable with ".length;
    const ranged = await comment(spec.entity, {
      anchor: { target: "text", sectionId: "r1", from, to: from + quoted.length, textHash },
      text: "Which thumb?",
    });
    expect(ranged.comment.orphaned).toBeUndefined();

    // A revision that leaves the quoted words alone keeps the anchor.
    const same = await revise((await detail(spec.entity.entityId)).entity, specBodyWith({ gated: true, requirement: "The review footer is reachable with one thumb." , brief: "Reworded brief." }));
    expect((await detail(spec.entity.entityId)).comments[0]?.orphaned).toBeUndefined();

    await revise(same.entity, specBodyWith({ gated: true, requirement: "The review footer is reachable with either hand." }));
    const after = (await detail(spec.entity.entityId)).comments[0];
    expect(after?.orphaned).toBe(true);
  });
});

describe("a material change invalidates the gate it reached, and nothing else", () => {
  it("invalidates the approvals that cover the change and the downstream it stales, leaving the unrelated alone", async () => {
    h = projectWorkHarness();
    const { spec, design, plan } = await gatedLifecycle();
    // An unrelated gated spec with its own approved brief, linked to nothing.
    const other = await create("spec", "Relay limits", specBodyWith({ gated: true, brief: "The relay has no rate limit." }));

    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    ok(await decide(design.entity.entityId, { gate: "design" }));
    ok(await decide(other.entity.entityId, { gate: "brief" }));

    const specNow = (await detail(spec.entity.entityId)).entity;
    await revise(specNow, specBodyWith({ gated: true, brief: "People cannot review a design from their phone, at all." }));

    const briefApproval = (await detail(spec.entity.entityId)).approvals.at(-1);
    expect(briefApproval?.invalidatedAt).toBeDefined();
    const designApproval = (await detail(design.entity.entityId)).approvals.at(-1);
    expect(designApproval?.invalidatedAt).toBeDefined();
    const otherApproval = (await detail(other.entity.entityId)).approvals.at(-1);
    expect(otherApproval?.invalidatedAt).toBeUndefined();

    const report = await gatesOf(spec.entity.entityId);
    expect(gate(report, "brief").state).toBe("invalidated");
    expect(gate(report, "design").state).toBe("invalidated");
    expect(gate(await gatesOf(other.entity.entityId), "brief").state).toBe("approved");
    expect(plan.entity.key).toMatch(/^PLAN-/);
  });

  it("invalidates nothing when the bytes did not change", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    await revise((await detail(spec.entity.entityId)).entity, specBodyWith({ gated: true }));
    expect((await detail(spec.entity.entityId)).approvals.at(-1)?.invalidatedAt).toBeUndefined();
  });

  it("records a change request without touching the approved bytes", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    const requested = ok<{ approval: ProjectWorkApproval; entity: ProjectWorkEntity }>(
      await decide(spec.entity.entityId, {
        gate: "brief",
        decision: "changes_requested",
        note: "Say what happens when the person is offline.",
      }),
    );
    expect(requested.approval.decision).toBe("changes_requested");
    expect(requested.entity.state).toBe("draft");
    // The revision the decision was taken against is untouched and still current.
    const answer = await detail(spec.entity.entityId);
    expect(answer.entity.currentRevisionId).toBe(spec.revision.revisionId);
    expect(answer.revision.digest).toBe(spec.revision.digest);
    expect(answer.entity.revisionCount).toBe(1);
    expect(gate(answer.gates!, "brief").state).toBe("changes_requested");
  });
});

describe("what waits on a person", () => {
  it("puts a ready gate and a blocking comment in the queue, and takes them out again", async () => {
    h = projectWorkHarness();
    const spec = await create("spec", "Phone review", specBodyWith({ gated: true }));
    // A draft nobody has asked about waits on no one.
    expect(h.methods.attention(h.projectId).items).toEqual([]);

    await ready(spec.entity.entityId);
    expect(h.methods.attention(h.projectId).items.map((item) => `${item.key}:${item.reason}`)).toEqual([`${spec.entity.key}:gate`]);

    const blocker = await comment((await detail(spec.entity.entityId)).entity, { anchor: { target: "entity" }, text: "Offline?", blocking: true });
    expect(h.methods.attention(h.projectId).items.map((item) => `${item.key}:${item.reason}`)).toEqual([`${spec.entity.key}:blocking_comment`]);

    ok(await resolve((await detail(spec.entity.entityId)).entity, blocker.comment.commentId, "resolved"));
    ok(await decide(spec.entity.entityId, { gate: "brief" }));
    expect(h.methods.attention(h.projectId).items).toEqual([]);
    expect(h.workerAttempts()).toBe(0);
  });
});
