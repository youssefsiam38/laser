/**
 * M21-T17: the worker bridge, as the host answers it.
 *
 * Everything here goes through `ProjectWorkMethods.handleBridge` with the
 * envelope a worker really sends, so what is exercised is the authority a
 * model tool meets: the project resolved from the directory the host spawned
 * that worker for, the wrong-project refusal, trust, the research rules
 * re-applied host-side, and the attempt record that outlives the session it
 * was made in.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCodes,
  PROJECT_WORK_CONFLICT_CODE,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkGetResult,
  type ProjectWorkWriteResult,
  type ProjectWorkWrongProject,
  type ResearchBody,
  type ResearchOperation,
} from "@lasercode/protocol";
import { ProtocolError } from "@lasercode/protocol";
import { projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import { specBody, taskBody } from "./fixtures.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Builder", sessionId: "ses_1", runId: "run_1" };

function bridge(harness: ProjectWorkHarness, request: ProjectWorkBridgeParams["request"], extras: Partial<ProjectWorkBridgeParams> = {}, cwd?: string): ProjectWorkBridgeResult {
  return harness.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd: cwd ?? harness.projectRoot });
}

function refusal(run: () => unknown): ProtocolError {
  try {
    run();
  } catch (error) {
    expect(error, "a refusal is a protocol error").toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
  }
  throw new Error("that call should have been refused");
}

function researchBody(): ResearchBody {
  return {
    question: "Which library reads PDFs?",
    scope: { in: ["Node libraries"], out: [], constraints: [] },
    status: "open",
    questions: [{ id: "q1", text: "Which ones are maintained?", state: "open", findings: [] }],
    findings: [],
    sources: [],
    unresolved: [],
  };
}

describe("the worker bridge", () => {
  it("resolves the project from the worker's own directory and records an agent, not a person", () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });
    const answer = bridge(h, {
      method: "project/work/create",
      params: { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "c1" },
    });
    expect(answer.projectId).toBe(h.projectId);
    const created = answer.result as ProjectWorkWriteResult;
    expect(created.revision.origin.actor.kind, "a worker call is an agent's, whatever it claims").toBe("agent");
    expect(created.revision.origin.actor.label).toBe("Builder");
    expect(created.revision.origin.sessionId).toBe("ses_1");
  });

  it("answers a list that names no project at all, because the host knows which one it is", () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });
    const answer = bridge(h, { method: "project/work/list", params: { cwd: h.projectRoot, limit: 1 } });
    expect((answer.result as { projectId: string }).projectId).toBe(h.projectId);
  });

  it("resolves a worktree to the project it belongs to", () => {
    h = projectWorkHarness();
    const worktree = join(h.projectRoot, ".worktrees", "feature");
    mkdirSync(worktree, { recursive: true });
    const answer = bridge(h, { method: "project/work/list", params: { cwd: worktree, limit: 1 } }, {}, worktree);
    expect(answer.projectId, "a worktree sees its parent project's work").toBe(h.projectId);
  });

  it("refuses a write aimed at another project by naming the owner and offering a session there", () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });
    const otherRoot = join(h.dir, "beta");
    const otherId = h.store.projectIdFor(otherRoot)!;
    const error = refusal(() =>
      bridge(h, {
        method: "project/work/create",
        params: { projectId: otherId, kind: "spec", title: "Elsewhere", body: specBody(), idempotencyKey: "x1" },
      }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(error.message).toContain("beta");
    expect(error.message).toContain("Open a session in beta");
    const data = error.data as ProjectWorkWrongProject;
    expect(data).toMatchObject({ refused: "wrong_project", owningProjectId: otherId, owningProjectName: "beta", offer: "open_session" });
  });

  it("lets a read of another project through, which is what a cross-project mention is", () => {
    h = projectWorkHarness();
    const otherRoot = join(h.dir, "beta");
    const otherId = h.store.projectIdFor(otherRoot)!;
    const created = h.store.create({
      projectId: otherId,
      kind: "spec",
      title: "Theirs",
      body: specBody(),
      origin: { actor: { kind: "person", label: "You" } },
      idempotencyKey: "b1",
    });
    const answer = bridge(h, {
      method: "project/work/get",
      params: { projectId: otherId, entityId: created.entity.entityId, body: { mode: "none" } },
    });
    expect((answer.result as ProjectWorkGetResult).entity.title).toBe("Theirs");
  });

  it("refuses every mutation in a folder a person declined", () => {
    h = projectWorkHarness({ trustOf: () => "declined" });
    const error = refusal(() =>
      bridge(h, {
        method: "project/work/create",
        params: { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "c1" },
      }),
    );
    expect(error.code).toBe(ErrorCodes.ProjectUntrusted);
  });

  it("refuses a stale write with the conflict a tool turns into its next call", () => {
    h = projectWorkHarness();
    const created = bridge(h, {
      method: "project/work/create",
      params: { projectId: h.projectId, kind: "spec", title: "Phone review", body: specBody(), idempotencyKey: "c1" },
    }).result as ProjectWorkWriteResult;
    const error = refusal(() =>
      bridge(h, {
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: created.entity.entityId,
          expectedRevisionId: "rev_nope",
          body: specBody("Changed"),
          idempotencyKey: "r1",
        },
      }),
    );
    expect(error.code).toBe(PROJECT_WORK_CONFLICT_CODE);
  });

  it("refuses an unknown method on the bridge rather than half-understanding it", () => {
    h = projectWorkHarness();
    const error = refusal(() => h.methods.handleBridge({ agent: AGENT, request: { method: "project/work/nope", params: {} } }, { actor: ACTOR, cwd: h.projectRoot }));
    expect(error.code).toBe(ErrorCodes.InvalidParams);
  });
});

describe("a research write, applied by the rule", () => {
  function seedResearch(harness: ProjectWorkHarness): ProjectWorkWriteResult {
    return harness.store.create({
      projectId: harness.projectId,
      kind: "research",
      title: "PDF libraries",
      body: { kind: "research", research: researchBody() },
      origin: { actor: { kind: "person", label: "You" } },
      idempotencyKey: "res1",
    });
  }

  it("stores what the applier returned, not the body the caller sent", () => {
    h = projectWorkHarness();
    const research = seedResearch(h);
    const operation: ResearchOperation = {
      op: "record_finding",
      questionId: "q1",
      claim: "pdf-text is MIT licensed.",
      confidence: "proposed",
      source: { kind: "web", id: "https://example.org/a", title: "A", fetchedVia: "web", trust: "unknown" },
      licence: "permissive",
    };
    const answer = bridge(
      h,
      {
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: research.entity.entityId,
          expectedRevisionId: research.revision.revisionId,
          // A body that would wipe the question tree. The host ignores it.
          body: { kind: "research", research: { ...researchBody(), questions: [] } },
          idempotencyKey: "w1",
        },
      },
      { research: operation },
    );
    expect(answer.researchResult?.staleRefs).toEqual([]);
    const read = h.store.get({ projectId: h.projectId, entityId: research.entity.entityId, body: { mode: "full" } });
    const stored = read.body?.body;
    expect(stored?.kind).toBe("research");
    if (stored?.kind !== "research") throw new Error("the stored body is not research");
    expect(stored.research.questions, "the applier's body is what was stored").toHaveLength(1);
    expect(stored.research.findings).toHaveLength(1);
    expect(stored.research.findings[0]?.claim).toBe("pdf-text is MIT licensed.");
  });

  it("refuses a confidence the rule cannot justify, and writes nothing", () => {
    h = projectWorkHarness();
    const research = seedResearch(h);
    const error = refusal(() =>
      bridge(
        h,
        {
          method: "project/work/revise",
          params: {
            projectId: h.projectId,
            entityId: research.entity.entityId,
            expectedRevisionId: research.revision.revisionId,
            body: { kind: "research", research: researchBody() },
            idempotencyKey: "w2",
          },
        },
        {
          research: {
            op: "record_finding",
            questionId: "q1",
            claim: "A blog says it is the best.",
            // `declared` needs an official or primary source and an excerpt.
            confidence: "declared",
            source: { kind: "web", id: "https://medium.example/post", title: "Post", fetchedVia: "web", trust: "unknown" },
            licence: "permissive",
          },
        },
      ),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect((error.data as { refused?: string }).refused).toBeTypeOf("string");
    expect((error.data as { next?: string }).next).toBeTypeOf("string");
    const read = h.store.get({ projectId: h.projectId, entityId: research.entity.entityId, body: { mode: "full" } });
    expect(read.entity.currentRevisionId, "a refused write leaves the revision where it was").toBe(research.revision.revisionId);
  });

  it("raises the attention item a question handed to a person needs", () => {
    h = projectWorkHarness();
    const research = seedResearch(h);
    const answer = bridge(
      h,
      {
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: research.entity.entityId,
          expectedRevisionId: research.revision.revisionId,
          body: { kind: "research", research: researchBody() },
          idempotencyKey: "w3",
        },
      },
      {
        research: {
          op: "resolve_question",
          questionId: "q1",
          state: "handed_to_person",
          wouldSettleIt: "Only the person can say which licence policy applies.",
        },
      },
    );
    expect(answer.researchResult?.attention).toMatchObject({ kind: "handed_to_person", questionId: "q1" });
  });

  it("refuses a research operation sent with anything but a revise", () => {
    h = projectWorkHarness();
    const research = seedResearch(h);
    const error = refusal(() =>
      bridge(
        h,
        { method: "project/work/get", params: { projectId: h.projectId, entityId: research.entity.entityId } },
        {
          research: {
            op: "resolve_question",
            questionId: "q1",
            state: "unanswerable",
            wouldSettleIt: "Nothing says which licence policy applies.",
          },
        },
      ),
    );
    expect(error.message).toContain("research operation");
  });
});

describe("an implementation attempt", () => {
  function seedTask(harness: ProjectWorkHarness): ProjectWorkWriteResult {
    return harness.store.create({
      projectId: harness.projectId,
      kind: "task",
      title: "Make the footer sticky",
      body: taskBody(),
      origin: { actor: { kind: "person", label: "You" } },
      idempotencyKey: "t1",
    });
  }

  it("records the session, the workspace shape, the checkout and the base commit", () => {
    h = projectWorkHarness();
    const task = seedTask(h);
    const checkout = join(h.projectRoot, ".worktrees", "feature");
    const answer = bridge(
      h,
      {
        method: "project/task/link-execution",
        params: {
          projectId: h.projectId,
          entityId: task.entity.entityId,
          expectedRevisionId: task.revision.revisionId,
          execution: { kind: "agent_run", targetId: "run_1", branch: "agents/feature", baseCommitObjectId: "abc1234", profileId: "prof_1" },
          idempotencyKey: "x1",
        },
      },
      { attempt: { workspace: "worktree", checkout } },
    );
    const linked = answer.result as ProjectTaskLinkExecutionResult;
    expect(linked.link.attempt).toBe(1);
    expect(linked.link.targetId).toBe("run_1");
    expect(linked.link.baseCommitObjectId).toBe("abc1234");
    const read = h.store.get({ projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" } });
    const shape = read.evidence.find((record) => record.summary.includes("Attempt 1"));
    expect(shape?.summary, "the attempt's shape is on the record").toContain("a worktree of its own");
    expect(shape?.detail, "the checkout is stored, and never returned to a model").toBe(checkout);
  });

  it("keeps the attempt, with its identity, after the session it ran in is gone", () => {
    h = projectWorkHarness();
    const task = seedTask(h);
    const sessionFile = join(h.dir, "sessions", "ses_gone.jsonl");
    mkdirSync(join(h.dir, "sessions"), { recursive: true });
    writeFileSync(sessionFile, "{}\n");
    bridge(
      h,
      {
        method: "project/task/link-execution",
        params: {
          projectId: h.projectId,
          entityId: task.entity.entityId,
          expectedRevisionId: task.revision.revisionId,
          execution: { kind: "session", targetId: "ses_gone" },
          idempotencyKey: "x2",
        },
      },
      { attempt: { workspace: "shared", checkout: h.projectRoot } },
    );
    // The session is deleted, as archiving or deleting a chat deletes it.
    rmSync(sessionFile, { force: true });
    const read = h.store.get({ projectId: h.projectId, entityId: task.entity.entityId, body: { mode: "none" } });
    expect(read.executionLinks, "the attempt survives the session it ran in").toHaveLength(1);
    expect(read.executionLinks[0]).toMatchObject({ kind: "session", targetId: "ses_gone", attempt: 1 });
  });

  it("records evidence when an attempt ends, and never moves the task", () => {
    h = projectWorkHarness();
    const task = seedTask(h);
    bridge(h, {
      method: "project/task/link-execution",
      params: {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "agent_run", targetId: "run_2" },
        idempotencyKey: "x3",
      },
    });
    const ended = bridge(h, {
      method: "project/task/link-execution",
      params: {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: task.revision.revisionId,
        execution: { kind: "agent_run", targetId: "run_2", attempt: 1, endedAt: new Date().toISOString(), outcome: "completed" },
        idempotencyKey: "x4",
      },
    }).result as ProjectTaskLinkExecutionResult;
    expect(ended.entity.state, "a run ending is evidence, never a state change").toBe(task.entity.state);
  });
});
