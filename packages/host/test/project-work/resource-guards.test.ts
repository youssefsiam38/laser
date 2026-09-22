/**
 * Every project-work read is bounded, and the ceilings are enforced where the
 * protocol says they are (M21-T22, threat model §7).
 *
 * Each cap here is written at its own call site in the store, which means a
 * read added without one would pass every other test in this package. This is
 * the set: ask each read for more than it may answer with, and prove the
 * answer is bounded, labelled where it was cut, and still advances.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_WORK_ATTENTION_ITEMS_MAX,
  PROJECT_WORK_BLOB_PAGE_MAX_BYTES,
  PROJECT_WORK_BODY_MAX_BYTES,
  PROJECT_WORK_BODY_PAGE_MAX_BYTES,
  PROJECT_WORK_LIST_LIMIT_MAX,
  PROJECT_WORK_RELATED_MAX,
  PROJECT_WORK_SEARCH_LIMIT_MAX,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkListResult,
  type ProjectWorkSearchResults,
  type ProjectWorkWriteResult,
} from "@lasercode/protocol";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { person, specBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

/**
 * A design body of roughly `bytes` bytes.
 *
 * Every text field in a body has its own small ceiling, so the only honest way
 * to make a big *body* is many fields — which is exactly the shape a real
 * design has, and the shape the per-item ceiling exists for.
 */
function longBody(bytes: number): ProjectWorkBody {
  const props: Record<string, { type: "text"; value: string }> = {};
  for (let i = 0; i < Math.max(1, Math.ceil(bytes / 4000)); i++) props[`p${String(i)}`] = { type: "text", value: "x".repeat(4000) };
  return {
    kind: "design",
    design: {
      brief: "A design with a great many properties.",
      screens: [
        {
          id: "s1",
          name: "Wide",
          content: { tree: { rootNodeId: "n1", nodes: [{ id: "n1", component: { primitive: "stack" }, fidelity: "mapped", props, children: [] }] } },
          states: [],
          fidelity: "mapped",
        },
      ],
      flows: [],
      sketches: [],
      fidelity: "mapped",
      fixtures: [],
    },
  };
}

describe("lists and searches", () => {
  it("pages a list rather than answering with everything, and refuses a page past the ceiling", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < 260; i++) {
      h.store.create({ projectId: h.projectId, kind: "spec", title: `Item ${String(i)}`, body: specBody(`brief ${String(i)}`), origin: person, idempotencyKey: `k${String(i)}` });
    }
    const first = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId }));
    expect(first.items.length).toBeLessThanOrEqual(PROJECT_WORK_LIST_LIMIT_MAX);
    expect(first.nextCursor).toBeDefined();
    const biggest = ok<ProjectWorkListResult>(await h.call("project/work/list", { projectId: h.projectId, limit: PROJECT_WORK_LIST_LIMIT_MAX }));
    expect(biggest.items.length).toBe(PROJECT_WORK_LIST_LIMIT_MAX);
    expect(failed(await h.call("project/work/list", { projectId: h.projectId, limit: PROJECT_WORK_LIST_LIMIT_MAX + 1 })).code).toBeDefined();
  });

  it("bounds a search that matches everything", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < 160; i++) {
      h.store.create({ projectId: h.projectId, kind: "spec", title: `Reviewable ${String(i)}`, body: specBody("reviewable brief"), origin: person, idempotencyKey: `s${String(i)}` });
    }
    const results = ok<ProjectWorkSearchResults>(
      await h.call("project/work/search", { projectId: h.projectId, query: "reviewable", limit: PROJECT_WORK_SEARCH_LIMIT_MAX }),
    );
    expect(results.results.length).toBeLessThanOrEqual(PROJECT_WORK_SEARCH_LIMIT_MAX);
    expect(results.truncated).toBe(true);
    expect(failed(await h.call("project/work/search", { projectId: h.projectId, query: "reviewable", limit: PROJECT_WORK_SEARCH_LIMIT_MAX + 1 })).code).toBeDefined();
    const unasked = ok<ProjectWorkSearchResults>(await h.call("project/work/search", { projectId: h.projectId, query: "reviewable" }));
    expect(unasked.results.length).toBeLessThanOrEqual(PROJECT_WORK_SEARCH_LIMIT_MAX);
  });

  it("bounds the queue of what needs a person, and says it was cut", async () => {
    h = projectWorkHarness();
    for (let i = 0; i < PROJECT_WORK_ATTENTION_ITEMS_MAX + 20; i++) {
      const created = h.store.create({
        projectId: h.projectId,
        kind: "spec",
        title: `Needs you ${String(i)}`,
        body: specBody(`brief ${String(i)}`),
        origin: person,
        idempotencyKey: `n${String(i)}`,
      });
      h.store.comment({
        projectId: h.projectId,
        entityId: created.entity.entityId,
        expectedRevisionId: created.entity.currentRevisionId,
        revisionId: created.entity.currentRevisionId,
        anchor: { target: "entity" },
        text: "This blocks.",
        blocking: true,
        origin: { actor: { kind: "agent", label: "Builder" } },
        idempotencyKey: `nc${String(i)}`,
      });
    }
    const attention = h.methods.attention(h.projectId);
    expect(attention.items.length).toBeLessThanOrEqual(PROJECT_WORK_ATTENTION_ITEMS_MAX);
    expect(attention.truncated).toBe(true);
    expect(attention.needsYou).toBeGreaterThan(attention.items.length);
  });
});

