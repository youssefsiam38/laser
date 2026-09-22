/**
 * M21-T2: the store under a fixture bigger than any real project.
 *
 * Paging that always advances and never repeats, a megabyte-scale body read in
 * ranges rather than whole, an attention queue that stays bounded while its
 * count stays exact, and an event window that tells a client to start again
 * rather than handing it a partial history.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { person, specBody, taskBody } from "./fixtures.js";

let base: string;
let store: ProjectWorkStore;
let projectId: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "project-work-bounds-"));
  store = new ProjectWorkStore({ file: join(base, "project-work.db") });
  projectId = store.projectIdFor(join(base, "alpha"))!;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("many entities", () => {
  it("pages a 600-item backlog without repeating or losing one", () => {
    for (let i = 0; i < 600; i++) {
      store.create({
        projectId,
        kind: i % 2 === 0 ? "spec" : "task",
        title: `Item ${i}`,
        body: i % 2 === 0 ? specBody(`brief ${i}`) : taskBody(`outcome ${i}`),
        origin: person,
        idempotencyKey: `k-${i}`,
      });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = store.list({ projectId, limit: 50, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(50);
      for (const item of page.items) {
        expect(seen.has(item.key)).toBe(false);
        seen.add(item.key);
      }
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(20);
    } while (cursor);
    expect(seen.size).toBe(600);
    expect(store.list({ projectId }).counts).toMatchObject({ total: 600, byKind: { spec: 300, task: 300 } });
  });

  it("caps a search answer and still ranks the exact key first", () => {
    for (let i = 0; i < 300; i++) {
      store.create({ projectId, kind: "spec", title: `Phone review ${i}`, body: specBody(`phone ${i}`), origin: person, idempotencyKey: `s-${i}` });
    }
    const results = store.search({ projectId, query: "phone", limit: 20 });
    expect(results.results).toHaveLength(20);
    expect(results.truncated).toBe(true);
    const exact = store.search({ projectId, query: "SPEC-250", limit: 20 });
    expect(exact.results[0]?.key).toBe("SPEC-250");
    expect(exact.results[0]?.exactKey).toBe(true);
  });

  it("keeps the attention list bounded while its count stays exact", () => {
    for (let i = 0; i < 80; i++) {
      const created = store.create({ projectId, kind: "task", title: `Task ${i}`, body: taskBody(`outcome ${i}`), origin: person, idempotencyKey: `t-${i}` });
      store.taskAction({
        projectId,
        entityId: created.entity.entityId,
        expectedRevisionId: created.revision.revisionId,
        action: "block",
        origin: person,
        idempotencyKey: `b-${i}`,
      });
    }
    const attention = store.attention(projectId, 50);
    expect(attention.items).toHaveLength(50);
    expect(attention.needsYou).toBe(80);
    expect(attention.truncated).toBe(true);
  });
});

describe("large bodies", () => {
  it("reads a megabyte-scale body in ranges that reassemble exactly", () => {
    const body = specBody("A big document.");
    if (body.kind !== "spec") throw new Error("fixture");
    // Multi-byte characters on purpose: a page must never cut one in half.
    body.spec.document = "λ".repeat(199_000);
    body.spec.requirements = Array.from({ length: 200 }, (_, index) => ({
      id: `r${index}`,
      text: "λ".repeat(2000),
      level: "must" as const,
    }));
    const created = store.create({ projectId, kind: "spec", title: "Big", body, origin: person, idempotencyKey: "big" });
    const first = store.get({ projectId, entityId: created.entity.entityId, body: { mode: "range", offset: 0, limit: 64 * 1024 } });
    expect(first.body?.totalBytes).toBeGreaterThan(1_000_000);
    expect(first.body?.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(first.body?.body).toBeUndefined();

    let text = "";
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page: ReturnType<typeof store.get> = store.get({
        projectId,
        entityId: created.entity.entityId,
        body: { mode: "range", offset, limit: 256 * 1024 },
      });
      text += page.body?.text ?? "";
      offset = page.body?.nextOffset;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(20);
    }
    expect(text).toBe(store.canonicalBody(projectId, created.revision.revisionId));
    expect(JSON.parse(text)).toEqual(body);
    // Nothing is cut mid-character: every page is valid UTF-8 on its own.
    expect(text).not.toContain("\uFFFD");
  });

  it("answers with no body at all when the caller does not want one", () => {
    const created = store.create({ projectId, kind: "spec", title: "Big", body: specBody(), origin: person, idempotencyKey: "one" });
    const detail = store.get({ projectId, entityId: created.entity.entityId, body: { mode: "none" } });
    expect(detail.body).toBeUndefined();
    expect(detail.fence.revisionId).toBe(created.revision.revisionId);
  });
});

describe("the event window", () => {
  it("tells a client to start again when its sequence fell out of the window", () => {
    const small = new ProjectWorkStore({ file: join(base, "events.db"), eventsRetained: 10 });
    try {
      const id = small.projectIdFor(join(base, "beta"))!;
      for (let i = 0; i < 40; i++) {
        small.create({ projectId: id, kind: "spec", title: `Item ${i}`, body: specBody(`brief ${i}`), origin: person, idempotencyKey: `k-${i}` });
      }
      const recent = small.list({ projectId: id, sinceSeq: 38 });
      expect(recent.reset).toBeUndefined();
      expect(recent.items.map((item) => item.key)).toEqual(["SPEC-40", "SPEC-39"]);
      const ancient = small.list({ projectId: id, sinceSeq: 2, limit: 50 });
      expect(ancient.reset).toBe(true);
      // A reset page is the full current answer, not a diff.
      expect(ancient.items).toHaveLength(40);
    } finally {
      small.close();
    }
  });
});
