/**
 * M21-T1: the domain itself — keys, references, the closed records, the body
 * schemas and the two rules that would be invisible if they broke: no primary
 * entity carries a session owner (D-329), and no Design record carries the
 * `Native` fidelity (D-353).
 */
import { describe, expect, it } from "vitest";
import { PROJECT_DIR_NAME } from "../src/identity.js";
import { CHECKPOINT_REF_NAMESPACE } from "../src/source-control.js";
import {
  PROJECT_WORK_KINDS,
  PROJECT_WORK_KEY_PREFIXES,
  attemptRepositoryRecordSchema,
  executionLinkSchema,
  parseProjectWorkKey,
  planDependencyCycle,
  projectWorkEntitySchema,
  projectWorkKey,
  projectWorkRefSchema,
  projectWorkRefText,
  projectWorkRevisionSchema,
  REPOSITORY_CAPTURE_ATTACH_REASONS,
  REPOSITORY_CAPTURE_HISTORY_MAX,
  REQUIRED_PATHS_MAX,
  repositoryCaptureSchema,
  repositoryLinkSchema,
  sameProjectWorkRevision,
  statesForKind,
  type ProjectWorkEntity,
  type ProjectWorkRef,
  type RepositoryLinkAcceptance,
  type RepositoryLinkCaptureRevision,
} from "../src/project-work.js";
import {
  DESIGN_FIDELITIES,
  SKETCH_MAX_BYTES,
  designAggregateFidelity,
  designBodySchema,
  designIsSketchOnly,
  formatAssignment,
  parseAssignment,
  planBodySchema,
  projectTaskBodySchema,
  projectWorkBodySchema,
  researchBodySchema,
  searchableBodyValues,
  specBodySchema,
} from "../src/project-work-bodies.js";
import {
  SAMPLE_DIGEST,
  SAMPLE_ENTITY_ID,
  SAMPLE_PROJECT_ID,
  SAMPLE_REVISION_ID,
  sampleBodies,
  sampleDesignBody,
  samplePlanBody,
  sampleResearchBody,
} from "./project-work-samples.js";

const ref = (over: Partial<ProjectWorkRef> = {}): ProjectWorkRef => ({
  projectId: SAMPLE_PROJECT_ID,
  kind: "spec",
  entityId: SAMPLE_ENTITY_ID,
  revisionId: SAMPLE_REVISION_ID,
  digest: SAMPLE_DIGEST,
  label: "Phone review",
  key: "SPEC-12",
  ...over,
});

