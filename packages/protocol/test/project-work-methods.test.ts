/**
 * M21-T1: the method inventory.
 *
 * Every method in the leap's "Protocol and authority" table exists, parses a
 * round-trip sample, has a policy row, a byte limit, and — for a mutation —
 * both `expectedRevisionId` (or the create/idempotent equivalent) and an
 * `idempotencyKey`. Both notifications have a scope row and a pressure row.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_WORK_METHODS,
  PROJECT_WORK_METHOD_LIMITS,
  PROJECT_WORK_NOTIFICATIONS,
  PROJECT_WORK_READ_METHODS,
  PROJECT_WORK_WRITE_METHODS,
  projectWorkAttentionSchema,
  projectWorkParamsSchemas,
  projectWorkUpdatedSchema,
  type ProjectWorkMethod,
  type ProjectWorkQuotaRefusal,
} from "../src/project-work-methods.js";
import {
  DECISION_PROOF_KINDS,
  REPOSITORY_CAPTURE_HISTORY_MAX,
  type DecisionCaptureBinding,
  type RepositoryCaptureHistoryPage,
} from "../src/project-work.js";
import { clientParamsSchemas, parseClientRequest, ProtocolError } from "../src/schemas.js";
import { METHOD_POLICY, NOTIFICATION_SCOPE, methodPolicy, notificationScope } from "../src/method-policy.js";
import { NOTIFICATION_PRESSURE, isSheddable } from "../src/transport-pressure.js";
import { sampleMethodParams, SAMPLE_PROJECT_ID, SAMPLE_ENTITY_ID, SAMPLE_REVISION_ID } from "./project-work-samples.js";

/** The inventory as the leap writes it, in the leap's own order. */
const INVENTORY: readonly ProjectWorkMethod[] = [
  "project/work/list",
  "project/work/get",
  "project/work/search",
  "project/work/blob/read",
  "project/work/create",
  "project/work/revise",
  "project/work/archive",
  "project/work/delete",
  "project/work/comment",
  "project/work/review",
  "project/work/approve",
  "project/work/resolve-comment",
  "project/work/link",
  "project/work/unlink",
  "project/task/action",
  "project/task/link-execution",
];

describe("the inventory", () => {
  it("is exactly the leap's list", () => {
    expect([...PROJECT_WORK_METHODS].sort()).toEqual([...INVENTORY].sort());
    expect([...PROJECT_WORK_READ_METHODS, ...PROJECT_WORK_WRITE_METHODS].sort()).toEqual([...INVENTORY].sort());
  });

  it("registers every method with the client schema table", () => {
    for (const method of INVENTORY) {
      expect(Object.prototype.hasOwnProperty.call(clientParamsSchemas, method)).toBe(true);
    }
  });

  it("round-trips one sample per method through the wire parser", () => {
    for (const method of INVENTORY) {
      const params = sampleMethodParams[method];
      const parsed = parseClientRequest({ jsonrpc: "2.0", id: 1, method, params });
      expect(parsed.method).toBe(method);
      expect(parsed.params).toEqual(projectWorkParamsSchemas[method].parse(params));
    }
  });

  it("refuses a field the table does not know", () => {
    expect(() =>
      parseClientRequest({ jsonrpc: "2.0", id: 1, method: "project/work/list", params: { projectId: SAMPLE_PROJECT_ID, sessionId: "ses_1" } }),
    ).toThrow(ProtocolError);
  });

  it("makes every mutation carry an idempotency key and the revision it expects", () => {
    for (const method of PROJECT_WORK_WRITE_METHODS) {
      const params = sampleMethodParams[method] as Record<string, unknown>;
      expect(params["idempotencyKey"]).toBeTypeOf("string");
      const { idempotencyKey: _dropped, ...withoutKey } = params;
      expect(projectWorkParamsSchemas[method].safeParse(withoutKey).success).toBe(false);
      // Every mutation fences on the revision the caller believed was current.
      // `create` is the one exception, and only because there is nothing yet to
      // be stale against.
      if (method === "project/work/create") {
        expect(params["expectedRevisionId"]).toBeUndefined();
        continue;
      }
      expect(params["expectedRevisionId"]).toBe(SAMPLE_REVISION_ID);
      const { expectedRevisionId: _revision, ...withoutRevision } = params;
      expect(projectWorkParamsSchemas[method].safeParse(withoutRevision).success).toBe(false);
    }
  });

  it("refuses a body that is not the kind being created", () => {
    const params = sampleMethodParams["project/work/create"] as Record<string, unknown>;
    expect(projectWorkParamsSchemas["project/work/create"].safeParse({ ...params, kind: "task" }).success).toBe(false);
  });

  it("requires an entity id or a key on get, and never both forms of neither", () => {
    expect(projectWorkParamsSchemas["project/work/get"].safeParse({ projectId: SAMPLE_PROJECT_ID }).success).toBe(false);
    expect(projectWorkParamsSchemas["project/work/get"].safeParse({ projectId: SAMPLE_PROJECT_ID, entityId: SAMPLE_ENTITY_ID }).success).toBe(true);
    expect(projectWorkParamsSchemas["project/work/get"].safeParse({ projectId: SAMPLE_PROJECT_ID, key: "TASK-44" }).success).toBe(true);
    expect(projectWorkParamsSchemas["project/work/get"].safeParse({ projectId: SAMPLE_PROJECT_ID, key: "ISSUE-44" }).success).toBe(false);
  });

  it("treats delete without confirm as the preview, and refuses a false confirm", () => {
    const params = sampleMethodParams["project/work/delete"] as Record<string, unknown>;
    const { confirm: _confirm, ...preview } = params;
    expect(projectWorkParamsSchemas["project/work/delete"].safeParse(preview).success).toBe(true);
    expect(projectWorkParamsSchemas["project/work/delete"].safeParse({ ...params, confirm: false }).success).toBe(false);
  });

  it("names the replacement when an entity is superseded", () => {
    const base = { projectId: SAMPLE_PROJECT_ID, entityId: SAMPLE_ENTITY_ID, expectedRevisionId: SAMPLE_REVISION_ID, idempotencyKey: "r1" };
    expect(projectWorkParamsSchemas["project/work/review"].safeParse({ ...base, action: "supersede" }).success).toBe(false);
    expect(
      projectWorkParamsSchemas["project/work/review"].safeParse({ ...base, action: "supersede", supersededByEntityId: "wk_next" }).success,
    ).toBe(true);
  });
});

