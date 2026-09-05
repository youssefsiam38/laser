import { describe, expect, it } from "vitest";
import {
  attentionOf,
  findPresentationKey,
  highestAttention,
  panelSchema,
  refsOf,
  validatePanelEvent,
  type Panel,
  type RunPanel,
} from "../src/index.js";

const run = (over: Partial<RunPanel> = {}): RunPanel => ({
  kind: "run",
  id: "r1",
  source: "pi-subagents",
  title: "worker#2",
  intent: "follow",
  lifecycle: "running",
  ...over,
});

describe("validatePanelEvent", () => {
  it("flattens a declared event into a panel with defaults", () => {
    const result = validatePanelEvent({
      v: 1,
      id: "web-access:search:42",
      kind: "collection",
      title: '8 results for "noise protocol"',
      data: { items: [{ id: "1", primary: "Noise Protocol Framework", secondary: "noiseprotocol.org" }] },
      actions: [{ id: "open", label: "Open" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.kind).toBe("collection");
    expect(result.panel.intent).toBe("inline");
    expect(result.panel.source).toBe("extension");
    expect(result.panel.actions).toEqual([{ id: "open", label: "Open" }]);
  });

  it("refuses presentation, naming the field", () => {
    const result = validatePanelEvent({
      v: 1,
      id: "x",
      kind: "stream",
      title: "log",
      data: { encoding: "text", ref: "file:/tmp/x", style: { color: "red" } },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("data.style") });
    expect(findPresentationKey({ a: [{ b: { className: "x" } }] })).toBe("a[0].b.className");
  });

  it("refuses unknown keys and missing required fields at the kind layer", () => {
    expect(validatePanelEvent({ v: 1, id: "x", kind: "run", title: "t", data: { lifecycle: "flying" } }).ok).toBe(false);
    expect(validatePanelEvent({ v: 1, id: "x", kind: "run", title: "t", data: { lifecycle: "running", extra: 1 } }).ok).toBe(false);
    expect(validatePanelEvent({ v: 2, id: "x", kind: "run", title: "t", data: {} }).ok).toBe(false);
  });

  it("keeps null usage distinct from absent usage", () => {
    const parsed = panelSchema.parse(run({ usage: null }));
    expect(parsed.kind === "run" && parsed.usage).toBeNull();
  });
});

describe("attentionOf", () => {
  it("derives the dot from lifecycle, and honours an adapter override", () => {
    expect(attentionOf(run())).toBe("working");
    expect(attentionOf(run({ lifecycle: "queued" }))).toBe("working");
    expect(attentionOf(run({ lifecycle: "failed" }))).toBe("error");
    expect(attentionOf(run({ lifecycle: "failed" }), { seen: true })).toBe("idle");
    expect(attentionOf(run({ lifecycle: "done" }))).toBe("finished_unread");
    expect(attentionOf(run({ lifecycle: "cancelled" }))).toBe("finished_unread");
    expect(attentionOf(run({ lifecycle: "paused" }))).toBe("idle");
    expect(attentionOf(run({ lifecycle: "done", attention: "error" }))).toBe("error");
  });

  it("a decision always waits for you; a plan lights up through its approval", () => {
    const decision: Panel = {
      kind: "decision",
      id: "d1",
      source: "x",
      title: "Approve the plan?",
      intent: "inspect",
      blocking: "turn",
      fields: [{ id: "ok", label: "Approve", type: "confirm" }],
    };
    expect(attentionOf(decision)).toBe("waiting_for_input");
    const plan: Panel = {
      kind: "plan",
      id: "p1",
      source: "x",
      title: "Release",
      intent: "follow",
      steps: [{ id: "s1", label: "build", state: "pending" }],
      approval: { decisionId: "d1" },
    };
    expect(attentionOf(plan)).toBe("idle");
    expect(attentionOf(plan, { openDecisionIds: new Set(["d1"]) })).toBe("waiting_for_input");
    expect(attentionOf({ ...plan, steps: [{ id: "s1", label: "build", state: "running" }] })).toBe("working");
    expect(attentionOf({ ...plan, steps: [{ id: "s1", label: "build", state: "done" }] })).toBe("finished_unread");
    expect(attentionOf({ ...plan, steps: [{ id: "s1", label: "build", state: "failed" }] })).toBe("error");
  });

  it("aggregates to the most urgent", () => {
    expect(highestAttention([])).toBe("idle");
    expect(highestAttention(["working", "finished_unread"])).toBe("finished_unread");
    expect(highestAttention(["working", "waiting_for_input", "error"])).toBe("waiting_for_input");
  });
});

describe("refsOf", () => {
  it("lists every ref a panel carries", () => {
    expect(refsOf(run({ output: { ref: "file:/o" }, artifacts: [{ label: "report", ref: "file:/r" }] }))).toEqual([
      "file:/o",
      "file:/r",
    ]);
    expect(
      refsOf({
        kind: "document",
        id: "d",
        source: "x",
        title: "t",
        intent: "inline",
        mediaType: "text/markdown",
        renderable: true,
        content: { ref: "file:/doc.md" },
        version: { label: "v2", previousRef: "file:/doc.v1.md" },
      }),
    ).toEqual(["file:/doc.md", "file:/doc.v1.md"]);
  });
});

describe("decision rejection", () => {
  it("must point at a field that exists", () => {
    const base = { v: 1, id: "d", kind: "decision", title: "Approve?", data: { blocking: "turn", fields: [{ id: "ok", label: "Approve", type: "confirm" }] } };
    expect(validatePanelEvent({ ...base, data: { ...base.data, rejection: { label: "No", field: "why" } } })).toEqual({
      ok: false,
      error: expect.stringContaining("rejection.field"),
    });
    expect(
      validatePanelEvent({
        ...base,
        data: { ...base.data, fields: [...base.data.fields, { id: "why", label: "Why not?", type: "longtext" }], rejection: { label: "No", field: "why" } },
      }).ok,
    ).toBe(true);
  });
});
