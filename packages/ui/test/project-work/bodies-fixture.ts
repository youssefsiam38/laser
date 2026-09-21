/**
 * One Spec body and one Research body, as the host would answer with them,
 * plus the `project/work/get` envelope the detail reads (M21-T7).
 *
 * Every field is real and bounded by the protocol's own schema: the tests
 * render from these exactly as the workspace renders from the host.
 */
import type { ClientRequests, ProjectWorkKind, ResearchBody, SpecBody } from "@lasercode/protocol";

export function specFixture(over: Partial<SpecBody> = {}): SpecBody {
  return {
    form: "full",
    brief: "One relay, end to end encrypted, so a phone can drive a desktop session.",
    problem: "A phone cannot reach the desktop's host directly.",
    outcomes: ["A phone pairs in one step", "Nothing readable passes the relay"],
    nonGoals: ["Hosting sessions in the cloud"],
    requirements: [{ id: "r1", text: "The relay forwards bytes and parses only the channel id", level: "must" }],
    acceptance: [{ id: "a1", text: "A paired phone drives a session over the relay", machineVerifiable: true }],
    constraints: ["No third party may hold a key"],
    document: "# The relay\n\nIt forwards bytes.\n",
    ...over,
  };
}

export function researchFixture(over: Partial<ResearchBody> = {}): ResearchBody {
  return {
    question: "Which PDF library should this project use?",
    scope: { in: ["Node 24"], out: ["Browser rendering"], constraints: ["Permissive licence only"] },
    status: "partial",
    questions: [
      { id: "q1", text: "Does the loader wait for the frame?", state: "answered", answer: "It does.", findings: ["f1"] },
      { id: "q2", text: "Does it work on Node 24?", parent: "q1", state: "open", findings: [] },
      { id: "q3", text: "What does the licence allow?", state: "handed_to_person", findings: [] },
    ],
    findings: [
      {
        id: "f1",
        claim: 'The docs say it "waits for the frame to settle" before painting.',
        confidence: "declared",
        source: {
          kind: "web",
          id: "https://example.org/docs/loader",
          title: "Loader — documentation",
          fetchedVia: "web",
          trust: "official",
        },
        excerpt: "The loader waits for the frame to settle before it paints, and only then reports readiness.",
        retrievedAt: "2026-02-02T10:00:00.000Z",
        licence: "permissive",
        supports: [],
        contradicts: [],
      },
      {
        id: "f2",
        claim: "The repository's licence file is Apache-2.0.",
        confidence: "observed",
        source: {
          kind: "repository",
          id: "github.com/acme/widget@0123456789abcdef",
          title: "acme/widget",
          fetchedVia: "repository",
          trust: "primary",
        },
        excerpt: "Licensed under the Apache License, Version 2.0.",
        retrievedAt: "2026-02-02T10:05:00.000Z",
        licence: "permissive",
        supports: [],
        contradicts: [],
      },
    ],
    options: [
      { name: "widget", summary: "Small, permissive, maintained.", findings: ["f2"], tradeoffs: ["No tables"], recommended: true, reason: "Licence fits." },
    ],
    unresolved: [{ fact: "Whether it renders CJK", wouldSettleIt: "Rendering one CJK document and looking at it." }],
    sources: [
      { kind: "web", id: "https://example.org/docs/loader", title: "Loader — documentation", fetchedVia: "web", trust: "official" },
      { kind: "repository", id: "github.com/acme/widget@0123456789abcdef", title: "acme/widget", fetchedVia: "repository", trust: "primary" },
    ],
    ...over,
  };
}

type Detail = ClientRequests["project/work/get"]["result"];

const KEY_PREFIX: Record<ProjectWorkKind, string> = { spec: "SPEC", research: "RES", design: "DES", plan: "PLAN", task: "TASK" };

/** The `project/work/get` answer for one entity at one revision. */
export function detailFixture(options: {
  kind: ProjectWorkKind;
  number: number;
  body: Detail["body"];
  entityId?: string;
  revisionId?: string;
  currentRevisionId?: string;
  index?: number;
  revisionCount?: number;
  title?: string;
  edges?: Detail["edges"];
}): Detail {
  const entityId = options.entityId ?? "e1";
  const revisionId = options.revisionId ?? "r1";
  const currentRevisionId = options.currentRevisionId ?? revisionId;
  const key = `${KEY_PREFIX[options.kind]}-${options.number}`;
  const title = options.title ?? key;
  const digest = "a".repeat(64);
  return {
    ref: { projectId: "p1", kind: options.kind, entityId, revisionId, digest, label: title, key },
    entity: {
      projectId: "p1",
      entityId,
      kind: options.kind,
      key,
      keyNumber: options.number,
      title,
      state: "draft",
      currentRevisionId,
      currentDigest: digest,
      revisionCount: options.revisionCount ?? 1,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
      origin: { actor: { kind: "person", label: "You" } },
    },
    revision: {
      projectId: "p1",
      entityId,
      revisionId,
      index: options.index ?? 1,
      digest,
      title,
      createdAt: "2026-02-02T00:00:00.000Z",
      origin: { actor: { kind: "person", label: "You" } },
      bodyBytes: 512,
    },
    fence: { entityId, revisionId, digest, seq: 7 },
    ...(options.body ? { body: options.body } : {}),
    edges: options.edges ?? [],
    repositoryLinks: [],
    executionLinks: [],
    comments: [],
    approvals: [],
    evidence: [],
    decisions: [],
    truncated: [],
  } as unknown as Detail;
}

/** A whole body page, the way the host answers `body: { mode: "full" }`. */
export function bodyPage(body: { kind: "spec"; spec: SpecBody } | { kind: "research"; research: ResearchBody }): Detail["body"] {
  const text = JSON.stringify(body);
  return { encoding: "application/json", totalBytes: text.length, offset: 0, bytes: text.length, text, body };
}
