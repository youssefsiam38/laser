/**
 * M21-T8: comment anchors, threads and the gate vocabulary, as pure functions.
 *
 * These are the decisions that must be identical everywhere they are made —
 * the host orphans an anchor with them and refuses a decision with them, the
 * workspace draws pins and a gate card with them — so they live here and are
 * pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  GATE_OUTCOMES,
  commentResolutionAllowed,
  commentThreads,
  gateDecisionAllowed,
  gateOutcome,
  openBlockingComments,
  type ProjectWorkComment,
} from "../src/project-work.js";
import {
  anchorResolves,
  anchorTargets,
  describeAnchor,
  findAnchorTarget,
  projectWorkBodySchema,
  specBodySchema,
  type ProjectWorkBody,
} from "../src/project-work-bodies.js";

/** A hasher that is not sha256 and does not need to be: the rule is equality. */
const fakeHash = (value: string): string => `h:${value.length}:${value}`;

const spec: ProjectWorkBody = {
  kind: "spec",
  spec: {
    form: "brief",
    brief: "People cannot review a design from their phone.",
    outcomes: ["A person can approve a design on a phone."],
    nonGoals: [],
    requirements: [{ id: "r1", text: "The review footer is reachable with one thumb.", level: "must" }],
    acceptance: [{ id: "a1", text: "A gate can be approved at 320px.", machineVerifiable: false }],
    constraints: [],
    gated: true,
  },
};

const design: ProjectWorkBody = {
  kind: "design",
  design: {
    brief: "The review footer.",
    screens: [
      {
        id: "s1",
        name: "Review",
        content: {
          tree: {
            rootNodeId: "n1",
            nodes: [
              { id: "n1", component: { primitive: "stack" }, fidelity: "mapped", props: { tone: { type: "token", tokenId: "color.surface" } }, children: ["n2"] },
              { id: "n2", component: { primitive: "text" }, fidelity: "proposed", props: {}, children: [], text: "Approve" },
            ],
          },
        },
        states: [],
        fidelity: "mapped",
      },
    ],
    flows: [{ id: "f1", fromScreenId: "s1", trigger: "click", action: { type: "close" } }],
    sketches: [],
    fidelity: "mapped",
    fixtures: [],
  },
};

const comment = (input: Partial<ProjectWorkComment> & { commentId: string }): ProjectWorkComment => ({
  projectId: "prj_1",
  entityId: "wk_1",
  revisionId: "rev_1",
  anchor: { target: "entity" },
  text: "Something to say.",
  state: "open",
  blocking: false,
  createdAt: "2026-09-21T10:00:00.000Z",
  origin: { actor: { kind: "person", label: "You" } },
  ...input,
});

describe("comment anchors are semantic", () => {
  it("offers every requirement, criterion and named section of a spec", () => {
    const targets = anchorTargets(spec);
    expect(targets[0]).toEqual({ target: "entity", id: "", label: "The whole item" });
    expect(targets.filter((candidate) => candidate.target === "section").map((candidate) => candidate.id)).toEqual([
      "brief",
      "outcome:1",
      "r1",
      "a1",
    ]);
    expect(findAnchorTarget(spec, { target: "section", sectionId: "r1" })?.text).toContain("one thumb");
    expect(findAnchorTarget(spec, { target: "section", sectionId: "r9" })).toBeUndefined();
  });

  it("offers a design's screens, nodes, flow edges and the tokens its nodes use", () => {
    const targets = anchorTargets(design);
    expect(targets.filter((candidate) => candidate.target === "region").map((candidate) => candidate.id)).toEqual(["s1"]);
    expect(targets.filter((candidate) => candidate.target === "node").map((candidate) => candidate.id)).toEqual(["n1", "n2"]);
    expect(targets.filter((candidate) => candidate.target === "flow_edge").map((candidate) => candidate.id)).toEqual(["f1"]);
    expect(targets.filter((candidate) => candidate.target === "token").map((candidate) => candidate.id)).toEqual(["color.surface"]);
    expect(findAnchorTarget(design, { target: "node", nodeId: "n2", screenId: "s1" })?.screenId).toBe("s1");
  });

  it("keeps a text range only while the words it quoted are still there", () => {
    const quoted = "one thumb";
    const from = "The review footer is reachable with ".length;
    const anchor = { target: "text", sectionId: "r1", from, to: from + quoted.length, textHash: fakeHash(quoted) } as const;
    expect(anchorResolves(spec, anchor, fakeHash)).toBe(true);

    const reworded: ProjectWorkBody = {
      kind: "spec",
      spec: { ...spec.spec, requirements: [{ id: "r1", text: "The review footer is reachable with either hand.", level: "must" }] },
    };
    expect(anchorResolves(reworded, anchor, fakeHash)).toBe(false);
    // The comment is not lost with it: the anchor still says what it meant.
    expect(describeAnchor(anchor)).toBe("A quoted range in r1");
  });

  it("offers a plan's phases and the tasks it lists, and a research question and finding", () => {
    const plan: ProjectWorkBody = {
      kind: "plan",
      plan: {
        brief: "Ship phone review.",
        phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-4", "TASK-5"] }],
        dependencies: [],
        boundaries: [],
        migrations: [],
        risks: [],
        verification: ["pnpm verify"],
      },
    };
    expect(anchorTargets(plan).map((candidate) => candidate.id)).toEqual(["", "brief", "p1", "TASK-4", "TASK-5"]);
    expect(anchorResolves(plan, { target: "section", sectionId: "TASK-5" }, fakeHash)).toBe(true);

    const research: ProjectWorkBody = {
      kind: "research",
      research: {
        question: "Which PDF library?",
        scope: { in: [], out: [], constraints: [] },
        status: "open",
        questions: [{ id: "q1", text: "Does it run on Node 24?", state: "open", findings: [] }],
        findings: [],
        unresolved: [],
        sources: [],
      },
    };
    expect(anchorTargets(research).map((candidate) => candidate.id)).toEqual(["", "question", "q1"]);
  });

  it("resolves the whole-item anchor in every body, and a range past the end in none", () => {
    expect(anchorResolves(spec, { target: "entity" }, fakeHash)).toBe(true);
    expect(anchorResolves(design, { target: "entity" }, fakeHash)).toBe(true);
    expect(anchorResolves(spec, { target: "text", sectionId: "r1", from: 0, to: 9999, textHash: fakeHash("x") }, fakeHash)).toBe(false);
  });
});

