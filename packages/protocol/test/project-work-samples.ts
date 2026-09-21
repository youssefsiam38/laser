/**
 * Round-trip samples for the project-work domain (M21-T1).
 *
 * One valid value per body kind and one valid params value per method, so the
 * tests can prove that every schema parses what the product actually sends and
 * refuses what it must not. Not a test file itself: vitest only collects
 * `*.test.ts`.
 */
import type {
  DesignBody,
  PlanBody,
  ProjectTaskBody,
  ProjectWorkBody,
  ResearchBody,
  SpecBody,
} from "../src/project-work-bodies.js";
import type { ProjectWorkMethod } from "../src/project-work-methods.js";

export const SAMPLE_PROJECT_ID = "prj_7Hk2";
export const SAMPLE_ENTITY_ID = "wk_2b91";
export const SAMPLE_REVISION_ID = "rev_5c02";
export const SAMPLE_DIGEST = "a".repeat(64);

export const sampleSpecBody: SpecBody = {
  form: "brief",
  brief: "People cannot review a design from their phone.",
  problem: "The workspace is desktop-only.",
  outcomes: ["A person can read and approve a design on a phone."],
  nonGoals: ["Editing the canvas on a phone."],
  requirements: [{ id: "r1", text: "The review footer is reachable with one thumb.", level: "must" }],
  acceptance: [{ id: "a1", text: "A gate can be approved at 320px.", machineVerifiable: false }],
  constraints: ["No horizontal page scroll."],
};

export const sampleResearchBody: ResearchBody = {
  question: "Which static parsers can read a Tailwind theme without evaluating it?",
  scope: { in: ["Tailwind 3 and 4"], out: ["Runtime plugins"], constraints: ["Parse only"] },
  status: "partial",
  questions: [
    { id: "q1", text: "Does Tailwind 4 keep its theme in CSS?", state: "answered", answer: "Yes, as CSS custom properties.", findings: ["f1"] },
    { id: "q2", text: "What about typed token objects?", parent: "q1", state: "open", findings: [] },
  ],
  findings: [
    {
      id: "f1",
      claim: "Tailwind 4 declares its theme with CSS custom properties.",
      confidence: "declared",
      source: { kind: "web", id: "https://tailwindcss.com/docs/theme", title: "Theme", fetchedVia: "web", trust: "official", digest: "b".repeat(64) },
      excerpt: "The theme is defined with CSS variables.",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      licence: "unknown",
      supports: ["DES-3"],
      contradicts: [],
    },
  ],
  unresolved: [{ fact: "Whether v3 configs can always be parsed.", wouldSettleIt: "A survey of real configs." }],
  sources: [{ kind: "web", id: "https://tailwindcss.com/docs/theme", title: "Theme", fetchedVia: "web", trust: "official" }],
};

export const sampleDesignBody: DesignBody = {
  brief: "The review footer on a phone.",
  screens: [
    {
      id: "s1",
      name: "Review",
      content: {
        tree: {
          rootNodeId: "n1",
          nodes: [
            {
              id: "n1",
              component: { primitive: "stack" },
              fidelity: "mapped",
              props: { gap: { type: "token", tokenId: "space.2" } },
              children: ["n2"],
            },
            {
              id: "n2",
              component: { indexEntryId: "ix_button" },
              fidelity: "mapped",
              props: { label: { type: "text", value: "Approve" } },
              children: [],
              text: "Approve",
            },
          ],
        },
      },
      states: [{ name: "loading", included: true }],
      fidelity: "mapped",
    },
  ],
  flows: [{ id: "e1", fromScreenId: "s1", fromNodeId: "n2", trigger: "click", action: { type: "overlay", screenId: "s1" } }],
  sketches: [],
  fidelity: "mapped",
  fixtures: [{ id: "fx1", name: "comments", rows: 3 }],
};

export const samplePlanBody: PlanBody = {
  brief: "Ship phone review.",
  phases: [{ id: "p1", name: "Spine", taskKeys: ["TASK-1", "TASK-2"] }],
  dependencies: [{ from: "TASK-2", to: "TASK-1" }],
  boundaries: [{ scope: "packages/ui", rule: "No new protocol shapes here." }],
  migrations: [],
  risks: [{ summary: "The footer covers the transcript.", control: "Sticky footer with safe-area inset.", severity: "medium" }],
  verification: ["pnpm verify"],
};