const entity = (over: Partial<ProjectWorkEntity> = {}): ProjectWorkEntity => ({
  projectId: SAMPLE_PROJECT_ID,
  entityId: SAMPLE_ENTITY_ID,
  kind: "spec",
  key: "SPEC-12",
  keyNumber: 12,
  title: "Phone review",
  state: "draft",
  currentRevisionId: SAMPLE_REVISION_ID,
  currentDigest: SAMPLE_DIGEST,
  revisionCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("keys", () => {
  it("has one prefix per kind and round-trips every one", () => {
    expect(Object.keys(PROJECT_WORK_KEY_PREFIXES).sort()).toEqual([...PROJECT_WORK_KINDS].sort());
    for (const kind of PROJECT_WORK_KINDS) {
      const key = projectWorkKey(kind, 7);
      expect(key).toBe(`${PROJECT_WORK_KEY_PREFIXES[kind]}-7`);
      expect(parseProjectWorkKey(key)).toEqual({ kind, number: 7 });
    }
    expect(projectWorkKey("spec", 12)).toBe("SPEC-12");
    expect(projectWorkKey("research", 7)).toBe("RES-7");
    expect(projectWorkKey("design", 3)).toBe("DES-3");
    expect(projectWorkKey("plan", 2)).toBe("PLAN-2");
    expect(projectWorkKey("task", 44)).toBe("TASK-44");
  });

  it("refuses anything that is not a key this app minted", () => {
    for (const bad of ["", "SPEC", "SPEC-", "SPEC-0", "SPEC-007", "spec-1", "ISSUE-1", "TASK-44x", "TASK--1", "TASK-1.0"]) {
      expect(parseProjectWorkKey(bad)).toBeUndefined();
    }
    expect(() => projectWorkKey("spec", 0)).toThrow(RangeError);
    expect(() => projectWorkKey("spec", 1.5)).toThrow(RangeError);
  });
});

describe("ProjectWorkRef", () => {
  it("carries project, kind, entity, revision, digest, label and key", () => {
    const parsed = projectWorkRefSchema.parse(ref());
    expect(Object.keys(parsed).sort()).toEqual(["digest", "entityId", "key", "kind", "label", "projectId", "revisionId"]);
  });

  it("refuses a key whose prefix contradicts the kind", () => {
    expect(projectWorkRefSchema.safeParse(ref({ kind: "task" })).success).toBe(false);
    expect(projectWorkRefSchema.safeParse(ref({ kind: "task", key: "TASK-12" })).success).toBe(true);
  });

  it("refuses a ref without an exact revision or digest", () => {
    const { revisionId: _revision, ...withoutRevision } = ref();
    expect(projectWorkRefSchema.safeParse(withoutRevision).success).toBe(false);
    const { digest: _digest, ...withoutDigest } = ref();
    expect(projectWorkRefSchema.safeParse(withoutDigest).success).toBe(false);
  });

  it("shows a stable human form and compares by exact revision", () => {
    expect(projectWorkRefText(ref())).toBe("SPEC-12 · Phone review");
    expect(projectWorkRefText({ key: "TASK-1", label: "" })).toBe("TASK-1");
    expect(sameProjectWorkRevision(ref(), ref())).toBe(true);
    expect(sameProjectWorkRevision(ref(), ref({ revisionId: "rev_other" }))).toBe(false);
  });
});

describe("no session owns project work (D-329)", () => {
  it("refuses a session or owner field on an entity", () => {
    for (const field of ["sessionId", "sessionPath", "ownerSessionId", "owner", "runId", "cwd", "path"]) {
      const candidate = { ...entity(), [field]: "whatever" };
      expect(projectWorkRefSchema.safeParse(candidate).success).toBe(false);
      expect(projectWorkEntitySchema.safeParse(candidate).success).toBe(false);
    }
    expect(projectWorkEntitySchema.safeParse(entity()).success).toBe(true);
  });

  it("keeps the session on a revision as provenance only, and optional", () => {
    const revision = {
      projectId: SAMPLE_PROJECT_ID,
      entityId: SAMPLE_ENTITY_ID,
      revisionId: SAMPLE_REVISION_ID,
      kind: "spec" as const,
      index: 1,
      title: "Phone review",
      digest: SAMPLE_DIGEST,
      bodyBytes: 120,
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: { actor: { kind: "person" as const, label: "You" } },
      state: "draft" as const,
    };
    expect(projectWorkRevisionSchema.safeParse(revision).success).toBe(true);
    const withSession = { ...revision, origin: { ...revision.origin, sessionId: "ses_1" } };
    expect(projectWorkRevisionSchema.safeParse(withSession).success).toBe(true);
    // …and it is never promoted to the revision itself.
    expect(projectWorkRevisionSchema.safeParse({ ...revision, sessionId: "ses_1" }).success).toBe(false);
  });

  it("refuses a state that does not belong to the kind", () => {
    expect(projectWorkEntitySchema.safeParse(entity({ state: "in_progress" })).success).toBe(false);
    expect(projectWorkEntitySchema.safeParse(entity({ kind: "task", key: "TASK-12", state: "in_progress" })).success).toBe(true);
    expect(projectWorkEntitySchema.safeParse(entity({ kind: "task", key: "TASK-12", state: "approved" })).success).toBe(false);
    expect(statesForKind("task")).toContain("in_progress");
    expect(statesForKind("spec")).toContain("needs_review");
  });
});

describe("repository provenance (D-345)", () => {
  const base = {
    projectId: SAMPLE_PROJECT_ID,
    linkId: "lnk_1",
    subject: ref(),
    repositoryId: "repo_1",
    createdBy: { kind: "agent" as const, label: "Builder" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const state = { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "1".repeat(40) };
  const change = { base: { ...state }, head: { ...state, commitObjectId: "2".repeat(40) }, diffDigest: "d".repeat(64) };

  it("targets a state for based_on and verified_at, and a change for implemented_by", () => {
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "based_on", target: { state } }).success).toBe(true);
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "verified_at", target: { state } }).success).toBe(true);
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "implemented_by", target: { change } }).success).toBe(true);
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "implemented_by", target: { state } }).success).toBe(false);
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "based_on", target: { change } }).success).toBe(false);
  });

  it("requires the exported path for published_as", () => {
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "published_as", target: { state } }).success).toBe(false);
    expect(
      repositoryLinkSchema.safeParse({ ...base, relation: "published_as", target: { state }, publishedPath: `${PROJECT_DIR_NAME}/work/SPEC-12.md` })
        .success,
    ).toBe(true);
  });

  it("refuses an absolute host path inside a state ref", () => {
    const absolute = { ...state, path: "/home/someone/project/src/app.tsx" };
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "based_on", target: { state: absolute } }).success).toBe(false);
    const relative = { ...state, path: "src/app.tsx" };
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "based_on", target: { state: relative } }).success).toBe(true);
  });

  it("records a pruned source as unavailable without losing the identity", () => {
    const parsed = repositoryLinkSchema.parse({ ...base, relation: "verified_at", target: { state }, sourceUnavailable: true, captureBlobId: "blb_9" });
    expect(parsed.sourceUnavailable).toBe(true);
    expect("state" in parsed.target && parsed.target.state.commitObjectId).toBe("1".repeat(40));
  });

  it("keeps the pull request as display context, never as identity (M21-T18)", () => {
    const parsed = repositoryLinkSchema.parse({
      ...base,
      relation: "implemented_by",
      target: { change },
      display: { branch: "main", remote: "origin", pullRequest: { number: 7, host: "github", url: "https://example.invalid/pull/7" } },
    });
    expect("change" in parsed.target && parsed.target.change.head.commitObjectId).toBe("2".repeat(40));
    expect(parsed.display?.pullRequest?.number).toBe(7);
    // A remote is named, never addressed: no URL travels as identity.
    expect(repositoryLinkSchema.safeParse({ ...base, relation: "based_on", target: { state }, display: { remoteUrl: "git@x:y.git" } }).success).toBe(
      false,
    );
  });
});

