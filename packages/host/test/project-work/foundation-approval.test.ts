/**
 * Approving a greenfield foundation, against the real authority (M21-T14,
 * review follow-up F2).
 *
 * The window's Foundation wizard draws a badge, a "Create the plan" action
 * and a refusal from one question: *is this exact revision approved?* This
 * file proves the answers it reads are the host's, by taking the same two
 * steps the wizard takes through `Router.handle` — no worker, no model:
 *
 * 1. **A design no Spec gates can still be approved.** Gates bind only when
 *    a Spec opts in (D-352), and off that path the host records the person's
 *    decision against exact digests rather than refusing it. That is what
 *    makes the standalone path in the wizard legal rather than invented.
 * 2. **Reopening or editing the foundation invalidates that approval.** A
 *    material revision to an approved design invalidates the approval that
 *    covered it, and the entity stops being approved — which is exactly why
 *    the wizard reads the approval row instead of the body's own
 *    `status`/`profile` fields, which a revision carries along unchanged.
 * 3. **Nothing here needs the body to be honest.** A body still claiming
 *    `status: "approved"` after the reopen is not evidence of anything, and
 *    the host's answer says so.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  foundationCanonicalJson,
  type ApprovedRevision,
  type DesignFoundation,
  type ProjectWorkApproval,
  type ProjectWorkBody,
  type ProjectWorkDetail,
  type ProjectWorkEntity,
  type ProjectWorkRevision,
} from "@lasercode/protocol";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

let keys = 0;
const idem = (): string => `k${++keys}`;

interface WriteResult {
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  seq: number;
}

/** Two steps of a foundation, so "reopened" is a real difference in bytes. */
function foundationWith(options: { principles?: string[]; accepted?: boolean; approved?: boolean } = {}): DesignFoundation {
  const state = options.accepted === false ? ("proposed" as const) : ("accepted" as const);
  return {
    principles: options.principles ?? ["One colour carries meaning.", "Nothing below 12px."],
    status: options.approved === true ? "approved" : "proposed",
    steps: [
      { id: "principles", state, source: "person" },
      { id: "primitive_tokens", state, source: "model", model: "smart-1" },
    ],
    tokens: { color: { bg: { $type: "color", $value: "#ffffff" }, ink: { $type: "color", $value: "#111111" } } },
    ...(options.approved === true ? { profile: { version: 1, digest: "d".repeat(64), approvedAt: "2026-02-03T10:00:00.000Z" } } : {}),
  } as DesignFoundation;
}

/** A greenfield design: a foundation and no screens, which is Case A exactly. */
function designBodyWith(foundation: DesignFoundation): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief: "A greenfield foundation for a reading app.",
      foundation,
      screens: [],
      flows: [],
      sketches: [],
      fidelity: "proposed",
      fixtures: [],
    },
  };
}

async function create(title: string, body: ProjectWorkBody): Promise<WriteResult> {
  return ok<WriteResult>(await h.call("project/work/create", { projectId: h.projectId, kind: "design", title, body, idempotencyKey: idem() }));
}

async function revise(entity: ProjectWorkEntity, body: ProjectWorkBody, note?: string): Promise<WriteResult> {
  return ok<WriteResult>(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      body,
      ...(note === undefined ? {} : { note }),
      idempotencyKey: idem(),
    }),
  );
}

async function detail(entityId: string): Promise<ProjectWorkDetail> {
  return ok<ProjectWorkDetail>(await h.call("project/work/get", { projectId: h.projectId, entityId, include: { approvals: true } }));
}

const coverNow = (entity: ProjectWorkEntity): ApprovedRevision => ({
  entityId: entity.entityId,
  kind: entity.kind,
  key: entity.key,
  revisionId: entity.currentRevisionId,
  digest: entity.currentDigest,
});

/** Ask for the decision: the spine has no `draft → approved` edge. */
async function requestReview(entity: ProjectWorkEntity): Promise<ProjectWorkEntity> {
  if (entity.state !== "draft") return entity;
  ok(
    await h.call("project/work/review", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      action: "request_review",
      idempotencyKey: idem(),
    }),
  );
  return (await detail(entity.entityId)).entity;
}

/** The wizard's own approve call, with the covers it assembles from the read. */
async function approveDesign(entity: ProjectWorkEntity, covers?: ApprovedRevision[]) {
  return h.call("project/work/approve", {
    projectId: h.projectId,
    entityId: entity.entityId,
    expectedRevisionId: entity.currentRevisionId,
    gate: "design",
    decision: "approved",
    covers: covers ?? [coverNow(entity)],
    idempotencyKey: idem(),
  });
}

const approvalsOf = (answer: ProjectWorkDetail): ProjectWorkApproval[] => (answer as unknown as { approvals: ProjectWorkApproval[] }).approvals;

