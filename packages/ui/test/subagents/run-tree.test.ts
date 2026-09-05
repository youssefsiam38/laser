/**
 * The run tree. Tested because it is the navigation model, not a view: one
 * level per strip, depth in the breadcrumb, attention rolling up, and focus
 * that survives a run being pruned underneath it.
 */
import type { Panel, RunPanel } from "@piorbit/protocol";
import { describe, expect, it } from "vitest";
import type { PanelEntry } from "../../src/panels/store.js";
import {
  MAX_TABS,
  buildRunTree,
  byAttention,
  flatten,
  overflowAttention,
  pathTo,
  reconcileFocus,
  tabsFor,
} from "../../src/components/subagents/run-tree.js";

const NOW = 1_000_000;

function entry(panel: Panel, extra: Partial<PanelEntry> = {}): PanelEntry {
  return {
    key: `/s/a.jsonl ${panel.id}`,
    path: "/s/a.jsonl",
    panel,
    firstSeenAt: NOW - 5_000,
    updatedAt: NOW,
    seen: false,
    ring: [],
    fallback: false,
    ...extra,
  };
}

function run(id: string, over: Partial<RunPanel> = {}): RunPanel {
  return {
    kind: "run",
    id,
    source: "pi-subagents",
    intent: "follow",
    title: id,
    lifecycle: "running",
    startedAt: new Date(NOW - 4_000).toISOString(),
    ...over,
  };
}

const child = (id: string, parent: string, over: Partial<RunPanel> = {}): RunPanel =>
  run(id, { parent: { id: parent, relation: "spawned-by" }, ...over });

describe("building the tree", () => {
  it("nests a child under the panel it names as its parent", () => {
    const tree = buildRunTree([entry(run("a")), entry(child("b", "a")), entry(child("c", "b"))], new Set(), NOW);
    expect(tree.roots.map((n) => n.id)).toEqual(["a"]);
    expect(tree.roots[0]?.children.map((n) => n.id)).toEqual(["b"]);
    expect(tree.roots[0]?.children[0]?.children.map((n) => n.id)).toEqual(["c"]);
    expect(tree.byId.get("c")?.depth).toBe(2);
  });

  it("keeps a child whose parent never arrived, rather than dropping it (R7)", () => {
    const tree = buildRunTree([entry(child("b", "missing-plan"))], new Set(), NOW);
    expect(tree.roots.map((n) => n.id)).toEqual(["b"]);
  });

  it("keeps creation order, so the strip never reshuffles under you", () => {
    const tree = buildRunTree(
      [entry(run("first", { lifecycle: "done" })), entry(run("second", { lifecycle: "failed" })), entry(run("third"))],
      new Set(),
      NOW,
    );
    expect(tree.roots.map((n) => n.id)).toEqual(["first", "second", "third"]);
  });

  it("leaves closed panels out of the tree", () => {
    const tree = buildRunTree([entry(run("a")), entry(run("b"), { closed: { at: NOW, reason: "gone" } })], new Set(), NOW);
    expect(tree.roots.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("attention flows up (R5)", () => {
  it("lights an ancestor from a failure three levels down", () => {
    const tree = buildRunTree(
      [entry(run("a")), entry(child("b", "a")), entry(child("c", "b", { lifecycle: "failed" }))],
      new Set(),
      NOW,
    );
    expect(tree.byId.get("c")?.own).toBe("error");
    expect(tree.byId.get("a")?.own).toBe("working");
    expect(tree.byId.get("a")?.attention).toBe("error");
    expect(tree.attention).toBe("error");
  });

  it("prefers what needs a person over what is merely broken", () => {
    const tree = buildRunTree(
      [
        entry(run("a")),
        entry(child("b", "a", { lifecycle: "failed" })),
        entry(child("c", "a", { lifecycle: "running", attention: "waiting_for_input" })),
      ],
      new Set(),
      NOW,
    );
    expect(tree.byId.get("a")?.attention).toBe("waiting_for_input");
  });

  it("counts what is still going, for the strip's summary", () => {
    const tree = buildRunTree(
      [entry(run("a")), entry(child("b", "a", { lifecycle: "queued" })), entry(child("c", "a", { lifecycle: "done" }))],
      new Set(),
      NOW,
    );
    expect(tree.running).toBe(2);
  });
});

describe("one level per strip", () => {
  const many = buildRunTree(
    [entry(run("root")), ...Array.from({ length: 7 }, (_, i) => entry(child(`k${i}`, "root", { lifecycle: i === 6 ? "failed" : "running" })))],
    new Set(),
    NOW,
  );

  it("shows the session's top-level runs when nothing is focused", () => {
    const row = tabsFor(buildRunTree([entry(run("a")), entry(child("b", "a"))], new Set(), NOW), undefined);
    expect(row.tabs.map((n) => n.id)).toEqual(["a"]);
    expect(row.focused).toBeUndefined();
    expect(row.trail).toEqual([]);
  });

  it("shows exactly the children of the focused run, never its siblings", () => {
    const row = tabsFor(many, "root");
    expect(row.tabs).toHaveLength(MAX_TABS);
    expect(row.tabs.map((n) => n.id)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(row.overflow.map((n) => n.id)).toEqual(["k5", "k6"]);
  });

  it("carries the loudest hidden state on the +N chip", () => {
    const row = tabsFor(many, "root");
    expect(overflowAttention(row.overflow)).toBe("error");
  });

  it("puts depth in the breadcrumb, not in the strip", () => {
    const deep = buildRunTree([entry(run("a")), entry(child("b", "a")), entry(child("c", "b"))], new Set(), NOW);
    const row = tabsFor(deep, "c");
    expect(row.trail.map((n) => n.id)).toEqual(["a", "b"]);
    expect(row.tabs).toEqual([]);
    expect(pathTo(deep, "c").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});

describe("focus survives the tree changing under it", () => {
  const tree = buildRunTree([entry(run("a")), entry(child("b", "a"))], new Set(), NOW);

  it("keeps a focus that still exists", () => {
    expect(reconcileFocus(tree, "b", ["a", "b"])).toBe("b");
  });

  it("falls back to the nearest surviving ancestor, never sideways", () => {
    expect(reconcileFocus(tree, "gone", ["a", "gone"])).toBe("a");
  });

  it("falls back to the session root when the whole branch is gone", () => {
    expect(reconcileFocus(tree, "gone", ["also-gone", "gone"])).toBeUndefined();
  });
});

describe("the fleet's flat view", () => {
  it("flattens depth-first, then sorts by what needs you first", () => {
    const tree = buildRunTree(
      [
        entry(run("a", { lifecycle: "done", startedAt: new Date(NOW - 9_000).toISOString() })),
        entry(child("b", "a", { lifecycle: "running" })),
        entry(run("c", { lifecycle: "running", attention: "waiting_for_input" })),
      ],
      new Set(),
      NOW,
    );
    expect(flatten(tree).map((n) => n.id)).toEqual(["a", "b", "c"]);
    // `a` inherits "waiting" from nothing, but `c` asks for a person, so it leads.
    expect(byAttention(flatten(tree))[0]?.id).toBe("c");
  });
});
