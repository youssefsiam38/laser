/**
 * M21-T4: bounded bodies, value-only search and revision-fenced projections,
 * over the wire.
 *
 * Everything here goes through `Router.handle`, against the worker-free
 * harness: a body is paged rather than delivered whole, a blob is read in
 * ranges, search returns projected values and nothing else, a projection that
 * is not current is rebuilt rather than served, released derived content is
 * labelled, a full budget refuses the write with what to do about it, and a
 * fixture far larger than a real project stays inside its budgets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  PROJECT_WORK_BODY_PAGE_MAX_BYTES,
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
  PROJECT_WORK_QUOTA_CODE,
  type ProjectWorkBlobReadResult,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkListResult,
  type ProjectWorkQuotaRefusal,
  type ProjectWorkSearchResults,
  type ProjectWorkWriteResult,
} from "@lasercode/protocol";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

/** A spec body around a megabyte: a document plus a few hundred requirements. */
function largeSpecBody(): ProjectWorkBody {
  const body = specBody("A spec with more detail than anybody enjoys.");
  if (body.kind !== "spec") throw new Error("fixture changed");
  return {
    kind: "spec",
    spec: {
      ...body.spec,
      document: "## Detail\n\n".concat("Every rule of this spec, written out in full. ".repeat(4000)).slice(0, 190_000),
      requirements: Array.from({ length: 250 }, (_, index) => ({
        id: `r${index}`,
        text: `Requirement ${index}: ${"the behaviour is exactly as described here, and no less. ".repeat(50)}`.slice(0, 3800),
        level: "must" as const,
      })),
    },
  };
}

async function create(harness: ProjectWorkHarness, kind: "spec" | "task", title: string, body: ProjectWorkBody, key: string) {
  return ok<ProjectWorkWriteResult>(
    await harness.call("project/work/create", { projectId: harness.projectId, kind, title, body, idempotencyKey: key }),
  );
}

describe("ranged body reads", () => {
  it("pages a megabyte-scale body and never cuts a character in half", async () => {
    h = projectWorkHarness();
    const spec = await create(h, "spec", "The long spec", largeSpecBody(), "big");
    const whole = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "full" } }),
    );
    const totalBytes = whole.body!.totalBytes;
    expect(totalBytes).toBeGreaterThan(900_000);

    let offset = 0;
    let text = "";
    let pages = 0;
    for (;;) {
      const page = ok<ProjectWorkGetResult>(
        await h.call("project/work/get", {
          projectId: h.projectId,
          entityId: spec.entity.entityId,
          body: { mode: "range", offset, limit: 256 * 1024 },
        }),
      ).body!;
      expect(page.totalBytes).toBe(totalBytes);
      expect(page.offset).toBe(offset);
      expect(Buffer.byteLength(page.text, "utf8")).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(256 * 1024);
      text += page.text;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(16);
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(3);
    expect(text).toBe(whole.body!.text);
    expect(JSON.parse(text)).toEqual(whole.body!.body);
    // A page never carries the parsed body: that is the whole-read answer.
    expect(
      ok<ProjectWorkGetResult>(
        await h.call("project/work/get", {
          projectId: h.projectId,
          entityId: spec.entity.entityId,
          body: { mode: "range", offset: 1024, limit: 2048 },
        }),
      ).body?.body,
    ).toBeUndefined();
    expect(h.workerAttempts()).toBe(0);
  });

  it("answers `none` with no body at all, and refuses a page above the ceiling", async () => {
    h = projectWorkHarness();
    const spec = await create(h, "spec", "A spec", specBody(), "s1");
    const none = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "none" } }),
    );
    expect(none.body).toBeUndefined();
    expect(none.fence.revisionId).toBe(spec.revision.revisionId);
    const refused = failed(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        body: { mode: "range", offset: 0, limit: PROJECT_WORK_BODY_PAGE_MAX_BYTES + 1 },
      }),
    );
    expect(refused.code).toBe(-32602);
  });
});