describe("execution links never transfer ownership", () => {
  it("names the target by opaque id and keeps the attempt", () => {
    const link = {
      projectId: SAMPLE_PROJECT_ID,
      linkId: "lnk_2",
      entityId: SAMPLE_ENTITY_ID,
      kind: "session" as const,
      targetId: "ses_1",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      createdBy: { kind: "person" as const, label: "You" },
    };
    expect(executionLinkSchema.safeParse(link).success).toBe(true);
    expect(executionLinkSchema.safeParse({ ...link, targetUnavailable: true }).success).toBe(true);
    // No path, ever: a link that named a checkout would leak storage layout.
    expect(executionLinkSchema.safeParse({ ...link, sessionPath: "/tmp/a.jsonl" }).success).toBe(false);
  });

  it("carries one record per repository, with checkpoints resolved to object ids (M21-T18)", () => {
    const record = {
      repositoryId: "repo_1",
      name: "app",
      base: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "1".repeat(40) },
      sinceTurn: 2,
      checkpoints: [
        { turn: 3, ref: `${CHECKPOINT_REF_NAMESPACE}/abc/3`, commitObjectId: "3".repeat(40) },
        { turn: 4, ref: `${CHECKPOINT_REF_NAMESPACE}/abc/4`, commitObjectId: "4".repeat(40) },
      ],
      change: {
        base: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "3".repeat(40) },
        head: { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "4".repeat(40) },
        diffDigest: "d".repeat(64),
      },
      changedPaths: ["src/a.ts"],
      commits: ["5".repeat(40)],
    };
    expect(attemptRepositoryRecordSchema.safeParse(record).success).toBe(true);
    // A changed path is repository-relative, like every other path here.
    expect(attemptRepositoryRecordSchema.safeParse({ ...record, checkout: "/home/someone/app" }).success).toBe(false);

    const link = {
      projectId: SAMPLE_PROJECT_ID,
      linkId: "lnk_3",
      entityId: SAMPLE_ENTITY_ID,
      kind: "agent_run" as const,
      targetId: "run_1",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      createdBy: { kind: "person" as const, label: "You" },
      repositories: [record, { ...record, repositoryId: "repo_2", name: "lib", changedPaths: [], commits: [] }],
    };
    const parsed = executionLinkSchema.parse(link);
    expect(parsed.repositories?.map((row) => row.repositoryId)).toEqual(["repo_1", "repo_2"]);
  });
});