describe("policy", () => {
  it("gives every method a row: reads are `read`, mutations are not", () => {
    for (const method of PROJECT_WORK_READ_METHODS) {
      expect(methodPolicy(method)).toEqual({ scope: "read", reach: "any" });
    }
    for (const method of PROJECT_WORK_WRITE_METHODS) {
      const policy = methodPolicy(method);
      expect(policy).toBeDefined();
      expect(policy?.reach).toBe("any");
      expect(policy?.scope).not.toBe("read");
      // D-332: lifecycle approval never borrows the session-question scope.
      expect(policy?.scope).not.toBe("approval");
      expect(policy?.scope).not.toBe("session_write");
    }
  });

  it("never marks a project-work method as starting work", () => {
    for (const method of PROJECT_WORK_METHODS) {
      expect((METHOD_POLICY as Record<string, { startsWork?: true }>)[method]?.startsWork).toBeUndefined();
    }
  });

  it("gives both notifications a scope and keeps them unsheddable state", () => {
    for (const notification of PROJECT_WORK_NOTIFICATIONS) {
      expect(notificationScope(notification)).toBe("read");
      expect(Object.prototype.hasOwnProperty.call(NOTIFICATION_SCOPE, notification)).toBe(true);
      expect((NOTIFICATION_PRESSURE as Record<string, string>)[notification]).toBe("state");
      expect(isSheddable(notification)).toBe(false);
    }
  });
});

describe("bounds", () => {
  it("gives every method a byte limit, and sizes the body-carrying ones for a body", () => {
    for (const method of PROJECT_WORK_METHODS) {
      const limit = PROJECT_WORK_METHOD_LIMITS[method];
      expect(limit).toBeGreaterThan(0);
      if (method === "project/work/create" || method === "project/work/revise") {
        expect(limit).toBeGreaterThan(1024 * 1024);
      } else {
        expect(limit).toBeLessThanOrEqual(64 * 1024);
      }
    }
  });

  it("caps a list page, a search and a ranged read", () => {
    expect(projectWorkParamsSchemas["project/work/list"].safeParse({ projectId: SAMPLE_PROJECT_ID, limit: 1000 }).success).toBe(false);
    expect(projectWorkParamsSchemas["project/work/search"].safeParse({ query: "x", limit: 1000 }).success).toBe(false);
    expect(
      projectWorkParamsSchemas["project/work/blob/read"].safeParse({ projectId: SAMPLE_PROJECT_ID, blobId: "blb_1", limit: 10 * 1024 * 1024 }).success,
    ).toBe(false);
  });
});