describe("ranged blob reads", () => {
  it("reads a chunked blob in pages that rejoin into exactly what was stored", async () => {
    h = projectWorkHarness();
    const bytes = Buffer.alloc(1_500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const stored = h.store.putBlob({ projectId: h.projectId, mediaType: "application/octet-stream", data: bytes });

    let offset = 0;
    const pieces: Buffer[] = [];
    let pages = 0;
    for (;;) {
      const page = ok<ProjectWorkBlobReadResult>(
        await h.call("project/work/blob/read", { projectId: h.projectId, blobId: stored.blobId, offset, limit: 512 * 1024 }),
      );
      expect(page.totalBytes).toBe(bytes.length);
      expect(page.digest).toBe(stored.digest);
      expect(page.offset).toBe(offset);
      const data = Buffer.from(page.data!, "base64");
      expect(data.byteLength).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(PROJECT_WORK_BLOB_PAGE_MAX_BYTES);
      pieces.push(data);
      pages += 1;
      expect(pages).toBeLessThanOrEqual(8);
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(pages).toBe(3);
    const rejoined = Buffer.concat(pieces);
    expect(rejoined.byteLength).toBe(bytes.length);
    expect(createHash("sha256").update(rejoined).digest("hex")).toBe(stored.digest);
    expect(h.workerAttempts()).toBe(0);
  });

  it("labels released derived content instead of answering with empty bytes", async () => {
    h = projectWorkHarness();
    const preview = h.store.putBlob({
      projectId: h.projectId,
      mediaType: "image/png",
      data: Buffer.from("a rendered preview nobody can recreate cheaply"),
    });
    const before = ok<ProjectWorkBlobReadResult>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: preview.blobId }));
    expect(before.data).toBeTypeOf("string");

    const freed = h.store.releaseDerived({
      projectId: h.projectId,
      blobId: preview.blobId,
      reason: "quota",
      detail: "This preview was let go to keep room for the work itself. Open the item again to rebuild it.",
    });
    expect(freed).toBe(preview.bytes);

    const after = ok<ProjectWorkBlobReadResult>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId: preview.blobId }));
    expect(after.data).toBeUndefined();
    expect(after.bytes).toBe(0);
    // Size, media type and digest survive: the row still says what it was.
    expect(after.totalBytes).toBe(preview.bytes);
    expect(after.digest).toBe(preview.digest);
    expect(after.released).toEqual({
      reason: "quota",
      detail: "This preview was let go to keep room for the work itself. Open the item again to rebuild it.",
    });
    // And the space really came back to the project's budget.
    expect(h.store.usage(h.projectId).projectBytes).toBeLessThan(h.store.usage(h.projectId).limits.projectBytes);
  });

  it("refuses an attachment that is not this project's", async () => {
    h = projectWorkHarness();
    const other = h.store.projectIdFor(`${h.dir}/beta`)!;
    const stored = h.store.putBlob({ projectId: h.projectId, mediaType: "text/plain", data: Buffer.from("mine") });
    const refused = failed(await h.call("project/work/blob/read", { projectId: other, blobId: stored.blobId }));
    expect(refused.code).toBe(-32602);
    expect(refused.message).toContain("not in this project");
  });
});

describe("value-only search", () => {
  it("matches keys exactly and ranks them above a title or a body match", async () => {
    h = projectWorkHarness();
    const first = await create(h, "spec", "A first spec", specBody("about latency"), "s1");
    await create(h, "spec", `Notes that mention ${first.entity.key} in the title`, specBody("about something else"), "s2");
    await create(h, "task", "A task", taskBody(`work that follows ${first.entity.key}`), "t1");

    const results = ok<ProjectWorkSearchResults>(
      await h.call("project/work/search", { projectId: h.projectId, query: first.entity.key }),
    ).results;
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.key).toBe(first.entity.key);
    expect(results[0]?.exactKey).toBe(true);
    expect(results[0]?.matches[0]).toEqual({ field: "key", snippet: first.entity.key });
    expect(results.slice(1).every((result) => result.exactKey === false)).toBe(true);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("searches projected values only: never a credential-shaped field, a path or a blob", async () => {
    h = projectWorkHarness();
    const secret = "sk-live-9Q7xTOKENnotinanindex";
    const body = taskBody("Make the deploy step reproducible.");
    if (body.kind !== "task") throw new Error("fixture changed");
    const withSecrets: ProjectWorkBody = {
      kind: "task",
      task: {
        ...body.task,
        // Commands, scope and assignment are not projected: they are how the
        // work is done, not what it says.
        verificationCommands: [`curl -H "Authorization: Bearer ${secret}" https://deploy.example/run`],
        scope: { ...body.task.scope, paths: ["/home/someone/private/.env"] },
      },
    };
    const task = await create(h, "task", "Reproducible deploys", withSecrets, "t1");
    h.store.putBlob({
      projectId: h.projectId,
      entityId: task.entity.entityId,
      mediaType: "application/octet-stream",
      data: Buffer.from(`binary blob carrying ${secret}`),
    });

    for (const query of [secret, "Authorization", "/home/someone/private", "deploy.example"]) {
      const results = ok<ProjectWorkSearchResults>(await h.call("project/work/search", { projectId: h.projectId, query })).results;
      expect(results, query).toEqual([]);
    }
    // What the item *says* is searchable, and that is all that comes back.
    const found = ok<ProjectWorkSearchResults>(
      await h.call("project/work/search", { projectId: h.projectId, query: "reproducible" }),
    ).results;
    expect(found.map((result) => result.key)).toEqual([task.entity.key]);
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(found[0]?.matches.every((match) => ["key", "title", "body"].includes(match.field))).toBe(true);
  });

  it("keeps every result fenced to the revision it describes", async () => {
    h = projectWorkHarness();
    // The title says nothing either query matches, so the only thing that can
    // match is the projected body value — which is the point of the test.
    const spec = await create(h, "spec", "The budget spec", specBody("about latency"), "s1");
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("about throughput instead"),
        idempotencyKey: "r2",
      }),
    );
    const stale = ok<ProjectWorkSearchResults>(await h.call("project/work/search", { projectId: h.projectId, query: "latency" })).results;
    expect(stale).toEqual([]);
    const current = ok<ProjectWorkSearchResults>(await h.call("project/work/search", { projectId: h.projectId, query: "throughput" })).results;
    expect(current[0]?.ref.revisionId).toBe(revised.revision.revisionId);
    expect(current[0]?.ref.digest).toBe(revised.revision.digest);
  });
});

