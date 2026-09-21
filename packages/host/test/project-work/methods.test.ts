/**
 * M21-T3: the host's authority over project work, over the wire.
 *
 * Everything here goes through `Router.handle` with a real JSON-RPC envelope,
 * so the strict param schemas, the method policy, the actor the boundary
 * proved and the error mapping are all exercised — and the worker pool throws
 * on every way of reaching a worker, which is how "the host answers project
 * work without starting one" is proved rather than asserted.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCodes,
  PROJECT_WORK_CONFLICT_CODE,
  type ProjectWorkAttentionNotification,
  type ProjectWorkConflict,
  type ProjectWorkEntity,
  type ProjectWorkListResult,
  type ProjectWorkUpdatedNotification,
  type ProjectWorkWriteResult,
} from "@lasercode/protocol";
import { deviceAccess } from "../actors.js";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const anchor = { target: "entity" } as const;

async function createSpec(harness: ProjectWorkHarness, title = "Phone review", key = "c1"): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await harness.call("project/work/create", {
      projectId: harness.projectId,
      kind: "spec",
      title,
      body: specBody(),
      idempotencyKey: key,
    }),
  );
}

async function createTask(harness: ProjectWorkHarness, title = "Make the footer sticky", key = "t1"): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await harness.call("project/work/create", {
      projectId: harness.projectId,
      kind: "task",
      title,
      body: taskBody(),
      idempotencyKey: key,
    }),
  );
}

describe("the whole inventory, answered by the host", () => {
  it("routes every method against the store without ever reaching for a worker", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    const task = await createTask(h);

    // Review: a comment, a request for review, an approval, a resolution.
    const comment = ok<{ comment: { commentId: string }; entity: ProjectWorkEntity }>(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        revisionId: spec.revision.revisionId,
        anchor,
        text: "The footer needs a thumb-reachable approve button.",
        blocking: true,
        idempotencyKey: "cm1",
      }),
    );
    expect(comment.entity.blockingComments).toBe(1);
    const resolved = ok<{ comment: { state: string } }>(
      await h.call("project/work/resolve-comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        commentId: comment.comment.commentId,
        resolution: "resolved",
        idempotencyKey: "rc1",
      }),
    );
    expect(resolved.comment.state).toBe("resolved");
    const reviewed = ok<{ entity: ProjectWorkEntity }>(
      await h.call("project/work/review", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        action: "request_review",
        idempotencyKey: "rv1",
      }),
    );
    expect(reviewed.entity.state).toBe("needs_review");
    const approved = ok<{ entity: ProjectWorkEntity; approval: { gate: string } }>(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers: [
          {
            entityId: spec.entity.entityId,
            kind: "spec",
            key: spec.entity.key,
            revisionId: spec.revision.revisionId,
            digest: spec.revision.digest,
          },
        ],
        idempotencyKey: "ap1",
      }),
    );
    expect(approved.entity.state).toBe("approved");
    expect(approved.approval.gate).toBe("brief");

    // Relations: an edge, an execution attempt, then a task transition.
    const link = ok<{ link: { type: string; edge: { linkId: string } }; seq: number }>(
      await h.call("project/work/link", {
        projectId: h.projectId,
        expectedRevisionId: task.revision.revisionId,
        link: {
          type: "edge",
          relation: "implements",
          subject: { entityId: task.entity.entityId, revisionId: task.revision.revisionId },
          object: { entityId: spec.entity.entityId, revisionId: spec.revision.revisionId },
        },
        idempotencyKey: "lk1",
      }),
    );
    expect(link.link.type).toBe("edge");
    const execution = ok<{ link: { attempt: number } }>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "session", targetId: "ses_1" },
        idempotencyKey: "ex1",
      }),
    );
    expect(execution.link.attempt).toBe(1);
    const action = ok<{ transition: { from: string; to: string } }>(
      await h.call("project/task/action", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        action: "mark_ready",
        idempotencyKey: "ta1",
      }),
    );
    expect(action.transition).toEqual({ from: "draft", to: "ready" });
    ok(
      await h.call("project/work/unlink", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        linkId: link.link.edge.linkId,
        idempotencyKey: "ul1",
      }),
    );

    // Writes: revise, archive, then delete (preview first, then confirmed).
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("People cannot review a design away from their desk."),
        idempotencyKey: "rz1",
      }),
    );
    expect(revised.revision.index).toBe(2);
    const archived = ok<{ entity: ProjectWorkEntity }>(
      await h.call("project/work/archive", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        archived: true,
        idempotencyKey: "ar1",
      }),
    );
    expect(archived.entity.archivedAt).toBeTypeOf("string");
    const preview = ok<{ deleted: boolean; orphans: unknown[] }>(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        idempotencyKey: "dl-preview",
      }),
    );
    expect(preview.deleted).toBe(false);
    expect(h.store.list({ projectId: h.projectId, includeArchived: true }).items).toHaveLength(2);
    const deleted = ok<{ deleted: boolean }>(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        confirm: true,
        idempotencyKey: "dl1",
      }),
    );
    expect(deleted.deleted).toBe(true);

    // Reads: list, get, search, and a blob.
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items.map((item) => item.key)).toEqual([spec.entity.key]);
    expect(list.counts.total).toBe(1);
    const detail = ok<{ ref: { key: string }; body?: { totalBytes: number } }>(
      await h.call("project/work/get", { projectId: h.projectId, key: spec.entity.key }),
    );
    expect(detail.ref.key).toBe(spec.entity.key);
    expect(detail.body?.totalBytes).toBeGreaterThan(0);
    const search = ok<{ results: Array<{ key: string }> }>(
      await h.call("project/work/search", { projectId: h.projectId, query: spec.entity.key }),
    );
    expect(search.results[0]?.key).toBe(spec.entity.key);
    const blob = h.store.putBlob({ projectId: h.projectId, mediaType: "image/png", data: Buffer.from("not really a png") });
    const read = ok<{ data: string; totalBytes: number }>(
      await h.call("project/work/blob/read", { projectId: h.projectId, blobId: blob.blobId }),
    );
    expect(Buffer.from(read.data, "base64").toString("utf8")).toBe("not really a png");

    // The point of the whole test: nothing above started a worker.
    expect(h.workerAttempts()).toBe(0);
  });

  it("resolves a project by folder on list, and maps a worktree to its project", async () => {
    h = projectWorkHarness();
    await createSpec(h);
    const byFolder = ok<ProjectWorkListResult>(await h.call("project/work/list", { cwd: h.projectRoot }));
    expect(byFolder.projectId).toBe(h.projectId);
    expect(byFolder.items).toHaveLength(1);
    const fromWorktree = ok<ProjectWorkListResult>(
      await h.call("project/work/list", { cwd: `${h.projectRoot}/.worktrees/feature-x` }),
    );
    expect(fromWorktree.projectId).toBe(h.projectId);
    expect(fromWorktree.items).toHaveLength(1);
    expect(h.workerAttempts()).toBe(0);
  });

  it("refuses a list that names neither a project nor a folder", async () => {
    h = projectWorkHarness();
    expect(failed(await h.call("project/work/list", {})).code).toBe(ErrorCodes.InvalidParams);
  });
});

describe("optimistic concurrency", () => {
  it("refuses a stale write with the current revision, and overwrites nothing", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    const second = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("the second revision"),
        idempotencyKey: "r2",
      }),
    );
    const conflict = failed(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        // The first revision: what a second client still believed was current.
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("a third revision from a stale view"),
        idempotencyKey: "r3",
      }),
    );
    expect(conflict.code).toBe(PROJECT_WORK_CONFLICT_CODE);
    const data = conflict.data as ProjectWorkConflict;
    expect(data.conflict).toBe("revision");
    expect(data.current.revisionId).toBe(second.revision.revisionId);
    expect(data.expectedRevisionId).toBe(spec.revision.revisionId);
    expect(conflict.message).toContain(spec.entity.key);
    // Nothing was written: the entity still points at the second revision.
    const detail = ok<{ entity: ProjectWorkEntity; revision: { index: number } }>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId }),
    );
    expect(detail.entity.currentRevisionId).toBe(second.revision.revisionId);
    expect(detail.entity.revisionCount).toBe(2);
  });

  it("fences every mutation, not only the ones that write a revision", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("moved on"),
        idempotencyKey: "r2",
      }),
    );
    for (const [method, extra] of [
      ["project/work/archive", { archived: true }],
      ["project/work/review", { action: "request_review" }],
      [
        "project/work/comment",
        { revisionId: spec.revision.revisionId, anchor, text: "stale comment" },
      ],
    ] as const) {
      const error = failed(
        await h.call(method, {
          projectId: h.projectId,
          entityId: spec.entity.entityId,
          expectedRevisionId: spec.revision.revisionId,
          ...extra,
          idempotencyKey: `stale-${method.replaceAll("/", ".")}`,
        }),
      );
      expect(error.code, method).toBe(PROJECT_WORK_CONFLICT_CODE);
    }
  });
});

describe("idempotency", () => {
  it("replays the first result for the same key, through the wire", async () => {
    h = projectWorkHarness();
    const first = await createSpec(h, "Phone review", "same-key");
    const again = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "A different title entirely",
        body: specBody("and different content"),
        idempotencyKey: "same-key",
      }),
    );
    expect(again.replayed).toBe(true);
    expect(again.entity.entityId).toBe(first.entity.entityId);
    expect(again.revision.revisionId).toBe(first.revision.revisionId);
    expect(again.entity.key).toBe(first.entity.key);
    // One entity, one revision, one key number: the retry wrote nothing.
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.revisionCount).toBe(1);
  });
});

describe("the project event sequence", () => {
  it("raises an `updated` notification per change, with a rising sequence", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("revised"),
        idempotencyKey: "r2",
      }),
    );
    const updated = h.notifications
      .filter((row) => row.method === "project/work/updated")
      .map((row) => row.params as ProjectWorkUpdatedNotification);
    expect(updated.map((row) => row.change.change)).toEqual(["created", "revised"]);
    expect(updated.map((row) => row.seq)).toEqual([1, 2]);
    expect(updated[0]?.projectId).toBe(h.projectId);
    // Identity and a summary, never a body.
    expect(Object.keys(updated[1]!.change).sort()).toEqual(
      ["actorLabel", "at", "change", "digest", "entityId", "entityKind", "key", "revisionId", "state", "title"].sort(),
    );
  });

  it("announces attention only when the needs-you queue actually changes", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    const attentionAfter = (): ProjectWorkAttentionNotification[] =>
      h.notifications.filter((row) => row.method === "project/work/attention").map((row) => row.params as ProjectWorkAttentionNotification);
    // A draft spec waits on nobody, so creating it announced nothing.
    expect(attentionAfter()).toHaveLength(0);
    ok(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        revisionId: spec.revision.revisionId,
        anchor,
        text: "This needs a decision.",
        blocking: true,
        idempotencyKey: "cm1",
      }),
    );
    expect(attentionAfter()).toHaveLength(1);
    expect(attentionAfter()[0]).toMatchObject({ needsYou: 1, projectId: h.projectId });
    expect(attentionAfter()[0]?.items[0]).toMatchObject({ key: spec.entity.key, reason: "blocking_comment" });
    // A second, non-blocking comment changes nothing about who is waiting.
    ok(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        revisionId: spec.revision.revisionId,
        anchor,
        text: "A note, not a blocker.",
        idempotencyKey: "cm2",
      }),
    );
    expect(attentionAfter()).toHaveLength(1);
  });

  it("reconciles with `sinceSeq`, and says when the window is gone", async () => {
    h = projectWorkHarness({ eventsRetained: 4 });
    const spec = await createSpec(h);
    const task = await createTask(h);
    const afterCreate = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(afterCreate.seq).toBe(2);

    ok(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("revised once"),
        idempotencyKey: "r2",
      }),
    );
    const delta = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId, sinceSeq: 2 }));
    expect(delta.items.map((item) => item.key)).toEqual([spec.entity.key]);
    expect(delta.reset).toBeUndefined();

    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        confirm: true,
        idempotencyKey: "dl1",
      }),
    );
    const afterDelete = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId, sinceSeq: 3 }));
    expect(afterDelete.removed).toEqual([task.entity.entityId]);

    // Past the retained window: replace the cache, do not merge into it.
    for (let i = 0; i < 6; i++) {
      ok(
        await h.call("project/work/create", {
          projectId: h.projectId,
          kind: "spec",
          title: `Filler ${i}`,
          body: specBody(`filler ${i}`),
          idempotencyKey: `f-${i}`,
        }),
      );
    }
    const reset = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId, sinceSeq: 1 }));
    expect(reset.reset).toBe(true);
    expect(reset.items.length).toBeGreaterThan(1);
  });
});

describe("policy, reach and authorization", () => {
  it("lets a paired device read, and refuses it a write when its scopes do not carry one", async () => {
    h = projectWorkHarness();
    await createSpec(h);
    const readOnly = deviceAccess({ scopes: ["handshake", "read"] }).actor;
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }, readOnly));
    expect(list.items).toHaveLength(1);
    const refused = failed(
      await h.call(
        "project/work/create",
        { projectId: h.projectId, kind: "spec", title: "From a phone", body: specBody(), idempotencyKey: "p1" },
        readOnly,
      ),
    );
    expect(refused.code).toBe(ErrorCodes.Unsupported);
    expect(refused.message).toContain("project work");
  });

  it("lets a paired device with the project-write scope reach every method: nothing here is local-only", async () => {
    h = projectWorkHarness();
    const device = deviceAccess({ scopes: ["handshake", "read", "project_write"] }).actor;
    const created = ok<ProjectWorkWriteResult>(
      await h.call(
        "project/work/create",
        { projectId: h.projectId, kind: "spec", title: "From the relay", body: specBody(), idempotencyKey: "d1" },
        device,
      ),
    );
    expect(created.entity.title).toBe("From the relay");
    // A person on a phone is still a person: the approval path is open to it.
    ok(
      await h.call(
        "project/work/review",
        {
          projectId: h.projectId,
          entityId: created.entity.entityId,
          expectedRevisionId: created.revision.revisionId,
          action: "request_review",
          idempotencyKey: "d2",
        },
        device,
      ),
    );
    const approved = ok<{ entity: ProjectWorkEntity }>(
      await h.call(
        "project/work/approve",
        {
          projectId: h.projectId,
          entityId: created.entity.entityId,
          expectedRevisionId: created.revision.revisionId,
          gate: "brief",
          decision: "approved",
          covers: [
            {
              entityId: created.entity.entityId,
              kind: "spec",
              key: created.entity.key,
              revisionId: created.revision.revisionId,
              digest: created.revision.digest,
            },
          ],
          idempotencyKey: "d3",
        },
        device,
      ),
    );
    expect(approved.entity.state).toBe("approved");
  });

  it("refuses a device whose environment policy withheld project writes, whatever its grant says", async () => {
    h = projectWorkHarness({ policy: { remote: { scopes: ["handshake", "read"] } } });
    const device = deviceAccess({ scopes: ["handshake", "read", "project_write"] }).actor;
    const refused = failed(
      await h.call(
        "project/work/create",
        { projectId: h.projectId, kind: "spec", title: "From the relay", body: specBody(), idempotencyKey: "d1" },
        device,
      ),
    );
    expect(refused.code).toBe(ErrorCodes.Unsupported);
  });

  it("refuses an item that belongs to another project, without saying anything about it", async () => {
    h = projectWorkHarness();
    const mine = await createSpec(h);
    const otherProject = h.store.projectIdFor(`${h.dir}/beta`)!;
    const wrong = failed(
      await h.call("project/work/get", { projectId: otherProject, entityId: mine.entity.entityId }),
    );
    expect(wrong.code).toBe(ErrorCodes.InvalidParams);
    expect(wrong.message).toContain("deleted");
    const wrongWrite = failed(
      await h.call("project/work/archive", {
        projectId: otherProject,
        entityId: mine.entity.entityId,
        expectedRevisionId: mine.revision.revisionId,
        archived: true,
        idempotencyKey: "x1",
      }),
    );
    expect(wrongWrite.code).toBe(ErrorCodes.InvalidParams);
  });

  it("refuses a project id this host has never minted", async () => {
    h = projectWorkHarness();
    expect(failed(await h.call("project/work/list", { projectId: "pj_nothing" })).code).toBe(ErrorCodes.InvalidParams);
  });

  it("keeps a declined project readable and refuses every change to it", async () => {
    const declined = new Set<string>();
    h = projectWorkHarness({ trustOf: (root) => (declined.has(root) ? "declined" : "not_required") });
    const spec = await createSpec(h);
    declined.add(h.projectRoot);
    const read = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(read.items).toHaveLength(1);
    const refused = failed(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("a change to an untrusted project"),
        idempotencyKey: "r2",
      }),
    );
    expect(refused.code).toBe(ErrorCodes.ProjectUntrusted);
    expect(refused.message).toContain("Trust the project");
    expect(h.store.list({ projectId: h.projectId }).items[0]?.revisionCount).toBe(1);
  });

  it("makes an agent an agent and a client a person, so only a person approves", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    ok(
      await h.call("project/work/review", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        action: "request_review",
        idempotencyKey: "rv1",
      }),
    );
    const covers = [
      {
        entityId: spec.entity.entityId,
        kind: "spec" as const,
        key: spec.entity.key,
        revisionId: spec.revision.revisionId,
        digest: spec.revision.digest,
      },
    ];
    // The worker bridge, acting for an agent: refused, whatever it claims.
    expect(() =>
      h.methods.handle(
        {
          method: "project/work/approve",
          params: {
            projectId: h.projectId,
            entityId: spec.entity.entityId,
            expectedRevisionId: spec.revision.revisionId,
            gate: "brief",
            decision: "approved",
            covers,
            idempotencyKey: "agent-approve",
            // A claim in the body cannot make an agent a person.
            origin: { actor: { kind: "person", label: "Definitely a person" } },
          },
        },
        { actor: { class: "local_app", id: "l1.app" }, source: "worker", agent: { label: "Builder", sessionId: "ses_1" } },
      ),
    ).toThrow(/Only a person approves/);
    // And the same request from a client connection is allowed.
    const approved = ok<{ entity: ProjectWorkEntity; approval: { origin: { actor: { kind: string } } } }>(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers,
        idempotencyKey: "person-approve",
      }),
    );
    expect(approved.entity.state).toBe("approved");
    expect(approved.approval.origin.actor.kind).toBe("person");
  });

  it("records an agent's revision as an agent's, with its session as provenance", async () => {
    h = projectWorkHarness();
    const written = h.methods.handle(
      {
        method: "project/work/create",
        params: { projectId: h.projectId, kind: "task", title: "From a tool", body: taskBody(), idempotencyKey: "w1" },
      },
      { actor: { class: "local_app", id: "l1.app" }, source: "worker", agent: { label: "Builder", sessionId: "ses_9" } },
    ) as ProjectWorkWriteResult;
    expect(written.revision.origin).toEqual({ actor: { kind: "agent", label: "Builder" }, sessionId: "ses_9" });
  });
});

describe("the audit", () => {
  it("records approve, delete and archive with the actor, the project and the exact revisions — and no body", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    ok(
      await h.call("project/work/review", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        action: "request_review",
        idempotencyKey: "rv1",
      }),
    );
    ok(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        gate: "brief",
        decision: "approved",
        covers: [
          {
            entityId: spec.entity.entityId,
            kind: "spec",
            key: spec.entity.key,
            revisionId: spec.revision.revisionId,
            digest: spec.revision.digest,
          },
        ],
        idempotencyKey: "ap1",
      }),
    );
    ok(
      await h.call("project/work/archive", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        archived: true,
        idempotencyKey: "ar1",
      }),
    );
    ok(
      await h.call("project/work/delete", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        confirm: true,
        idempotencyKey: "dl1",
      }),
    );

    expect(h.logs.map((row) => row.kind)).toEqual(["project_work_approved", "project_work_archived", "project_work_deleted"]);
    const approval = h.logs[0]!;
    expect(approval.section).toBe("host");
    const detail = approval.detail as Record<string, unknown>;
    expect(detail["projectId"]).toBe(h.projectId);
    expect(detail["actor"]).toEqual({ kind: "person", label: "You" });
    expect(detail["actorClass"]).toBe("local_app");
    expect(detail["key"]).toBe(spec.entity.key);
    expect(detail["covers"]).toEqual([`${spec.entity.key}@${spec.revision.revisionId}#${spec.revision.digest}`]);
    // The brief's own words are in the body, and never in the log.
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain("People cannot review");
    expect(serialized).not.toContain("Phone review");
  });

  it("writes no audit row for a comment or a revision: they are not the decisions the leap names", async () => {
    h = projectWorkHarness();
    const spec = await createSpec(h);
    ok(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        revisionId: spec.revision.revisionId,
        anchor,
        text: "A thought.",
        idempotencyKey: "cm1",
      }),
    );
    expect(h.logs).toHaveLength(0);
  });
});

describe("a host whose store could not be opened", () => {
  it("says so in a sentence rather than answering with an invented shape", async () => {
    h = projectWorkHarness({ unavailable: "the database file is owned by another user" });
    const refused = failed(await h.call("project/work/list", { projectId: h.projectId }));
    expect(refused.code).toBe(ErrorCodes.Unsupported);
    expect(refused.message).toContain("the database file is owned by another user");
    expect(refused.message).toContain("nothing you saved was lost");
    expect(h.workerAttempts()).toBe(0);
  });
});
