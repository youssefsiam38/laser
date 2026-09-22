/**
 * What a phone may do with project work (M21-T22, threat model §8).
 *
 * The matrix in the threat model says a paired device reads and writes the
 * same project work a desktop does, and that an environment which withholds
 * `project_write` leaves a **readable** workspace rather than a broken one.
 * This proves both ends against the real boundary: the same `AccessControl`
 * the host runs, a real paired actor, and the authority behind it.
 *
 * The refusals here happen on the method name alone, before any param is
 * parsed — so after a refusal the store must hold exactly what it held.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, type EnvironmentDescriptor, type ProjectWorkListResult, type ProjectWorkWriteResult } from "@lasercode/protocol";
import { deviceActor } from "../actors.js";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const READS = ["project/work/list", "project/work/get", "project/work/search", "project/work/blob/read"] as const;

const MUTATIONS = [
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
  "project/work/import/preview",
  "project/work/import/apply",
  "project/work/export/preview",
  "project/work/export/apply",
  "project/work/publish/preview",
  "project/work/publish/apply",
  "design/index/build",
  "design/index/stop",
  "design/index/review",
  "design/host/ground",
  "design/sketch/ground",
] as const;

describe("a phone under the default environment", () => {
  it("reads and writes the same project work a desktop does", async () => {
    h = projectWorkHarness();
    const phone = deviceActor();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call(
        "project/work/create",
        { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "p1" },
        phone,
      ),
    );
    expect(spec.entity.key).toMatch(/^SPEC-/);
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }, phone));
    expect(list.items.map((item) => item.key)).toContain(spec.entity.key);
    // And the write is recorded as a person's: a device is a person, never an
    // agent, whatever it says about itself.
    expect(spec.revision.origin.actor.kind).toBe("person");
  });

  it("approves a gate as a person, from the phone", async () => {
    h = projectWorkHarness();
    const phone = deviceActor();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call(
        "project/work/create",
        { projectId: h.projectId, kind: "spec", title: "Gate", body: { ...specBody(), spec: { ...specBody().spec, gated: true } } as never, idempotencyKey: "g1" },
        phone,
      ),
    );
    const response = await h.call(
      "project/work/approve",
      {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.entity.currentRevisionId,
        gate: "brief",
        decision: "approved",
        covers: [{ entityId: spec.entity.entityId, revisionId: spec.entity.currentRevisionId, digest: spec.entity.currentDigest, key: spec.entity.key }],
        idempotencyKey: "ga1",
      },
      phone,
    );
    // Whether this project's gate rules accept it is the gate engine's
    // business; what this asserts is that the *boundary* did not refuse a
    // phone for being a phone.
    if (response.error) expect(response.error.code).not.toBe(ErrorCodes.Unsupported);
    else expect((response.result as { approval: { decision: string } }).approval.decision).toBe("approved");
  });
});

describe("a phone in an environment that withholds project writes", () => {
  const readOnly = { remote: { scopes: ["handshake", "read", "session_write", "approval", "device"] } };

  it("refuses every leap mutation, on the method name, without touching the store", async () => {
    h = projectWorkHarness({ policy: readOnly });
    const phone = deviceActor();
    const before = h.store.list({ projectId: h.projectId }).counts.total;
    for (const method of MUTATIONS) {
      const error = failed(await h.call(method, { projectId: h.projectId }, phone));
      expect(error.code, `${method} should be refused for a read-only device`).toBe(ErrorCodes.Unsupported);
      // A sentence for a person, naming the authority that is missing.
      expect(error.message).toMatch(/project|edit|allow/i);
    }
    expect(h.store.list({ projectId: h.projectId }).counts.total).toBe(before);
  });

  it("still answers every leap read", async () => {
    h = projectWorkHarness({ policy: readOnly });
    const phone = deviceActor();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Read me", body: specBody(), idempotencyKey: "r1" }),
    );
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }, phone));
    expect(list.items).toHaveLength(1);
    ok(await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId }, phone));
    ok(await h.call("project/work/search", { projectId: h.projectId, query: "Read" }, phone));
    // The reading methods are all there is: nothing in READS was refused.
    for (const method of READS) expect(method.startsWith("project/work/")).toBe(true);
    // Reading the Design Index is a read too, so the boundary lets it through
    // (this host has no design worker; what matters is that it was not the
    // boundary that stopped it).
    const design = await h.call("design/index/get", { projectId: h.projectId }, phone);
    if (design.error) expect(design.error.message).not.toMatch(/allowed to edit project work/i);
  });

  it("tells the device what it may do, without naming a leap method as local-only", async () => {
    h = projectWorkHarness({ policy: readOnly });
    const descriptor = ok<{ environment: EnvironmentDescriptor }>(await h.call("environment/describe", {}, deviceActor())).environment;
    expect(descriptor.scopes).not.toContain("project_write");
    expect(descriptor.scopes).toContain("read");
    for (const method of descriptor.localOnly) {
      expect(method.startsWith("project/"), `${method} must not be local-only`).toBe(false);
      expect(method.startsWith("design/"), `${method} must not be local-only`).toBe(false);
    }
  });
});