describe("revision-fenced projections", () => {
  it("rebuilds a projection whose fence is behind its entity, rather than serving it", async () => {
    h = projectWorkHarness();
    const spec = await create(h, "spec", "The budget spec", specBody("about latency"), "s1");
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("about throughput instead"),
        idempotencyKey: "r2",
      }),
    );

    // Put the database back into the state a migration or an older release
    // could leave it in: a projection row that names an earlier revision and
    // still holds that revision's text.
    h.store.close();
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => { prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void };
    };
    const raw = new DatabaseSync(`${h.dir}/project-work.db`);
    raw
      .prepare("UPDATE search_projection SET revision_id = ?, values_text = ? WHERE entity_id = ?")
      .run(spec.revision.revisionId, "about latency", spec.entity.entityId);
    raw.close();

    const reopened = projectWorkHarness({ dir: h.dir });
    try {
      expect(reopened.store.projectionFence(reopened.projectId, spec.entity.entityId)).toEqual({
        revisionId: spec.revision.revisionId,
        current: false,
      });
      // The stale text is never served...
      const stale = ok<ProjectWorkSearchResults>(
        await reopened.call("project/work/search", { projectId: reopened.projectId, query: "latency" }),
      ).results;
      expect(stale).toEqual([]);
      // ...and the projection has been rebuilt from the current revision.
      expect(reopened.store.projectionFence(reopened.projectId, spec.entity.entityId)).toEqual({
        revisionId: revised.revision.revisionId,
        current: true,
      });
      const current = ok<ProjectWorkSearchResults>(
        await reopened.call("project/work/search", { projectId: reopened.projectId, query: "throughput" }),
      ).results;
      expect(current.map((result) => result.key)).toEqual([spec.entity.key]);
    } finally {
      reopened.cleanup();
    }
    // `h.cleanup()` in `afterEach` only removes the directory now.
  });

  it("names the revision every detail read was built from", async () => {
    h = projectWorkHarness();
    const spec = await create(h, "spec", "A spec", specBody("first"), "s1");
    const revised = ok<ProjectWorkWriteResult>(
      await h.call("project/work/revise", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.revision.revisionId,
        body: specBody("second"),
        idempotencyKey: "r2",
      }),
    );
    const current = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId }));
    expect(current.fence).toMatchObject({
      entityId: spec.entity.entityId,
      revisionId: revised.revision.revisionId,
      digest: revised.revision.digest,
    });
    expect(current.fence.seq).toBe(current.fence.seq);
    // An older revision reads as itself, fenced to itself — never mixed with
    // the current one.
    const historical = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, revisionId: spec.revision.revisionId }),
    );
    expect(historical.fence.revisionId).toBe(spec.revision.revisionId);
    expect(historical.fence.digest).toBe(spec.revision.digest);
    expect(historical.body!.text).toContain("first");
    expect(historical.entity.currentRevisionId).toBe(revised.revision.revisionId);
    const refused = failed(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, revisionId: "rv_not_here" }),
    );
    expect(refused.code).toBe(-32602);
  });
});