describe("bodies", () => {
  it("parses one valid sample per kind", () => {
    for (const kind of PROJECT_WORK_KINDS) {
      const body = sampleBodies[kind];
      expect(projectWorkBodySchema.safeParse(body).success).toBe(true);
    }
  });

  it("keeps the Spec's brief and full forms", () => {
    expect(specBodySchema.parse(sampleBodies.spec.kind === "spec" ? sampleBodies.spec.spec : undefined).form).toBe("brief");
    expect(specBodySchema.safeParse({ ...sampleBodies.spec, form: "sketch" }).success).toBe(false);
  });

  it("refuses a research tree with a cycle, a missing parent or an uncited answer", () => {
    expect(researchBodySchema.safeParse(sampleResearchBody).success).toBe(true);
    const missingParent = { ...sampleResearchBody, questions: [{ id: "q1", text: "x", parent: "nope", state: "open" as const, findings: [] }] };
    expect(researchBodySchema.safeParse(missingParent).success).toBe(false);
    const cycle = {
      ...sampleResearchBody,
      questions: [
        { id: "q1", text: "a", parent: "q2", state: "open" as const, findings: [] },
        { id: "q2", text: "b", parent: "q1", state: "open" as const, findings: [] },
      ],
    };
    expect(researchBodySchema.safeParse(cycle).success).toBe(false);
    const uncited = {
      ...sampleResearchBody,
      questions: [{ id: "q1", text: "a", state: "answered" as const, answer: "yes", findings: [] }],
    };
    expect(researchBodySchema.safeParse(uncited).success).toBe(false);
    const inferredOnly = {
      ...sampleResearchBody,
      questions: [{ id: "q1", text: "a", state: "answered" as const, answer: "yes", findings: [], inferredOnly: true }],
    };
    expect(researchBodySchema.safeParse(inferredOnly).success).toBe(true);
  });

  it("caps a person or session source at secondary trust", () => {
    const body = {
      ...sampleResearchBody,
      sources: [{ kind: "person" as const, id: "you", title: "You said", fetchedVia: "person", trust: "official" as const }],
    };
    expect(researchBodySchema.safeParse(body).success).toBe(false);
  });

  it("never lets a Design record claim Native fidelity (D-353)", () => {
    expect([...DESIGN_FIDELITIES]).toEqual(["sketch", "mapped", "proposed"]);
    expect(designBodySchema.safeParse(sampleDesignBody).success).toBe(true);
    expect(designBodySchema.safeParse({ ...sampleDesignBody, fidelity: "native" }).success).toBe(false);
    const nativeScreen = {
      ...sampleDesignBody,
      screens: sampleDesignBody.screens.map((screen) => ({ ...screen, fidelity: "native" })),
    };
    expect(designBodySchema.safeParse(nativeScreen).success).toBe(false);
  });

  it("refuses markup, handlers and free values inside a design node", () => {
    const withHandler = structuredClone(sampleDesignBody);
    const screen = withHandler.screens[0];
    if (!screen || !("tree" in screen.content)) throw new Error("fixture");
    const node = screen.content.tree.nodes[0];
    if (!node) throw new Error("fixture");
    (node.props as Record<string, unknown>)["onClick"] = "alert(1)";
    expect(designBodySchema.safeParse(withHandler).success).toBe(false);
    const withHtml = structuredClone(sampleDesignBody);
    const htmlScreen = withHtml.screens[0];
    if (!htmlScreen || !("tree" in htmlScreen.content)) throw new Error("fixture");
    (htmlScreen.content.tree.nodes[0] as unknown as Record<string, unknown>)["html"] = "<script>";
    expect(designBodySchema.safeParse(withHtml).success).toBe(false);
  });

  it("keeps a sketch as bounded bytes in the blob store, never in the body", () => {
    const sketch = {
      id: "sk1",
      title: "Filtering demo",
      blobId: "blb_2",
      bytes: 1024,
      digest: "e".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
      bounds: { width: 390, height: 844 },
    };
    const body = { ...sampleDesignBody, screens: [{ id: "s2", name: "Sketch", content: { sketchId: "sk1" }, states: [], fidelity: "sketch" as const }], flows: [], sketches: [sketch], fidelity: "sketch" as const };
    expect(designBodySchema.safeParse(body).success).toBe(true);
    expect(designIsSketchOnly(body)).toBe(true);
    expect(designAggregateFidelity(body)).toBe("sketch");
    expect(designBodySchema.safeParse({ ...body, sketches: [{ ...sketch, bytes: SKETCH_MAX_BYTES + 1 }] }).success).toBe(false);
    expect(designBodySchema.safeParse({ ...body, sketches: [{ ...sketch, document: "<html>" }] }).success).toBe(false);
    // A screen cannot name a sketch this revision does not carry.
    expect(designBodySchema.safeParse({ ...body, sketches: [] }).success).toBe(false);
  });

  it("leaves a plan's dependency cycle to the graph validator, which names it (M21-T15)", () => {
    expect(planBodySchema.safeParse(samplePlanBody).success).toBe(true);
    const cyclic = {
      ...samplePlanBody,
      dependencies: [
        { from: "TASK-1", to: "TASK-2" },
        { from: "TASK-2", to: "TASK-1" },
      ],
    };
    // The shape is fine; the graph is not. `validatePlanGraph` owns that rule
    // so one pass can check the cycle *and* the keys against the project, and
    // so the refusal can name the keys — see `project-work-plan-graph.test.ts`
    // and the host's `task-engine.test.ts` for the refusal over the wire.
    expect(planBodySchema.safeParse(cyclic).success).toBe(true);
    expect(planDependencyCycle(cyclic.dependencies)).toEqual(["TASK-1", "TASK-2", "TASK-1"]);
    expect(planDependencyCycle(samplePlanBody.dependencies)).toBeUndefined();
  });

  it("carries the task assignment policy in both forms", () => {
    expect(formatAssignment({ policy: "unassigned" })).toBe("unassigned");
    expect(formatAssignment({ policy: "person" })).toBe("person");
    expect(formatAssignment({ policy: "agent", agentName: "Builder" })).toBe("agent:Builder");
    expect(parseAssignment("agent:Builder")).toEqual({ policy: "agent", agentName: "Builder" });
    expect(parseAssignment("agent:")).toBeUndefined();
    expect(parseAssignment("anybody")).toBeUndefined();
    const task = sampleBodies.task;
    if (task.kind !== "task") throw new Error("fixture");
    expect(projectTaskBodySchema.safeParse({ ...task.task, assignment: { policy: "agent", agentName: "Builder" } }).success).toBe(true);
    // A Task never embeds a session or run id: attempts are links.
    expect(projectTaskBodySchema.safeParse({ ...task.task, sessionId: "ses_1" }).success).toBe(false);
  });
});