describe("comments make threads", () => {
  it("groups replies under their root, oldest first, and keeps an orphaned reply visible", () => {
    const threads = commentThreads([
      comment({ commentId: "c1" }),
      comment({ commentId: "c2", parentCommentId: "c1", createdAt: "2026-09-21T11:00:00.000Z", state: "addressed" }),
      comment({ commentId: "c3", parentCommentId: "gone", text: "Its parent was deleted." }),
    ]);
    expect(threads.map((thread) => thread.root.commentId)).toEqual(["c1", "c3"]);
    expect(threads[0]?.replies.map((reply) => reply.commentId)).toEqual(["c2"]);
  });

  it("calls a thread open while anything in it is open, and resolved only when all of it is", () => {
    const open = commentThreads([comment({ commentId: "c1", state: "resolved" }), comment({ commentId: "c2", parentCommentId: "c1" })]);
    expect(open[0]?.state).toBe("open");
    const addressed = commentThreads([
      comment({ commentId: "c1", state: "addressed" }),
      comment({ commentId: "c2", parentCommentId: "c1", state: "resolved" }),
    ]);
    expect(addressed[0]?.state).toBe("addressed");
    const done = commentThreads([comment({ commentId: "c1", state: "resolved" })]);
    expect(done[0]?.state).toBe("resolved");
  });

  it("keeps a thread blocking while an unresolved blocking comment is in it", () => {
    const threads = commentThreads([
      comment({ commentId: "c1" }),
      comment({ commentId: "c2", parentCommentId: "c1", blocking: true, state: "addressed" }),
    ]);
    expect(threads[0]?.blocking).toBe(true);
    expect(openBlockingComments([comment({ commentId: "c2", blocking: true, state: "addressed" }), comment({ commentId: "c3", blocking: true, state: "resolved" })]).map((candidate) => candidate.commentId)).toEqual(["c2"]);
  });

  it("lets an agent address a comment and nothing more", () => {
    expect(commentResolutionAllowed({ resolution: "addressed", actor: "agent", from: "open" }).ok).toBe(true);
    const resolved = commentResolutionAllowed({ resolution: "resolved", actor: "agent", from: "addressed" });
    expect(resolved).toEqual({ ok: false, reason: "An agent can mark a comment addressed; only you can resolve or reopen it." });
    expect(commentResolutionAllowed({ resolution: "reopened", actor: "agent", from: "resolved" }).ok).toBe(false);
    expect(commentResolutionAllowed({ resolution: "reopened", actor: "person", from: "resolved" }).ok).toBe(true);
    expect(commentResolutionAllowed({ resolution: "addressed", actor: "person", from: "resolved" }).ok).toBe(false);
    expect(commentResolutionAllowed({ resolution: "reopened", actor: "person", from: "open" }).ok).toBe(false);
  });
});

describe("the three gates and their outcomes", () => {
  it("offers each gate the outcomes the contract gives it, and no others", () => {
    expect(GATE_OUTCOMES.brief.map((outcome) => outcome.id)).toEqual(["approve", "request_changes", "archive"]);
    expect(GATE_OUTCOMES.design.map((outcome) => outcome.id)).toEqual(["approve", "request_changes"]);
    expect(GATE_OUTCOMES.build.map((outcome) => outcome.id)).toEqual(["build_autonomously", "build_with_manual_tool_review", "request_changes"]);
    expect(gateOutcome("build", "build_with_manual_tool_review")?.mode).toBe("manual_tool_review");
    expect(gateOutcome("design", "archive")).toBeUndefined();
  });

  it("refuses an outcome a gate does not have, and a build approval with no permission mode", () => {
    expect(gateDecisionAllowed({ gate: "brief", decision: "archived" }).ok).toBe(true);
    expect(gateDecisionAllowed({ gate: "design", decision: "archived" })).toEqual({
      ok: false,
      reason: "The design gate has these outcomes: approve, request changes.",
    });
    expect(gateDecisionAllowed({ gate: "build", decision: "approved" })).toEqual({
      ok: false,
      reason: "Say how the build may run: autonomously, or with manual tool review.",
    });
    expect(gateDecisionAllowed({ gate: "build", decision: "approved", mode: "autonomous" }).ok).toBe(true);
    expect(gateDecisionAllowed({ gate: "brief", decision: "approved", mode: "autonomous" })).toEqual({
      ok: false,
      reason: "A permission mode belongs to approving the build, and to nothing else.",
    });
    expect(gateDecisionAllowed({ gate: "build", decision: "changes_requested" }).ok).toBe(true);
  });

  it("carries the gated opt-in in the spec's own bytes, and defaults to ungated", () => {
    expect(specBodySchema.parse(spec.spec).gated).toBe(true);
    const ungated = projectWorkBodySchema.parse({ kind: "spec", spec: { ...spec.spec, gated: undefined } });
    expect(ungated.kind === "spec" ? ungated.spec.gated : "not a spec").toBeUndefined();
  });
});