describe("a refused durable write", () => {
  it("keeps byte numbers as bytes and carries a count ceiling as a count", () => {
    // The shape a byte refusal has always had, unchanged: no `measure`, and
    // the two byte numbers say what they say.
    const bytes: ProjectWorkQuotaRefusal = {
      refused: "quota",
      scope: "project",
      recovery: "Export or permanently delete some of this project's saved work and try again.",
      usedBytes: 512 * 1024 * 1024,
      limitBytes: 512 * 1024 * 1024,
    };
    expect(bytes.measure).toBeUndefined();
    expect(bytes.usedCount).toBeUndefined();

    // A count ceiling reports the count separately. `usedBytes` still holds
    // real bytes, so nothing downstream can render rows as megabytes.
    const records: ProjectWorkQuotaRefusal = {
      ...bytes,
      measure: "records",
      usedCount: 200_001,
      limitCount: 200_000,
      usedBytes: 12_345,
    };
    expect(records.usedCount).toBeGreaterThan(records.limitCount!);
    expect(records.usedBytes).not.toBe(records.usedCount);
    expect(records.limitBytes).not.toBe(records.limitCount);
  });
});

describe("notifications", () => {
  it("carries identity, a summary and the project sequence — never a body", () => {
    const updated = projectWorkUpdatedSchema.parse({
      projectId: SAMPLE_PROJECT_ID,
      seq: 42,
      change: {
        change: "revised",
        entityId: SAMPLE_ENTITY_ID,
        entityKind: "spec",
        key: "SPEC-12",
        title: "Phone review",
        state: "needs_review",
        revisionId: SAMPLE_REVISION_ID,
        digest: "a".repeat(64),
        at: "2026-01-01T00:00:00.000Z",
        actorLabel: "You",
        sessionId: "ses_1",
      },
    });
    expect(updated.seq).toBe(42);
    expect(
      projectWorkUpdatedSchema.safeParse({
        projectId: SAMPLE_PROJECT_ID,
        seq: 1,
        change: { change: "revised", entityId: SAMPLE_ENTITY_ID, entityKind: "spec", key: "SPEC-12", title: "t", state: "draft", at: "now", body: {} },
      }).success,
    ).toBe(false);
  });

  it("takes a delivery only as an explicit acceptance of an exact change (M21-T18)", () => {
    const schema = projectWorkParamsSchemas["project/work/link"];
    const state = { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "1".repeat(40) };
    const delivery = {
      type: "delivery" as const,
      entityId: SAMPLE_ENTITY_ID,
      revisionId: SAMPLE_REVISION_ID,
      repositoryId: "repo_1",
      change: { base: state, head: { ...state, commitObjectId: "2".repeat(40) }, diffDigest: "d".repeat(64) },
      covers: [{ entityId: "wk_other", revisionId: "rev_other" }],
      display: { branch: "main", pullRequest: { number: 7, host: "github" } },
      confirm: true as const,
    };
    const base = { projectId: SAMPLE_PROJECT_ID, expectedRevisionId: SAMPLE_REVISION_ID, idempotencyKey: "accept-1" };
    expect(schema.safeParse({ ...base, link: delivery }).success).toBe(true);
    // Accepting delivery is explicit: no confirmation, no acceptance.
    const { confirm: _dropped, ...unconfirmed } = delivery;
    expect(schema.safeParse({ ...base, link: unconfirmed }).success).toBe(false);
    // And it names a change, never a bare state.
    const { change: _change, ...stateOnly } = delivery;
    expect(schema.safeParse({ ...base, link: { ...stateOnly, target: { state } } }).success).toBe(false);
  });

  it("carries the attempt a verified state came out of, as identity the host re-derives (M21-T19)", () => {
    const schema = projectWorkParamsSchemas["project/work/link"];
    const state = { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "1".repeat(40), checkpointId: "refs/x/1" };
    const link = (verifiedAt: unknown) => ({
      projectId: SAMPLE_PROJECT_ID,
      expectedRevisionId: SAMPLE_REVISION_ID,
      idempotencyKey: "accept-1",
      link: {
        type: "evidence" as const,
        entityId: SAMPLE_ENTITY_ID,
        revisionId: SAMPLE_REVISION_ID,
        kind: "person_acceptance" as const,
        role: "acceptance" as const,
        summary: "I looked at the build.",
        outcome: "passed" as const,
        verifiedAt,
      },
    });
    const attempt = { taskEntityId: SAMPLE_ENTITY_ID, executionLinkId: "lnk_1" };
    expect(
      schema.safeParse(link({ repositoryId: "repo_1", state, acceptance: { kind: "checkpoint_preview" }, attempt })).success,
    ).toBe(true);
    // A plain state link needs none of it, and is not native evidence.
    expect(schema.safeParse(link({ repositoryId: "repo_1", state })).success).toBe(true);
    // The attempt is two exact ids or nothing: a half-named one is refused at
    // the boundary, and an acceptance with none of it is refused by the host,
    // in a sentence that says which attempt it needs.
    expect(schema.safeParse(link({ repositoryId: "repo_1", state, attempt: { executionLinkId: "lnk_1" } })).success).toBe(false);
    expect(schema.safeParse(link({ repositoryId: "repo_1", state, attempt: { ...attempt, extra: 1 } })).success).toBe(false);
  });

  it("lets a read ask git what it still has, and defaults to not asking", () => {
    const schema = projectWorkParamsSchemas["project/work/get"];
    const base = { projectId: SAMPLE_PROJECT_ID, entityId: SAMPLE_ENTITY_ID };
    expect(schema.parse({ ...base, include: { links: true, repositoryStatus: true } }).include?.repositoryStatus).toBe(true);
    expect(schema.parse(base).include?.repositoryStatus).toBeUndefined();
  });

  it("lets a read ask for one bounded page of capture history, and defaults to not asking", () => {
    const schema = projectWorkParamsSchemas["project/work/get"];
    const base = { projectId: SAMPLE_PROJECT_ID, entityId: SAMPLE_ENTITY_ID };
    // The history is a separate question from the link's current pointer, so it
    // is opt-in — and a **selection** rather than a flag, because "every
    // association of every link" is not a bounded answer (D-363).
    expect(
      schema.parse({ ...base, include: { links: true, captureHistory: { of: "associations", linkId: "lnk_1", limit: 10 } } }).include
        ?.captureHistory,
    ).toEqual({ of: "associations", linkId: "lnk_1", limit: 10 });
    expect(
      schema.parse({ ...base, include: { captureHistory: { of: "decisions", decisionId: "apv_1" } } }).include?.captureHistory?.of,
    ).toBe("decisions");
    expect(schema.parse(base).include?.captureHistory).toBeUndefined();
    // A flag, an unknown selection, a page past the bound and an unknown
    // member are all refused at the boundary rather than clamped in the host.
    expect(schema.safeParse({ ...base, include: { captureHistory: true } }).success).toBe(false);
    expect(schema.safeParse({ ...base, include: { captureHistory: { of: "everything" } } }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, include: { captureHistory: { of: "associations", limit: REPOSITORY_CAPTURE_HISTORY_MAX + 1 } } }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...base, include: { captureHistory: { of: "associations", cursor: "" } } }).success).toBe(false);
    expect(schema.safeParse({ ...base, include: { captureHistory: { of: "associations", every: true } } }).success).toBe(false);
  });

  it("names the two decisions that bind the proof they consumed, and nothing else", () => {
    // A short closed list on purpose: these are the acts that may not be taken
    // on evidence nobody can read afterwards. A third is a decision with its
    // own row, not a shape that quietly accepts one (D-363).
    expect([...DECISION_PROOF_KINDS]).toEqual(["approval", "task_completion"]);
    const binding: DecisionCaptureBinding = {
      kind: "approval",
      decisionId: "apv_1",
      entityId: SAMPLE_ENTITY_ID,
      linkId: "lnk_1",
      blobId: "blb_1",
      associationRevisionId: "rlc_1",
      associationSeq: 2,
      boundAt: "2026-03-01T09:00:00.000Z",
    };
    const page: RepositoryCaptureHistoryPage = { of: "decisions", associations: [], bindings: [binding], known: true };
    expect(page.bindings[0]?.blobId, "a decision names a capture by content address, never a pointer").toBe("blb_1");
    expect(page.known, "and whether this store knows what it rested on at all").toBe(true);
  });

  it("keeps the attention count exact even when the item list is cut", () => {
    const attention = projectWorkAttentionSchema.parse({
      projectId: SAMPLE_PROJECT_ID,
      seq: 7,
      needsYou: 120,
      items: [{ entityId: SAMPLE_ENTITY_ID, kind: "spec", key: "SPEC-12", title: "Phone review", reason: "gate", at: "2026-01-01T00:00:00.000Z" }],
      truncated: true,
    });
    expect(attention.needsYou).toBe(120);
    expect(attention.items).toHaveLength(1);
  });
});