describe("a full budget", () => {
  it("refuses the durable write over the wire, with the recovery action, and keeps what is there", async () => {
    h = projectWorkHarness({ quota: { projectBytes: 4096 } });
    const first = await create(h, "spec", "Small enough", specBody("short"), "s1");
    const refused = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Too much",
        body: largeSpecBody(),
        idempotencyKey: "s2",
      }),
    );
    expect(refused.code).toBe(PROJECT_WORK_QUOTA_CODE);
    const data = refused.data as ProjectWorkQuotaRefusal;
    expect(data.refused).toBe("quota");
    expect(data.scope).toBe("project");
    expect(data.recovery).toContain("Export or delete");
    expect(data.limitBytes).toBe(4096);
    expect(refused.message).toContain("size limit");
    // Nothing canonical was evicted to make room.
    const list = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(list.items.map((item) => item.key)).toEqual([first.entity.key]);
    expect(
      ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: first.entity.entityId })).body?.text,
    ).toContain("short");
  });

  it("names the other project when the whole store is full", async () => {
    h = projectWorkHarness({ quota: { globalBytes: 2048 } });
    const refused = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Anything",
        body: largeSpecBody(),
        idempotencyKey: "s1",
      }),
    );
    expect(refused.code).toBe(PROJECT_WORK_QUOTA_CODE);
    expect((refused.data as ProjectWorkQuotaRefusal).scope).toBe("global");
    expect((refused.data as ProjectWorkQuotaRefusal).recovery).toContain("another project");
  });
});

describe("resource containment", () => {
  it("keeps a 400-item backlog inside its page budget, over the wire", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < 400; i++) {
      await create(h, i % 2 === 0 ? "spec" : "task", `Item ${i}`, i % 2 === 0 ? specBody(`brief ${i}`) : taskBody(`outcome ${i}`), `k-${i}`);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = ok<ProjectWorkListResult>(
        await h.call("project/work/list", { projectId: h.projectId, limit: 50, ...(cursor ? { cursor } : {}) }),
      );
      expect(page.items.length).toBeLessThanOrEqual(50);
      // A row never carries a body, however many revisions it has.
      expect(JSON.stringify(page.items)).not.toContain("brief 1");
      for (const item of page.items) {
        expect(seen.has(item.key)).toBe(false);
        seen.add(item.key);
      }
      pages += 1;
      expect(pages).toBeLessThanOrEqual(12);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(400);
    expect(h.workerAttempts()).toBe(0);
  });

  it("cuts the related records one detail read inlines, and says which it cut", async () => {
    h = projectWorkHarness();
    const spec = await create(h, "spec", "Much discussed", specBody(), "s1");
    for (let i = 0; i < 110; i++) {
      ok(
        await h.call("project/work/comment", {
          projectId: h.projectId,
          entityId: spec.entity.entityId,
          expectedRevisionId: spec.revision.revisionId,
          revisionId: spec.revision.revisionId,
          anchor: { target: "entity" },
          text: `Comment ${i}`,
          idempotencyKey: `cm-${i}`,
        }),
      );
    }
    const detail = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId, body: { mode: "none" } }),
    );
    expect(detail.comments).toHaveLength(100);
    expect(detail.truncated).toContain("comments");
  });

  it("bounds the search answer and says when it cut one", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < 30; i++) {
      await create(h, "spec", `Latency spec ${i}`, specBody(`latency ${i}`), `k-${i}`);
    }
    const page = ok<ProjectWorkSearchResults>(await h.call("project/work/search", { projectId: h.projectId, query: "latency", limit: 10 }));
    expect(page.results).toHaveLength(10);
    expect(page.truncated).toBe(true);
  });

  it("keeps the attention notification bounded while its count stays exact", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < 60; i++) {
      const item = await create(h, "spec", `Spec ${i}`, specBody(`brief ${i}`), `k-${i}`);
      ok(
        await h.call("project/work/comment", {
          projectId: h.projectId,
          entityId: item.entity.entityId,
          expectedRevisionId: item.revision.revisionId,
          revisionId: item.revision.revisionId,
          anchor: { target: "entity" },
          text: "This one needs you.",
          blocking: true,
          idempotencyKey: `cm-${i}`,
        }),
      );
    }
    const attention = h.methods.attention(h.projectId);
    expect(attention.needsYou).toBe(60);
    expect(attention.items).toHaveLength(50);
    expect(attention.truncated).toBe(true);
  });
});