describe("a capture says what a decision rests on, and can be read back", () => {
  const state = { vcs: "git" as const, objectFormat: "sha1" as const, commitObjectId: "a".repeat(40) };
  const capture = {
    version: 1 as const,
    createdAt: "2026-03-01T09:00:00.000Z",
    repositoryId: "rep_1",
    state,
    files: [{ path: "src/a.ts", status: "present" as const, added: null, removed: null }],
    sources: [{ path: "src/a.ts", bytes: 4, contentDigest: "b".repeat(64), text: "two\n", side: "after" as const }],
    required: {
      basis: "attempt_base_to_state" as const,
      from: { baseCommitObjectId: "c".repeat(40), executionLinkId: "lnk_1", taskEntityId: "ent_1" },
      entries: [{ path: "src/a.ts", status: "modified" as const, side: "after" as const, contentDigest: "b".repeat(64) }],
      complete: true as const,
    },
  };

  it("parses a capture of a state with its required set, both sides and all", () => {
    const parsed = repositoryCaptureSchema.safeParse(capture);
    expect(parsed.success).toBe(true);
    expect(
      repositoryCaptureSchema.safeParse({
        ...capture,
        sources: [{ ...capture.sources[0]!, side: "before" }],
        required: { ...capture.required, entries: [{ ...capture.required.entries[0]!, side: "before", status: "deleted" }] },
      }).success,
      "a delete is kept by the body at the base, which is a side and says so",
    ).toBe(true);
  });

  it("has no half-complete form, and no shape that is both a change and a state", () => {
    // `complete` exists only as `true`: a capture that could not keep every
    // source whole is not stored with a weaker flag, the decision is refused.
    expect(repositoryCaptureSchema.safeParse({ ...capture, required: { ...capture.required, complete: false } }).success).toBe(false);
    expect(repositoryCaptureSchema.safeParse({ ...capture, required: { ...capture.required, basis: "whatever" } }).success).toBe(false);
    expect(
      repositoryCaptureSchema.safeParse({ ...capture, change: { base: state, head: state, diffDigest: "d".repeat(64) } }).success,
      "exactly one of a change and a state",
    ).toBe(false);
    const { state: _state, ...neither } = capture;
    void _state;
    expect(repositoryCaptureSchema.safeParse(neither).success).toBe(false);
  });

  it("bounds the set a decision may rest on", () => {
    const entries = Array.from({ length: REQUIRED_PATHS_MAX + 1 }, (_, index) => ({
      path: `src/f-${String(index)}.ts`,
      status: "added" as const,
      side: "after" as const,
      contentDigest: "b".repeat(64),
    }));
    expect(repositoryCaptureSchema.safeParse({ ...capture, required: { ...capture.required, entries } }).success).toBe(false);
  });

  it("names the reasons one capture became a link's proof, and keeps the history bounded", () => {
    // The vocabulary is closed and each word means one thing: what a link was
    // written with, a correction taken while a gate was being prepared — which
    // is never read as a gate that succeeded — and the one association a
    // migration can honestly attest for a link older than this history
    // (D-363).
    expect([...REPOSITORY_CAPTURE_ATTACH_REASONS]).toEqual(["first_capture", "gate_preparation", "legacy_baseline"]);
    expect(REPOSITORY_CAPTURE_HISTORY_MAX).toBeGreaterThan(0);

    const revision: RepositoryLinkCaptureRevision = {
      revisionId: "rlc_1",
      linkId: "lnk_1",
      blobId: "blb_2",
      supersedesBlobId: "blb_1",
      supersedesRevisionId: "rlc_0",
      attachedAt: "2026-03-01T09:00:00.000Z",
      seq: 2,
      reason: "gate_preparation",
      gate: "Marking this task done",
      actor: { kind: "person", label: "You" },
    };
    expect(revision.supersedesBlobId, "a correction names what it replaced").toBe("blb_1");

    // An acceptance binds the capture it was taken against, so a later
    // correction of the link's pointer cannot become what a person looked at.
    const acceptance: RepositoryLinkAcceptance = {
      kind: "checkpoint_preview",
      confirmedAt: "2026-03-01T09:00:00.000Z",
      checkpointRef: "refs/x/checkpoints/s/1",
      commitObjectId: "a".repeat(40),
      subjectDigest: "b".repeat(64),
      acceptedBy: { kind: "person", label: "You" },
      captureBlobId: "blb_1",
    };
    expect(acceptance.captureBlobId).not.toBe(revision.blobId);
  });
});

describe("the search projection carries values only", () => {
  it("includes what a person typed and excludes blobs, digests and paths", () => {
    const design = sampleBodies.design;
    const values = searchableBodyValues(design).join("\n");
    expect(values).toContain("The review footer on a phone.");
    expect(values).toContain("Approve");
    expect(values).not.toContain("blb_");
    expect(values).not.toContain("ix_button");
    const research = searchableBodyValues(sampleBodies.research).join("\n");
    expect(research).toContain("Tailwind");
    expect(research).not.toContain("b".repeat(64));
    const task = searchableBodyValues(sampleBodies.task).join("\n");
    expect(task).toContain("sticky");
    expect(task).not.toContain("packages/ui/src/workspace");
  });
});