export const sampleTaskBody: ProjectTaskBody = {
  outcome: "The review footer is sticky on a phone.",
  nonGoals: ["Desktop layout changes."],
  dependencies: ["TASK-1"],
  scope: { packages: ["@lasercode/ui"], repositories: [], paths: ["packages/ui/src/workspace"], capabilities: [] },
  acceptance: [{ id: "a1", text: "Approve is reachable at 320px.", machineVerifiable: false }],
  verificationCommands: ["pnpm -F @lasercode/ui test"],
  visualEvidenceRequired: true,
  assignment: { policy: "unassigned" },
  planKey: "PLAN-1",
};

export const sampleBodies: Record<ProjectWorkBody["kind"], ProjectWorkBody> = {
  spec: { kind: "spec", spec: sampleSpecBody },
  research: { kind: "research", research: sampleResearchBody },
  design: { kind: "design", design: sampleDesignBody },
  plan: { kind: "plan", plan: samplePlanBody },
  task: { kind: "task", task: sampleTaskBody },
};

/** One valid params value per method, in the inventory's order. */
export const sampleMethodParams: Record<ProjectWorkMethod, unknown> = {
  "project/work/list": { projectId: SAMPLE_PROJECT_ID, kinds: ["spec", "task"], needsYou: true, limit: 50 },
  "project/work/get": { projectId: SAMPLE_PROJECT_ID, key: "SPEC-12", body: { mode: "range", offset: 0, limit: 4096 } },
  "project/work/search": { projectId: SAMPLE_PROJECT_ID, query: "TASK-44", limit: 20 },
  "project/work/blob/read": { projectId: SAMPLE_PROJECT_ID, blobId: "blb_1", offset: 0, limit: 65_536 },
  "project/work/create": {
    projectId: SAMPLE_PROJECT_ID,
    kind: "spec",
    title: "Phone review",
    body: { kind: "spec", spec: sampleSpecBody },
    idempotencyKey: "create-1",
  },
  "project/work/revise": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    body: { kind: "spec", spec: { ...sampleSpecBody, form: "full" } },
    idempotencyKey: "revise-1",
    note: "Full spec after the design review.",
  },
  "project/work/archive": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    archived: true,
    idempotencyKey: "archive-1",
  },
  "project/work/delete": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    confirm: true,
    idempotencyKey: "delete-1",
  },
  "project/work/comment": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    revisionId: SAMPLE_REVISION_ID,
    anchor: { target: "node", nodeId: "n2" },
    text: "This should use the semantic token.",
    blocking: true,
    idempotencyKey: "comment-1",
  },
  "project/work/review": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    action: "request_review",
    idempotencyKey: "review-1",
  },
  "project/work/approve": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    gate: "brief",
    decision: "approved",
    covers: [{ entityId: SAMPLE_ENTITY_ID, kind: "spec", key: "SPEC-12", revisionId: SAMPLE_REVISION_ID, digest: SAMPLE_DIGEST }],
    idempotencyKey: "approve-1",
  },
  "project/work/resolve-comment": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    commentId: "cm_1",
    resolution: "resolved",
    idempotencyKey: "resolve-1",
  },
  "project/work/link": {
    projectId: SAMPLE_PROJECT_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    link: {
      type: "repository",
      relation: "implemented_by",
      subjectEntityId: SAMPLE_ENTITY_ID,
      subjectRevisionId: SAMPLE_REVISION_ID,
      repositoryId: "repo_1",
      target: {
        change: {
          base: { vcs: "git", objectFormat: "sha1", commitObjectId: "0".repeat(40) },
          head: { vcs: "git", objectFormat: "sha1", commitObjectId: "1".repeat(40) },
          diffDigest: "c".repeat(64),
        },
      },
    },
    idempotencyKey: "link-1",
  },
  "project/work/unlink": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    linkId: "lnk_1",
    idempotencyKey: "unlink-1",
  },
  "project/task/action": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    action: "complete",
    evidenceId: "ev_1",
    idempotencyKey: "task-1",
  },
  "project/task/link-execution": {
    projectId: SAMPLE_PROJECT_ID,
    entityId: SAMPLE_ENTITY_ID,
    expectedRevisionId: SAMPLE_REVISION_ID,
    execution: { kind: "agent_run", targetId: "run_9", attempt: 2, profileId: "smart", branch: "agents/task-44" },
    idempotencyKey: "exec-1",
  },
};
