/**
 * Pins and before/after, as pure models (M21-T13).
 *
 * The rules under test are the leap's own: a comment anchors to a node id and
 * a coordinate only positions a pin; an anchor the revision no longer has is
 * *orphaned*, kept and labelled, never re-pinned somewhere plausible; and a
 * revision comparison is by stable node id, so a node that moved among its
 * siblings is not "changed" and a node replaced under one id is.
 */
import { describe, expect, it } from "vitest";
import { DESIGN_KIT_PRIMITIVES, type DesignBody, type ProjectWorkComment } from "@lasercode/protocol";

import { designDiff, designPins, diffSummary, orphanedPins, pinsForScreen } from "../../src/design/review.js";
import { KIT_NAMES } from "../../src/design/kit.js";
import { routeFromBrief, implementCommandFor } from "../../src/design/host-context.js";

import { designFixture } from "./fixture.js";

function comment(over: Partial<ProjectWorkComment> & Pick<ProjectWorkComment, "commentId" | "anchor">): ProjectWorkComment {
  return {
    projectId: "p1",
    entityId: "e1",
    revisionId: "r1",
    text: "Make this quieter.",
    state: "open",
    blocking: false,
    createdAt: "2026-02-03T10:00:00.000Z",
    origin: { actor: { kind: "person", label: "Rae" } },
    ...over,
  } as ProjectWorkComment;
}

describe("pins", () => {
  it("numbers a node pin, puts it on the screen that has the node, and keeps the words", () => {
    const body = designFixture();
    const pins = designPins(body, [comment({ commentId: "c1", anchor: { target: "node", nodeId: "n_pay" } })]);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ number: 1, nodeId: "n_pay", screenId: "scr_list", orphaned: false, author: "Rae" });
    expect(pinsForScreen(pins, "scr_list")).toHaveLength(1);
    expect(pinsForScreen(pins, "scr_pay")).toHaveLength(0);
  });

  it("pins a screen comment to its screen", () => {
    const body = designFixture();
    const pins = designPins(body, [comment({ commentId: "c1", anchor: { target: "region", regionId: "scr_pay" } })]);
    expect(pins[0]).toMatchObject({ screenId: "scr_pay", orphaned: false });
    expect(pins[0]?.nodeId).toBeUndefined();
  });

  it("orphans a pin whose node this revision does not have, and never moves it", () => {
    const body = designFixture();
    const pins = designPins(body, [
      comment({ commentId: "c1", anchor: { target: "node", nodeId: "n_gone" } }),
      comment({ commentId: "c2", anchor: { target: "node", nodeId: "n_pay" } }),
    ]);
    expect(pins[0]).toMatchObject({ number: 1, orphaned: true, nodeId: "n_gone" });
    expect(pins[0]?.screenId).toBeUndefined();
    expect(orphanedPins(pins)).toHaveLength(1);
    // The numbering is the order the comments were written; an orphan keeps
    // its number rather than being renumbered away.
    expect(pins[1]).toMatchObject({ number: 2, orphaned: false });
  });

  it("keeps the host's own orphaned verdict even when the node is there", () => {
    const body = designFixture();
    const pins = designPins(body, [comment({ commentId: "c1", orphaned: true, anchor: { target: "node", nodeId: "n_pay" } })]);
    expect(pins[0]?.orphaned).toBe(true);
  });

  it("ignores anchors that are not a design's: a text range is not a pin", () => {
    const body = designFixture();
    const pins = designPins(body, [comment({ commentId: "c1", anchor: { target: "entity" } })]);
    expect(pins).toEqual([]);
  });
});

