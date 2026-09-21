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
} from "../src/project-work-methods.js";
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