describe("one item's own lists", () => {
  it("cuts related rows at the documented maximum and names what was cut", async () => {
    h = projectWorkHarness();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Busy", body: specBody(), idempotencyKey: "b1" }),
    );
    for (let i = 0; i < PROJECT_WORK_RELATED_MAX + 5; i++) {
      h.store.comment({
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.entity.currentRevisionId,
        revisionId: spec.entity.currentRevisionId,
        anchor: { target: "entity" },
        text: `comment ${String(i)}`,
        origin: person,
        idempotencyKey: `bc${String(i)}`,
      });
    }
    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId }));
    expect(detail.comments?.length ?? 0).toBeLessThanOrEqual(PROJECT_WORK_RELATED_MAX);
    expect(detail.truncated ?? []).toContain("comments");
  });

  it("reads a long body in ranges, never whole, and refuses a page past the ceiling", async () => {
    h = projectWorkHarness();
    const written = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "design",
        title: "Long",
        // Well past one page, comfortably under the item ceiling.
        body: longBody(PROJECT_WORK_BODY_PAGE_MAX_BYTES * 2),
        idempotencyKey: "l1",
      }),
    );
    const page = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", {
        projectId: h.projectId,
        entityId: written.entity.entityId,
        body: { mode: "range", offset: 0, limit: PROJECT_WORK_BODY_PAGE_MAX_BYTES },
      }),
    );
    expect(page.body?.totalBytes ?? 0).toBeGreaterThan(PROJECT_WORK_BODY_PAGE_MAX_BYTES);
    expect(Buffer.byteLength(page.body?.text ?? "", "utf8")).toBeLessThanOrEqual(PROJECT_WORK_BODY_PAGE_MAX_BYTES);
    expect(page.body?.nextOffset).toBeDefined();
    expect(
      failed(
        await h.call("project/work/get", {
          projectId: h.projectId,
          entityId: written.entity.entityId,
          body: { mode: "range", offset: 0, limit: PROJECT_WORK_BODY_PAGE_MAX_BYTES + 1 },
        }),
      ).code,
    ).toBeDefined();
  });

  it("refuses a blob page past the ceiling", async () => {
    h = projectWorkHarness();
    expect(
      failed(
        await h.call("project/work/blob/read", { projectId: h.projectId, blobId: "blb_missing", limit: PROJECT_WORK_BLOB_PAGE_MAX_BYTES + 1 }),
      ).code,
    ).toBeDefined();
  });
});

describe("what a write may weigh", () => {
  it("refuses an over-ceiling body before a byte is charged to the project", async () => {
    h = projectWorkHarness();
    const before = h.store.usage(h.projectId);
    const error = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "design",
        title: "Too big",
        body: longBody(PROJECT_WORK_BODY_MAX_BYTES + 512 * 1024),
        idempotencyKey: "huge-1",
      }),
    );
    expect(error.message).toMatch(/larger than/i);
    const after = h.store.usage(h.projectId);
    expect(after.projectBytes).toBe(before.projectBytes);
    expect(after.records).toBe(before.records);
  });
});