describe("before and after", () => {
  it("sees nothing when nothing changed", () => {
    const body = designFixture();
    const diff = designDiff(body, designFixture());
    expect(diff.identical).toBe(true);
    expect(diffSummary(diff)).toBe("Nothing changed between these two revisions.");
  });

  it("names the node that changed, the fields, and what it was", () => {
    const before = designFixture();
    const after: DesignBody = {
      ...before,
      screens: before.screens.map((screen) =>
        screen.id !== "scr_list" || !("tree" in screen.content)
          ? screen
          : {
              ...screen,
              content: {
                tree: {
                  ...screen.content.tree,
                  nodes: screen.content.tree.nodes.map((node) => (node.id === "n_pay" ? { ...node, text: "Pay this invoice", fidelity: "proposed" as const } : node)),
                },
              },
            },
      ),
    };
    const diff = designDiff(before, after);
    expect(diff.identical).toBe(false);
    const change = diff.nodes.find((candidate) => candidate.nodeId === "n_pay");
    expect(change?.kind).toBe("changed");
    expect(change?.fields).toEqual(["fidelity", "text"]);
    expect(change?.before).toContain("Pay now");
    expect(change?.after).toContain("Pay this invoice");
    expect(diffSummary(diff)).toBe("1 node changed");
  });

  it("counts a screen added and its nodes as added, not as changed", () => {
    const before = designFixture();
    const after: DesignBody = {
      ...before,
      screens: [
        ...before.screens,
        {
          id: "scr_new",
          name: "Grounded sketch",
          content: { tree: { rootNodeId: "g_root", nodes: [{ id: "g_root", component: { primitive: "stack" }, fidelity: "proposed", props: {}, children: [] }] } },
          states: [],
          fidelity: "proposed",
        },
      ],
    };
    const diff = designDiff(before, after);
    expect(diff.screens).toEqual([{ kind: "added", screenId: "scr_new", screenName: "Grounded sketch" }]);
    // A screen that is new in this revision does not report every node of it
    // twice: the screen row says it, and the node rows stay for real edits.
    expect(diff.nodes).toEqual([]);
    expect(diffSummary(diff)).toBe("1 screen added");
  });

  it("reports a removed node against the screen it was in", () => {
    const before = designFixture();
    const after: DesignBody = {
      ...before,
      screens: before.screens.map((screen) =>
        screen.id !== "scr_pay" || !("tree" in screen.content)
          ? screen
          : {
              ...screen,
              content: {
                tree: {
                  rootNodeId: "p_root",
                  nodes: screen.content.tree.nodes
                    .filter((node) => node.id !== "p_confirm")
                    .map((node) => (node.id === "p_root" ? { ...node, children: node.children.filter((child) => child !== "p_confirm") } : node)),
                },
              },
            },
      ),
    };
    const diff = designDiff(before, after);
    expect(diff.nodes.filter((change) => change.kind === "removed").map((change) => change.nodeId)).toEqual(["p_confirm"]);
    expect(diff.nodes.find((change) => change.nodeId === "p_root")?.fields).toEqual(["children"]);
  });
});

describe("the vocabulary two processes share", () => {
  it("pins this window's kit to the names anything composing a tree must use", () => {
    expect([...KIT_NAMES].sort()).toEqual([...DESIGN_KIT_PRIMITIVES].sort());
  });
});

describe("/design from <route>", () => {
  it("reads the route the command named back out of the brief", () => {
    expect(routeFromBrief("from /orders")).toBe("/orders");
    expect(routeFromBrief("/design from app/views/orders/index.html.erb")).toBe("app/views/orders/index.html.erb");
    expect(routeFromBrief("From /orders please")).toBe("/orders");
  });

  it("reads nothing out of an ordinary brief, and refuses a URL or a parent step", () => {
    expect(routeFromBrief("A billing screen where a person can pay an invoice.")).toBeUndefined();
    expect(routeFromBrief("from https://example.test/orders")).toBeUndefined();
    expect(routeFromBrief("from ../../etc/passwd")).toBeUndefined();
  });

  it("writes the hand-off in the form the session recognises", () => {
    expect(implementCommandFor("DES-4")).toBe("/design implement @DES-4");
  });
});