describe("a foundation on a design no spec gates", () => {
  it("is approved on the design itself, covering the exact revision and digest", async () => {
    h = projectWorkHarness();
    const design = await create("Design foundation", designBodyWith(foundationWith({ approved: true })));
    // Nothing gates it: no Spec, so no gate report at all on the read.
    const before = await detail(design.entity.entityId);
    expect((before as unknown as { gates?: unknown }).gates).toBeUndefined();

    const ready = await requestReview(before.entity);
    ok(await approveDesign(ready));

    const after = await detail(design.entity.entityId);
    const approvals = approvalsOf(after);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.gate).toBe("design");
    expect(approvals[0]?.decision).toBe("approved");
    expect(approvals[0]?.invalidatedAt).toBeUndefined();
    expect(approvals[0]?.origin.actor.kind).toBe("person");
    expect(approvals[0]?.covers).toEqual([
      { entityId: design.entity.entityId, kind: "design", key: design.entity.key, revisionId: ready.currentRevisionId, digest: ready.currentDigest },
    ]);
    expect(after.entity.state).toBe("approved");
  });

  it("refuses a decision whose covers are not what the store holds", async () => {
    h = projectWorkHarness();
    const design = await create("Design foundation", designBodyWith(foundationWith()));
    const ready = await requestReview(design.entity);
    const stale = { ...coverNow(ready), digest: "f".repeat(64) };
    const refusal = failed(await approveDesign(ready, [stale]));
    expect(refusal.message).toMatch(/changed since this was prepared/i);
    expect(approvalsOf(await detail(design.entity.entityId))).toHaveLength(0);
  });

  it("refuses to approve a design nobody asked a decision on", async () => {
    h = projectWorkHarness();
    const design = await create("Design foundation", designBodyWith(foundationWith()));
    const refusal = failed(await approveDesign(design.entity));
    expect(refusal.message).toMatch(/draft cannot become approved/i);
    expect(approvalsOf(await detail(design.entity.entityId))).toHaveLength(0);
  });
});

describe("reopening a step after the approval", () => {
  it("invalidates the approval the person gave, and takes the design out of approved", async () => {
    h = projectWorkHarness();
    const approved = foundationWith({ approved: true });
    const design = await create("Design foundation", designBodyWith(approved));
    const ready = await requestReview(design.entity);
    ok(await approveDesign(ready));
    const settled = await detail(design.entity.entityId);
    expect(settled.entity.state).toBe("approved");

    // The person reopens one step in the wizard and saves. The body carries
    // `status: "approved"` and its profile digest along unchanged — which is
    // precisely why the body is not the authority.
    const reopened: DesignFoundation = {
      ...approved,
      steps: (approved.steps ?? []).map((step) => (step.id === "principles" ? { ...step, state: "proposed" as const } : step)),
    };
    expect(foundationCanonicalJson(reopened)).toBe(foundationCanonicalJson(approved));
    await revise(settled.entity, designBodyWith(reopened), "Principles reopened");

    const after = await detail(design.entity.entityId);
    const approvals = approvalsOf(after);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.invalidatedAt).toBeDefined();
    expect(after.entity.state).not.toBe("approved");
    // The stale body still claims it: the claim is worth nothing.
    const body = (after as unknown as { body?: { body?: ProjectWorkBody } }).body?.body;
    if (body?.kind === "design") expect(body.design.foundation?.status).toBe("approved");
  });

  it("invalidates it for an edit to the foundation's own content too", async () => {
    h = projectWorkHarness();
    const design = await create("Design foundation", designBodyWith(foundationWith({ approved: true })));
    const ready = await requestReview(design.entity);
    ok(await approveDesign(ready));

    const edited = foundationWith({ approved: true, principles: ["One colour carries meaning.", "Quiet by default."] });
    await revise((await detail(design.entity.entityId)).entity, designBodyWith(edited), "Principles edited");

    const approvals = approvalsOf(await detail(design.entity.entityId));
    expect(approvals[0]?.invalidatedAt).toBeDefined();
  });

  /**
   * A save that changed nothing is not a material change: the host keeps the
   * approval, because the digest — not the act of pressing save — is the test
   * of "material". The *entity state* does return to draft, which is the
   * review spine's own rule about a revised artifact; the window's Foundation
   * badge therefore reads the approval and its digest, not the state.
   */
  it("keeps the approval when a save changes no bytes at all", async () => {
    h = projectWorkHarness();
    const same = foundationWith({ approved: true });
    const design = await create("Design foundation", designBodyWith(same));
    const ready = await requestReview(design.entity);
    ok(await approveDesign(ready));

    await revise((await detail(design.entity.entityId)).entity, designBodyWith(same), "Saved again, unchanged");

    const after = await detail(design.entity.entityId);
    const approval = approvalsOf(after)[0];
    expect(approval?.invalidatedAt).toBeUndefined();
    // Byte-identical: the decision still covers exactly what is on screen.
    expect(approval?.covers[0]?.digest).toBe(after.entity.currentDigest);
    expect(after.entity.state).toBe("draft");
  });

  it("can be approved again once the person has settled it", async () => {
    h = projectWorkHarness();
    const design = await create("Design foundation", designBodyWith(foundationWith({ approved: true })));
    ok(await approveDesign(await requestReview(design.entity)));
    await revise((await detail(design.entity.entityId)).entity, designBodyWith(foundationWith({ approved: true, principles: ["Quiet by default."] })), "Reworked");

    const reopened = (await detail(design.entity.entityId)).entity;
    ok(await approveDesign(await requestReview(reopened)));

    const after = await detail(design.entity.entityId);
    const approvals = approvalsOf(after);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.invalidatedAt).toBeDefined();
    expect(approvals[1]?.invalidatedAt).toBeUndefined();
    expect(approvals[1]?.covers[0]?.revisionId).toBe(after.entity.currentRevisionId);
    expect(after.entity.state).toBe("approved");
  });
});
