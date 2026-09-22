/**
 * M21-T24 · the project lifecycle, end to end, as stories rather than units.
 *
 * Every other suite in this directory proves one rule of one task. This one
 * runs the six lifecycles the leap's acceptance names and asserts the
 * contract each of them is supposed to keep — not that nothing threw:
 *
 * 1. an established React project through the whole ladder (Spec → Research →
 *    Design → Plan → Task → attempt with checkpoints → verification →
 *    `needs_review` → the person's completion), with the Work, Board and
 *    Needs-you lists answering with keyed, badged entities;
 * 2. an established non-React project through the same ladder, with a Design
 *    that names the project's real templates and invents no components;
 * 3. a greenfield project whose foundation is proposed, approved and planned
 *    **without one byte changing in the repository** before Build;
 * 4. a backend-only Spec that skips Design with a recorded reason and whose
 *    verification carries no visual criterion at all;
 * 5. a Design revised while a build is running: only the reachable graph goes
 *    stale, only the Tasks under it pause, and the unaffected Task still
 *    converges;
 * 6. one Spec created in one conversation, revised in a second, executed in a
 *    third and read back after the host restarts over the same file;
 * 7. a session in project P reading project Q's Spec, and being refused a
 *    mutation with Q named.
 *
 * Everything is the real thing: the real store on a real file, the real
 * Router a person's app talks to, the real bridge a model's tools talk
 * through, and real git repositories in temp directories. No model runs: the
 * agent side is entered exactly as the worker enters it (`source: "worker"`),
 * which is how an agent's write stays an agent's write.
 *
 * What this file does **not** prove is named in `docs/leap/m21-acceptance.md`:
 * the Design Index build, the Sketch→Tree ladder and the mention context a
 * model reads live in the worker (`packages/worker/test/project-work/
 * lifecycle.e2e.test.ts`), the four commands live in the UI
 * (`packages/ui/test/project-work/lifecycle-commands.e2e.test.ts`), and every
 * visual matrix is the person's (D-342).
 */
import {
  PRODUCT_NAME,
  PROJECT_DIR_NAME,
  checkpointRef,
  type ApprovedRevision,
  type ExecutionLink,
  type GateReport,
  type ProjectTaskLinkExecutionResult,
  type ProjectWorkAttentionNotification,
  type ProjectWorkBody,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkEntity,
  type ProjectWorkEvidence,
  type ProjectWorkGetResult,
  type ProjectWorkListResult,
  type ProjectWorkWriteResult,
  type ProjectWorkWrongProject,
  type ResearchBody,
  type ResearchOperation,
  type TaskReadiness,
  type VerificationCommandRun,
  type VerificationPlan,
} from "@lasercode/protocol";
import { checkpointSessionKey } from "@lasercode/protocol/checkpoint-key";
import { ProtocolError } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failed, ok, projectWorkHarness, type ProjectWorkHarness } from "./harness.js";
import type { ProjectWorkDetail } from "../../src/project-work/store.js";
import { checkpoint, git, haveGit, head, initRepo, write } from "./git-fixtures.js";

let h: ProjectWorkHarness;
const dirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Builder", sessionId: "ses_build", runId: "run_1" };
/** Three conversations: the id is provenance, the path is where it lives. */
const SESSION_A = { id: "ses_a", path: "/sessions/ses_a.jsonl" };
const SESSION_B = { id: "ses_b", path: "/sessions/ses_b.jsonl" };
const SESSION_C = { id: "ses_c", path: "/sessions/ses_c.jsonl" };

let keys = 0;
const idem = (): string => `e2e-${String((keys += 1))}`;

function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A host whose one project folder really exists, with one real repository. */
function project(label: string, contents: Record<string, string>): { root: string; repo: string } {
  const dir = temp(label);
  h = projectWorkHarness({ dir });
  const root = h.projectRoot;
  mkdirSync(root, { recursive: true });
  const repo = join(root, "app");
  initRepo(repo, contents);
  return { root, repo };
}

// --------------------------------------------------------------------- calls

async function create(kind: ProjectWorkBody["kind"], title: string, body: ProjectWorkBody, sessionId?: string): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", {
      projectId: h.projectId,
      kind,
      title,
      body,
      ...(sessionId ? { origin: { actor: { kind: "person", label: "You" }, sessionId } } : {}),
      idempotencyKey: idem(),
    }),
  );
}

async function revise(entity: ProjectWorkEntity, body: ProjectWorkBody, sessionId?: string): Promise<ProjectWorkWriteResult> {
  return ok<ProjectWorkWriteResult>(
    await h.call("project/work/revise", {
      projectId: h.projectId,
      entityId: entity.entityId,
      expectedRevisionId: entity.currentRevisionId,
      body,
      ...(sessionId ? { origin: { actor: { kind: "person", label: "You" }, sessionId } } : {}),
      idempotencyKey: idem(),
    }),
  );
}

type Detail = ProjectWorkDetail & { readiness?: TaskReadiness; gates?: GateReport };

async function detail(entityId: string): Promise<Detail> {
  return ok<Detail>(
    await h.call("project/work/get", {
      projectId: h.projectId,
      entityId,
      include: { links: true, evidence: true, approvals: true },
    }),
  );
}

async function entityNow(entityId: string): Promise<ProjectWorkEntity> {
  return (await detail(entityId)).entity;
}

async function edge(relation: string, subject: ProjectWorkEntity, object: ProjectWorkEntity): Promise<string> {
  const written = ok<{ link: { edge: { linkId: string } } }>(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: subject.currentRevisionId,
      link: {
        type: "edge",
        relation,
        subject: { entityId: subject.entityId, revisionId: subject.currentRevisionId },
        object: { entityId: object.entityId, revisionId: object.currentRevisionId },
      },
      idempotencyKey: idem(),
    }),
  );
  return written.link.edge.linkId;
}

const coverNow = (entity: ProjectWorkEntity): ApprovedRevision => ({
  entityId: entity.entityId,
  kind: entity.kind,
  key: entity.key,
  revisionId: entity.currentRevisionId,
  digest: entity.currentDigest,
});

/** The spine has no `draft → approved` edge: a decision is asked for first. */
async function requestReview(entityId: string): Promise<ProjectWorkEntity> {
  const entity = await entityNow(entityId);
  if (entity.state !== "draft") return entity;
  ok(
    await h.call("project/work/review", {
      projectId: h.projectId,
      entityId,
      expectedRevisionId: entity.currentRevisionId,
      action: "request_review",
      idempotencyKey: idem(),
    }),
  );
  return entityNow(entityId);
}

async function approveGate(
  entityId: string,
  gate: "brief" | "design" | "build",
  extras: { covers?: ApprovedRevision[]; skipReason?: string; mode?: string } = {},
): Promise<ProjectWorkEntity> {
  const entity = await requestReview(entityId);
  ok(
    await h.call("project/work/approve", {
      projectId: h.projectId,
      entityId,
      expectedRevisionId: entity.currentRevisionId,
      gate,
      decision: "approved",
      covers: extras.covers ?? [coverNow(entity)],
      ...(extras.skipReason ? { skipReason: extras.skipReason } : {}),
      ...(extras.mode ? { mode: extras.mode } : {}),
      idempotencyKey: idem(),
    }),
  );
  return entityNow(entityId);
}

interface ActionResult {
  entity: ProjectWorkEntity;
  transition: { from: string; to: string };
  readiness?: TaskReadiness;
}

async function act(entityId: string, action: string, extra: { note?: string; evidenceId?: string } = {}): Promise<ActionResult> {
  const entity = await entityNow(entityId);
  return ok<ActionResult>(
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId,
      expectedRevisionId: entity.currentRevisionId,
      action,
      ...extra,
      idempotencyKey: idem(),
    }),
  );
}

async function actRefusal(entityId: string, action: string): Promise<{ code: number; message: string; data?: unknown }> {
  const entity = await entityNow(entityId);
  return failed(
    await h.call("project/task/action", {
      projectId: h.projectId,
      entityId,
      expectedRevisionId: entity.currentRevisionId,
      action,
      idempotencyKey: idem(),
    }),
  );
}

async function bridge(
  request: ProjectWorkBridgeParams["request"],
  extras: Partial<ProjectWorkBridgeParams> = {},
  cwd = h.projectRoot,
): Promise<ProjectWorkBridgeResult> {
  return h.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd });
}

async function bridgeRefusal(run: () => unknown): Promise<ProtocolError> {
  try {
    await run();
  } catch (error) {
    expect(error, "a refusal is a protocol error").toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
  }
  throw new Error("that call should have been refused");
}

/** What the host says a Task owes, derived from its own authorities. */
async function verificationPlan(entityId: string): Promise<VerificationPlan> {
  const answer = await bridge(
    { method: "project/work/get", params: { projectId: h.projectId, entityId, body: { mode: "none" } } },
    { verify: { action: "plan" } },
  );
  if (!answer.verifyResult?.plan) throw new Error("the host answered no verification plan");
  return answer.verifyResult.plan;
}

function commandRun(command: string, passed: boolean): VerificationCommandRun {
  return {
    command,
    status: passed ? "passed" : "failed",
    exitCode: passed ? 0 : 1,
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:01:00.000Z",
    outputBytes: 4,
    outputDigest: "b".repeat(64),
    tail: passed ? "ok\n" : "1 failing\n",
  };
}

/** Report one verification run, exactly as the verifier Command does. */
async function verificationReport(task: ProjectWorkEntity, commands: VerificationCommandRun[], runId = "ver_0001"): Promise<ProjectWorkBridgeResult> {
  return bridge(
    {
      method: "project/work/link",
      params: {
        projectId: h.projectId,
        expectedRevisionId: task.currentRevisionId,
        link: {
          type: "evidence",
          entityId: task.entityId,
          revisionId: task.currentRevisionId,
          kind: "verification",
          role: "supporting",
          summary: "Verification",
          outcome: "inconclusive",
        },
        idempotencyKey: idem(),
      },
    },
    { verify: { action: "report", runId, startedAt: "2026-03-01T09:00:00.000Z", endedAt: "2026-03-01T09:05:00.000Z", commands } },
  );
}

async function acceptanceEvidence(entity: ProjectWorkEntity, summary: string): Promise<ProjectWorkEvidence> {
  const written = ok<{ link: { evidence: ProjectWorkEvidence } }>(
    await h.call("project/work/link", {
      projectId: h.projectId,
      expectedRevisionId: entity.currentRevisionId,
      link: {
        type: "evidence",
        entityId: entity.entityId,
        revisionId: entity.currentRevisionId,
        kind: "test",
        role: "acceptance",
        summary,
        outcome: "passed",
      },
      idempotencyKey: idem(),
    }),
  );
  return written.link.evidence;
}

async function startAttempt(task: ProjectWorkEntity, targetId: string, sessionPath: string): Promise<ProjectTaskLinkExecutionResult> {
  return ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entityId,
      expectedRevisionId: task.currentRevisionId,
      execution: { kind: "agent_run", targetId, sessionPath },
      idempotencyKey: `start-${targetId}`,
    }),
  );
}

async function endAttempt(task: ProjectWorkEntity, targetId: string, sessionPath: string): Promise<ProjectTaskLinkExecutionResult> {
  return ok<ProjectTaskLinkExecutionResult>(
    await h.call("project/task/link-execution", {
      projectId: h.projectId,
      entityId: task.entityId,
      expectedRevisionId: task.currentRevisionId,
      execution: { kind: "agent_run", targetId, outcome: "completed", sessionPath },
      idempotencyKey: `end-${targetId}`,
    }),
  );
}

/** The three lists the workspace draws, straight from the authority. */
async function workList(kinds?: string[]): Promise<ProjectWorkListResult> {
  return ok<ProjectWorkListResult>(
    await h.call("project/work/list", { projectId: h.projectId, ...(kinds ? { kinds } : {}) }),
  );
}

const needsYou = (): ProjectWorkAttentionNotification => h.methods.attention(h.projectId);

// -------------------------------------------------------------------- bodies

function specBody(options: { form?: "brief" | "full"; gated?: boolean; brief?: string; acceptance?: Array<{ id: string; text: string; machineVerifiable: boolean }> } = {}): ProjectWorkBody {
  return {
    kind: "spec",
    spec: {
      form: options.form ?? "brief",
      brief: options.brief ?? "People cannot see why an export failed.",
      outcomes: ["Nobody opens a log to find out why an export failed."],
      nonGoals: [],
      requirements: [{ id: "r1", text: "The reason never names an internal path.", level: "must" }],
      acceptance: options.acceptance ?? [{ id: "a1", text: "A failed export row shows the reason.", machineVerifiable: true }],
      constraints: [],
      ...(options.gated === undefined ? {} : { gated: options.gated }),
    },
  };
}

function researchBody(question: string): ProjectWorkBody {
  const research: ResearchBody = {
    question,
    scope: { in: ["This project's own code"], out: [], constraints: [] },
    status: "open",
    questions: [
      { id: "q1", text: question, state: "open", findings: [] },
      { id: "q2", text: "Which failures are permanent?", state: "open", findings: [] },
    ],
    findings: [],
    sources: [],
    unresolved: [],
  };
  return { kind: "research", research };
}

/**
 * A Design drawn against a reviewed index: every node is Mapped, the profile
 * digest is present (the design gate needs one) and the host page names the
 * project's own files.
 */
function designBody(options: { hostPath: string; component: string; templatePath?: string; brief?: string }): ProjectWorkBody {
  return {
    kind: "design",
    design: {
      brief: options.brief ?? "The failed-export row: the reason, and the one action that fixes it.",
      designIndexRef: { indexId: "ix1", revisionId: "rev_ix1", profileDigest: "b".repeat(64) },
      screens: [
        {
          id: "s1",
          name: "Export list",
          content: {
            tree: {
              rootNodeId: "n1",
              nodes: [
                {
                  id: "n1",
                  component: { primitive: "stack" },
                  fidelity: "mapped",
                  props: { tone: { type: "token", tokenId: "color.surface" } },
                  children: ["n2"],
                },
                { id: "n2", component: { indexEntryId: options.component }, fidelity: "mapped", props: {}, children: [] },
              ],
            },
          },
          states: [
            { name: "failed", included: true },
            { name: "empty", included: false, skipReason: "the list is never empty here" },
          ],
          fidelity: "mapped",
        },
      ],
      flows: [],
      sketches: [],
      hostPage: {
        routeOrPath: options.hostPath,
        outline: [{ id: "o1", role: "region", label: "Export list", depth: 1 }],
        files: [options.templatePath ?? options.hostPath],
        fidelity: "mapped",
      },
      fidelity: "mapped",
      fixtures: [],
    },
  };
}

function planBody(taskKeys: string[], options: { verification?: string[]; brief?: string } = {}): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief: options.brief ?? "Ship the export reasons.",
      phases: [{ id: "p1", name: "Build", taskKeys }],
      dependencies: [],
      boundaries: [{ scope: "security", rule: "A reason never carries a credential." }],
      migrations: [],
      risks: [],
      verification: options.verification ?? ["pnpm -F exports test"],
    },
  };
}

function taskBody(options: { outcome?: string; commands?: string[]; planKey?: string; paths?: string[]; visual?: boolean } = {}): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: options.outcome ?? "The export list shows why a failed export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: options.paths ?? ["src/exports/list.ts"], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed export row shows the reason.", machineVerifiable: true, command: options.commands?.[0] ?? "pnpm -F exports test" }],
      verificationCommands: options.commands ?? ["pnpm -F exports test"],
      visualEvidenceRequired: options.visual ?? false,
      assignment: { policy: "agent", agentName: "worker" },
      ...(options.planKey ? { planKey: options.planKey } : {}),
    },
  };
}

// ===========================================================================
// 1 · an established React project, the whole ladder
// ===========================================================================

const REACT_PROJECT = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { react: "19.0.0", "react-dom": "19.0.0" } }, null, 2),
  "src/exports/list.tsx": "export function ExportList() { return null; }\n",
  "src/tokens.css": ":root { --color-surface: #ffffff; }\n",
};

const NODE_PROJECT = {
  "package.json": JSON.stringify({ name: "relay", dependencies: { fastify: "5.0.0" } }, null, 2),
  "src/exports/list.ts": "export const renderExports = () => '';\n",
  "src/templates/exports.njk": "<main><section>{{ rows }}</section></main>\n",
};

describe.runIf(haveGit)("1 · an established React project goes the whole way", () => {
  it("runs Spec → Research → Design → Plan → Task → attempt → verify → needs_review → done, keyed all the way", async () => {
    const { repo } = project("lifecycle-react", REACT_PROJECT);

    // --- Spec, through the brief gate -------------------------------------
    const spec = await create("spec", "Exports say why", specBody({ gated: true }), SESSION_A.id);
    expect(spec.entity.key, "the first entity of its kind gets the first key").toBe("SPEC-1");
    const approvedSpec = await approveGate(spec.entity.entityId, "brief");
    expect(approvedSpec.state).toBe("approved");

    // --- Research: standalone, from the same chat, resolved by citation ----
    const research = await create("research", "Why do exports fail?", researchBody("Which export failures are recoverable?"), SESSION_A.id);
    expect(research.entity.key).toBe("RES-1");
    const declared: ResearchOperation = {
      op: "record_finding",
      questionId: "q1",
      claim: "A 429 from the provider is retried by the exporter.",
      confidence: "declared",
      source: { kind: "web", id: "https://exporter.example/docs/retries", title: "Retries", fetchedVia: "web", trust: "official" },
      excerpt: "Requests answered with 429 are retried three times.",
      licence: "permissive",
    };
    const recorded = await bridge(
      {
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: research.entity.entityId,
          expectedRevisionId: research.revision.revisionId,
          // The body a tool sends is ignored: the rule applies the operation.
          body: researchBody("Which export failures are recoverable?"),
          idempotencyKey: idem(),
        },
      },
      { research: declared },
    );
    const afterRecord = h.store.get({ projectId: h.projectId, entityId: research.entity.entityId, body: { mode: "full" } }).body?.body;
    if (afterRecord?.kind !== "research") throw new Error("the stored body is not research");
    const findingId = afterRecord.research.findings[0]?.id;
    expect(findingId, "the host minted the finding's id, and stored the claim under it").toBeTypeOf("string");
    expect(afterRecord.research.findings[0]?.confidence, "the rule allowed declared: an official source, quoted").toBe("declared");

    // The second question has nothing under it, so answering it is a claim
    // with no evidence: refused by the rule, not by the model's judgement.
    const uncited = await bridgeRefusal(() =>
      bridge(
        {
          method: "project/work/revise",
          params: {
            projectId: h.projectId,
            entityId: research.entity.entityId,
            expectedRevisionId: (recorded.result as ProjectWorkWriteResult).revision.revisionId,
            body: researchBody("Which export failures are recoverable?"),
            idempotencyKey: idem(),
          },
        },
        { research: { op: "resolve_question", questionId: "q2", state: "answered", answer: "They are all recoverable." } },
      ),
    );
    expect(uncited.message, "an answered question cites a finding").toContain("cites at least one declared or observed finding");

    const answered = await bridge(
      {
        method: "project/work/revise",
        params: {
          projectId: h.projectId,
          entityId: research.entity.entityId,
          expectedRevisionId: (recorded.result as ProjectWorkWriteResult).revision.revisionId,
          body: researchBody("Which export failures are recoverable?"),
          idempotencyKey: idem(),
        },
      },
      { research: { op: "resolve_question", questionId: "q1", state: "answered", answer: "Rate-limit failures are recoverable.", findings: [findingId!] } },
    );
    const answeredBody = (
      h.store.get({ projectId: h.projectId, entityId: research.entity.entityId, body: { mode: "full" } }).body?.body
    );
    if (answeredBody?.kind !== "research") throw new Error("the stored body is not research");
    expect(answeredBody.research.questions[0]?.state, "the question the citation settled").toBe("answered");
    expect(answeredBody.research.status, "derived from its questions, never claimed: one of two is settled").toBe("open");
    expect(answeredBody.research.findings[0]?.source.id).toBe("https://exporter.example/docs/retries");
    expect(answeredBody.research.questions[0]?.findings).toEqual([findingId]);
    void answered;

    // --- The full Spec, before anything is drawn against it ---------------
    // The order is the contract's, not a convenience: a material change to an
    // approved Spec stales the Design that implements it and invalidates the
    // design gate, so the full revision is agreed before the Design is drawn.
    await revise(await entityNow(spec.entity.entityId), specBody({ gated: true, form: "full" }));
    await approveGate(spec.entity.entityId, "brief");

    // --- Design, through the design gate ----------------------------------
    const design = await create("design", "Export row", designBody({ hostPath: "/exports", component: "ix_row", templatePath: "src/exports/list.tsx" }), SESSION_A.id);
    expect(design.entity.key).toBe("DES-1");
    await edge("implements", design.entity, (await entityNow(spec.entity.entityId)));
    const approvedDesign = await approveGate(design.entity.entityId, "design");
    expect(approvedDesign.state).toBe("approved");

    // --- Plan and its Task ------------------------------------------------
    const task = await create("task", "Failed rows say why", taskBody(), SESSION_A.id);
    expect(task.entity.key).toBe("TASK-1");
    const plan = await create("plan", "Export reasons", planBody([task.entity.key]), SESSION_A.id);
    expect(plan.entity.key).toBe("PLAN-1");
    const replanned = await revise(task.entity, taskBody({ planKey: plan.entity.key }));
    await edge("implements", replanned.entity, await entityNow(spec.entity.entityId));
    await edge("implements", await entityNow(task.entity.entityId), await entityNow(design.entity.entityId));
    await edge("depends_on", await entityNow(plan.entity.entityId), await entityNow(spec.entity.entityId));

    // The build gate, over the exact revisions it covers.
    await requestReview(plan.entity.entityId);
    const gates = (await detail(plan.entity.entityId)).gates;
    const build = gates?.gates.find((row: { gate: string }) => row.gate === "build");
    expect(build?.state, `the build gate is ready: ${build?.refusal ?? ""}`).toBe("ready");
    await approveGate(plan.entity.entityId, "build", { covers: build!.covers.slice(), mode: "manual_tool_review" });

    // --- The three lists a person reads -----------------------------------
    const backlog = await workList();
    expect(backlog.items.map((row) => `${row.kind}:${row.key}`).sort()).toEqual(
      ["design:DES-1", "plan:PLAN-1", "research:RES-1", "spec:SPEC-1", "task:TASK-1"].sort(),
    );
    expect(backlog.counts.byKind, "the type badge's own counts").toMatchObject({ spec: 1, research: 1, design: 1, plan: 1, task: 1 });
    const board = await workList(["task"]);
    expect(board.items.map((row) => [row.key, row.state])).toEqual([["TASK-1", "draft"]]);

    // --- The attempt ------------------------------------------------------
    await act(task.entity.entityId, "mark_ready");
    const started = await act(task.entity.entityId, "start");
    expect(started.transition).toEqual({ from: "ready", to: "in_progress" });
    const base = head(repo);
    await startAttempt(await entityNow(task.entity.entityId), "run_1", SESSION_A.path);
    write(repo, { "src/exports/list.tsx": "export function ExportList() { return 'reason'; }\n" });
    const checkpointCommit = checkpoint(repo, SESSION_A.path, 1);
    const ended = await endAttempt(await entityNow(task.entity.entityId), "run_1", SESSION_A.path);
    const attemptRepo = (ended.link as ExecutionLink).repositories?.find((row) => row.name === "app");
    expect(attemptRepo?.base.commitObjectId, "the attempt recorded the base git really had").toBe(base);
    expect(attemptRepo?.checkpoints?.map((row) => row.commitObjectId)).toContain(checkpointCommit);
    expect(attemptRepo?.checkpoints?.[0]?.ref, "the ref git really holds, by this conversation's key").toBe(checkpointRef(checkpointSessionKey(SESSION_A.path), 1));
    expect(attemptRepo?.checkpoints?.[0]?.turn).toBe(1);

    // --- Verification -----------------------------------------------------
    const owed = await verificationPlan(task.entity.entityId);
    expect(owed.authorities.map((row) => row.authority).sort()).toEqual(["design", "plan", "spec", "task"]);
    expect(owed.criteria.some((row) => row.kind === "design_state"), "an included screen state is owed").toBe(true);
    expect(owed.criteria.some((row) => row.text.includes("empty state")), "a skipped state is not owed").toBe(false);
    const verified = await verificationReport(await entityNow(task.entity.entityId), [commandRun("pnpm -F exports test", true)]);
    expect(verified.verifyResult?.report?.converged).toBe(true);
    expect(verified.verifyResult?.taskState, "a passing run reaches needs_review and never done").toBe("needs_review");

    // --- The person, and only the person, completes it --------------------
    const needing = needsYou();
    expect(needing.items.map((row) => row.key)).toContain("TASK-1");
    await acceptanceEvidence(await entityNow(task.entity.entityId), "pnpm -F exports test");
    const done = await act(task.entity.entityId, "complete");
    expect(done.entity.state).toBe("done");
    expect(h.workerAttempts(), "the whole lifecycle was answered without a worker").toBe(0);
  });
});

// ===========================================================================
// 2 · an established non-React project
// ===========================================================================

describe.runIf(haveGit)("2 · an established non-React project runs the same ladder", () => {
  it("keeps the Design on the project's real templates and invents no component", async () => {
    const { repo } = project("lifecycle-node", NODE_PROJECT);

    const spec = await create("spec", "Exports say why", specBody({ gated: true }));
    await approveGate(spec.entity.entityId, "brief");
    await revise(await entityNow(spec.entity.entityId), specBody({ gated: true, form: "full" }));
    await approveGate(spec.entity.entityId, "brief");

    // The host page is the project's own Nunjucks template, and the one
    // component node names an index entry rather than a React import.
    const design = await create(
      "design",
      "Export row",
      designBody({ hostPath: "/exports", component: "ix_partial_row", templatePath: "src/templates/exports.njk" }),
    );
    await edge("implements", design.entity, await entityNow(spec.entity.entityId));
    await approveGate(design.entity.entityId, "design");
    const storedDesign = h.store.get({ projectId: h.projectId, entityId: design.entity.entityId, body: { mode: "full" } }).body?.body;
    if (storedDesign?.kind !== "design") throw new Error("the stored body is not a design");
    expect(storedDesign.design.hostPage?.files).toEqual(["src/templates/exports.njk"]);
    // Nothing in the stored design claims a framework the project does not
    // ship: the honest stack is the index's (worker), and this body carries
    // no React import, no JSX and no invented component name.
    expect(JSON.stringify(storedDesign)).not.toMatch(/react|jsx|tsx/i);

    const task = await create("task", "Failed rows say why", taskBody({ paths: ["src/templates/exports.njk"] }));
    const plan = await create("plan", "Export reasons", planBody([task.entity.key]));
    await revise(task.entity, taskBody({ planKey: plan.entity.key, paths: ["src/templates/exports.njk"] }));
    await edge("implements", await entityNow(task.entity.entityId), await entityNow(spec.entity.entityId));
    await edge("implements", await entityNow(task.entity.entityId), await entityNow(design.entity.entityId));
    await edge("depends_on", await entityNow(plan.entity.entityId), await entityNow(spec.entity.entityId));
    await requestReview(plan.entity.entityId);
    const build = (await detail(plan.entity.entityId)).gates?.gates.find((row) => row.gate === "build");
    expect(build?.state, build?.refusal ?? "").toBe("ready");
    await approveGate(plan.entity.entityId, "build", { covers: build!.covers.slice(), mode: "autonomous" });

    await act(task.entity.entityId, "mark_ready");
    await act(task.entity.entityId, "start");
    await startAttempt(await entityNow(task.entity.entityId), "run_1", SESSION_A.path);
    write(repo, { "src/templates/exports.njk": "<main><section>{{ rows }}{{ reason }}</section></main>\n" });
    checkpoint(repo, SESSION_A.path, 1);
    await endAttempt(await entityNow(task.entity.entityId), "run_1", SESSION_A.path);

    const verified = await verificationReport(await entityNow(task.entity.entityId), [commandRun("pnpm -F exports test", true)]);
    expect(verified.verifyResult?.report?.blockers).toEqual([]);
    expect(verified.verifyResult?.taskState).toBe("needs_review");
    await acceptanceEvidence(await entityNow(task.entity.entityId), "pnpm -F exports test");
    expect((await act(task.entity.entityId, "complete")).entity.state).toBe("done");
  });
});

// ===========================================================================
// 3 · a greenfield project
// ===========================================================================

describe.runIf(haveGit)("3 · a greenfield project approves a foundation before any source exists", () => {
  it("proposes tokens and component contracts, changes nothing in the repository, and waits for an explicit Start", async () => {
    // Greenfield: the project folder *is* the repository, and it holds one
    // README. Anything the app writes into it while designing shows up here.
    const dir = temp("lifecycle-greenfield");
    h = projectWorkHarness({ dir });
    const repo = h.projectRoot;
    mkdirSync(repo, { recursive: true });
    initRepo(repo, { "README.md": "# new\n", ".gitignore": `${PROJECT_DIR_NAME}/\n` });
    const snapshot = (): { head: string; files: string[]; status: string } => ({
      head: head(repo),
      files: readdirSync(repo).sort(),
      status: git(repo, ["status", "--porcelain"]),
    });
    const before = snapshot();
    expect(before.status, "a clean checkout to start from").toBe("");

    const design = await create("design", "Foundation", {
      kind: "design",
      design: {
        brief: "A foundation for a reading app.",
        designIndexRef: { indexId: "ix1", revisionId: "rev_ix1", profileDigest: "c".repeat(64) },
        foundation: {
          principles: ["One colour carries meaning.", "Nothing below 12px."],
          status: "proposed",
          steps: [
            { id: "principles", state: "accepted", source: "person" },
            { id: "primitive_tokens", state: "proposed", source: "model", model: "smart-1" },
            { id: "component_contracts", state: "proposed", source: "model", model: "smart-1" },
          ],
          tokens: { color: { bg: { $type: "color", $value: "#ffffff" }, ink: { $type: "color", $value: "#111111" } } },
        },
        screens: [],
        flows: [],
        sketches: [],
        fidelity: "proposed",
        fixtures: [],
      },
    });
    const stored = h.store.get({ projectId: h.projectId, entityId: design.entity.entityId, body: { mode: "full" } }).body?.body;
    if (stored?.kind !== "design") throw new Error("the stored body is not a design");
    expect(stored.design.fidelity, "nothing greenfield is Mapped: there is nothing to map to").toBe("proposed");
    expect(Object.keys(stored.design.foundation?.tokens?.["color"] ?? {})).toEqual(["bg", "ink"]);

    const approved = await approveGate(design.entity.entityId, "design");
    expect(approved.state).toBe("approved");

    const task = await create("task", "Implement the foundation", taskBody({ outcome: "The token file exists.", paths: ["src/tokens.css"] }));
    const plan = await create("plan", "Foundation first", planBody([task.entity.key]));
    await revise(task.entity, taskBody({ outcome: "The token file exists.", paths: ["src/tokens.css"], planKey: plan.entity.key }));

    // The whole design phase is over and the repository has not moved: no
    // commit, and nothing git can see (leap, "Canonical persistence" — the
    // app never writes lifecycle drafts into the repository). The one thing
    // on disk that was not there before is its own project marker, which is
    // ignored and holds an identity, not a draft.
    const after = snapshot();
    expect(after.head, "no commit was made for anybody").toBe(before.head);
    expect(after.status, "and nothing git can see changed").toBe("");
    expect(after.files.filter((name) => !before.files.includes(name))).toEqual([PROJECT_DIR_NAME]);
    expect(readdirSync(join(repo, PROJECT_DIR_NAME))).toEqual(["project.json"]);
    expect(readdirSync(repo).some((name) => name.endsWith(".css") || name === "src"), "no source was written").toBe(false);

    // Build starts when a person starts it, and not before: a Task that is
    // merely ready has no attempt, and `start` is its own transition.
    await act(task.entity.entityId, "mark_ready");
    expect((await detail(task.entity.entityId)).executionLinks ?? []).toHaveLength(0);
    const started = await act(task.entity.entityId, "start");
    expect(started.transition).toEqual({ from: "ready", to: "in_progress" });
    await startAttempt(await entityNow(task.entity.entityId), "run_1", SESSION_A.path);
    expect((await detail(task.entity.entityId)).executionLinks?.length, "an attempt exists only after the explicit start").toBe(1);
  });
});

// ===========================================================================
// 4 · a backend-only Spec skips Design
// ===========================================================================

describe("4 · a backend-only Spec skips Design and converges on commands alone", () => {
  it("records why there is no design, owes no visual criterion, and reaches needs_review", async () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });

    const spec = await create("spec", "Rate limit the relay", specBody({ gated: true, brief: "One channel can flood the relay." }));
    await approveGate(spec.entity.entityId, "brief");
    await revise(await entityNow(spec.entity.entityId), specBody({ gated: true, form: "full", brief: "One channel can flood the relay." }));
    await approveGate(spec.entity.entityId, "brief");

    const skipped = ok<{ approval: { skipReason?: string } }>(
      await h.call("project/work/approve", {
        projectId: h.projectId,
        entityId: spec.entity.entityId,
        expectedRevisionId: (await entityNow(spec.entity.entityId)).currentRevisionId,
        gate: "design",
        decision: "approved",
        covers: [coverNow(await entityNow(spec.entity.entityId))],
        skipReason: "No interface changes: this is a relay rate limit.",
        idempotencyKey: idem(),
      }),
    );
    expect(skipped.approval.skipReason).toContain("No interface changes");

    const task = await create("task", "Bucket per channel", taskBody({ outcome: "One channel cannot flood another.", commands: ["pnpm -F relay test"] }));
    const plan = await create("plan", "Relay limits", planBody([task.entity.key], { verification: ["pnpm -F relay test"] }));
    await revise(task.entity, taskBody({ outcome: "One channel cannot flood another.", commands: ["pnpm -F relay test"], planKey: plan.entity.key }));
    await edge("implements", await entityNow(task.entity.entityId), await entityNow(spec.entity.entityId));
    await edge("depends_on", await entityNow(plan.entity.entityId), await entityNow(spec.entity.entityId));

    await requestReview(plan.entity.entityId);
    const build = (await detail(plan.entity.entityId)).gates?.gates.find((row) => row.gate === "build");
    expect(build?.requirements.find((row) => row.role === "design_skip")?.satisfied, build?.refusal ?? "").toBe(true);
    await approveGate(plan.entity.entityId, "build", { covers: build!.covers.slice(), mode: "autonomous" });

    await act(task.entity.entityId, "mark_ready");
    await act(task.entity.entityId, "start");

    const owed = await verificationPlan(task.entity.entityId);
    expect(owed.authorities.map((row) => row.authority).sort(), "three authorities, because there is no Design").toEqual(["plan", "spec", "task"]);
    expect(owed.criteria.filter((row) => row.kind === "design_state" || row.kind === "design_token" || row.kind === "browser_matrix")).toEqual([]);
    expect(owed.criteria.every((row) => row.kind !== "visual")).toBe(true);

    const verified = await verificationReport(await entityNow(task.entity.entityId), [commandRun("pnpm -F relay test", true)]);
    expect(verified.verifyResult?.report?.blockers, "commands alone are enough when nothing visual is owed").toEqual([]);
    expect(verified.verifyResult?.report?.converged).toBe(true);
    expect(verified.verifyResult?.taskState).toBe("needs_review");
  });
});

// ===========================================================================
// 5 · a Design revised during Build
// ===========================================================================

describe("5 · a Design revised during Build pauses only what it reaches", () => {
  it("stales only the reachable graph, refuses the affected start by name, and lets the unaffected Task converge", async () => {
    h = projectWorkHarness();
    mkdirSync(h.projectRoot, { recursive: true });

    // The reachable graph: DES-1 → PLAN-1 → TASK-1. Beside it, and reachable
    // from nothing the person is about to touch: PLAN-2 → TASK-2.
    const design = await create("design", "Export row", designBody({ hostPath: "/exports", component: "ix_row" }));
    const affected = await create("task", "Row shows the reason", taskBody({ outcome: "The row shows the reason." }));
    const untouched = await create("task", "Exporter retries a 429", taskBody({ outcome: "A 429 is retried.", commands: ["pnpm -F relay test"] }));
    const reachablePlan = await create("plan", "Export row work", planBody([affected.entity.key]));
    const otherPlan = await create("plan", "Retry work", planBody([untouched.entity.key], { verification: ["pnpm -F relay test"] }));
    await edge("depends_on", reachablePlan.entity, design.entity);
    await edge("implements", affected.entity, reachablePlan.entity);
    await edge("implements", untouched.entity, otherPlan.entity);

    await approveGate(design.entity.entityId, "design");
    await approveGate(reachablePlan.entity.entityId, "build", { mode: "autonomous" });
    await approveGate(otherPlan.entity.entityId, "build", { mode: "autonomous" });
    await act(affected.entity.entityId, "mark_ready");
    await act(untouched.entity.entityId, "mark_ready");
    await act(untouched.entity.entityId, "start");

    // The person revises the approved Design mid-build.
    await revise(await entityNow(design.entity.entityId), designBody({ hostPath: "/exports", component: "ix_row", brief: "The row gains a retry action." }));
    expect((await entityNow(design.entity.entityId)).state, "a material change is never silently re-approved").not.toBe("approved");

    // Only the reachable graph is stale, and it says which revision did it.
    const stalePlan = await entityNow(reachablePlan.entity.entityId);
    expect(stalePlan.state).toBe("stale");
    const rows = (await workList()).items;
    expect(rows.find((row) => row.key === reachablePlan.entity.key)?.staleBecauseKey).toBe(design.entity.key);
    expect(rows.find((row) => row.key === otherPlan.entity.key)?.state, "nothing the change cannot reach moved").toBe("approved");

    // The affected Task is paused — not failed — and says so by name.
    const refusal = await actRefusal(affected.entity.entityId, "start");
    expect(refusal.message).toContain(reachablePlan.entity.key);
    expect(refusal.data).toMatchObject({
      refused: "stale_upstream",
      upstream: { key: reachablePlan.entity.key, kind: "plan", revisionId: stalePlan.currentRevisionId },
    });
    const paused = await detail(affected.entity.entityId);
    expect(paused.entity.state, "paused, not failed").toBe("ready");
    expect(paused.readiness?.stalePausedBy?.key).toBe(reachablePlan.entity.key);
    expect(needsYou().items.find((row) => row.key === affected.entity.key)?.reason).toBe("stale");

    // The Task the change cannot reach is untouched, and still converges.
    const other = await detail(untouched.entity.entityId);
    expect(other.entity.state).toBe("in_progress");
    expect(other.readiness?.stalePausedBy).toBeUndefined();
    const verified = await verificationReport(other.entity, [commandRun("pnpm -F relay test", true)]);
    expect(verified.verifyResult?.taskState).toBe("needs_review");
    await acceptanceEvidence(await entityNow(untouched.entity.entityId), "pnpm -F relay test");
    expect((await act(untouched.entity.entityId, "complete")).entity.state).toBe("done");

    // And evidence does not un-stale anything: the affected Task is still
    // refused its start, by the same name, after a passing record is filed.
    await acceptanceEvidence(await entityNow(affected.entity.entityId), "pnpm -F exports test");
    expect((await actRefusal(affected.entity.entityId, "start")).message).toContain(reachablePlan.entity.key);
  });
});

// ===========================================================================
// 6 · three conversations and a restart
// ===========================================================================

describe("6 · work outlives the conversations it was made in", () => {
  it("is created in A, revised in B, executed in C, and identical after the host restarts", async () => {
    const dir = temp("lifecycle-sessions");
    h = projectWorkHarness({ dir });
    mkdirSync(h.projectRoot, { recursive: true });

    const spec = await create("spec", "Exports say why", specBody(), SESSION_A.id);
    const revised = await revise(spec.entity, specBody({ brief: "People cannot see why an export failed, and guess." }), SESSION_B.id);
    expect(revised.revision.index).toBe(2);
    expect(revised.entity.entityId, "a second conversation revises the same entity").toBe(spec.entity.entityId);

    const task = await create("task", "Failed rows say why", taskBody(), SESSION_A.id);
    await act(task.entity.entityId, "mark_ready");
    await act(task.entity.entityId, "start");
    const execution = ok<ProjectTaskLinkExecutionResult>(
      await h.call("project/task/link-execution", {
        projectId: h.projectId,
        entityId: task.entity.entityId,
        expectedRevisionId: (await entityNow(task.entity.entityId)).currentRevisionId,
        execution: { kind: "session", targetId: "ses_c", sessionPath: SESSION_C.path },
        idempotencyKey: idem(),
      }),
    );
    expect(execution.link.attempt).toBe(1);

    const beforeRestart = {
      projectId: h.projectId,
      spec: await detail(spec.entity.entityId),
      keys: (await workList()).items.map((row) => row.key),
    };

    // A restart: the same files, a new store over them.
    h.cleanup();
    h = projectWorkHarness({ dir });

    expect(h.projectId, "the project's identity is the marker's, not the process'").toBe(beforeRestart.projectId);
    const after = await detail(spec.entity.entityId);
    expect(after.entity.key).toBe(beforeRestart.spec.entity.key);
    expect(after.entity.currentRevisionId).toBe(beforeRestart.spec.entity.currentRevisionId);
    expect(after.entity.currentDigest).toBe(beforeRestart.spec.entity.currentDigest);
    expect((await workList()).items.map((row) => row.key)).toEqual(beforeRestart.keys);
    const links = (await detail(task.entity.entityId)).executionLinks ?? [];
    expect(links.map((row) => row.linkId)).toEqual([execution.link.linkId]);
    expect(links[0]?.targetId, "the conversation it was executed in survived the restart").toBe("ses_c");
  });
});

// ===========================================================================
// 7 · a cross-project mention
// ===========================================================================

describe("7 · a session in one project may read another's work and may not change it", () => {
  it("reads Q's Spec from P, and refuses the mutation with Q named", async () => {
    const dir = temp("lifecycle-cross");
    h = projectWorkHarness({ dir });
    const p = h.projectRoot;
    const q = join(dir, "beta");
    mkdirSync(p, { recursive: true });
    mkdirSync(q, { recursive: true });
    const otherId = h.methods.projectFor(q);
    expect(otherId).not.toBe(h.projectId);

    const theirs = ok<ProjectWorkWriteResult>(
      await h.call("project/work/create", { projectId: otherId, kind: "spec", title: "Their spec", body: specBody({ brief: "Their brief." }), idempotencyKey: idem() }),
    );

    // A read from P's worker: allowed, and it really carries Q's content.
    const read = (await bridge({
      method: "project/work/get",
      params: { projectId: otherId, entityId: theirs.entity.entityId, body: { mode: "full" } },
    })) as ProjectWorkBridgeResult;
    const got = read.result as ProjectWorkGetResult;
    expect(got.entity.key).toBe(theirs.entity.key);
    expect(JSON.stringify(got.body?.body)).toContain("Their brief.");

    // A write from P's worker: refused, with the owning project named.
    const refused = await bridgeRefusal(() =>
      bridge({
        method: "project/work/revise",
        params: {
          projectId: otherId,
          entityId: theirs.entity.entityId,
          expectedRevisionId: theirs.revision.revisionId,
          body: specBody({ brief: "Rewritten from somewhere else." }),
          idempotencyKey: idem(),
        },
      }),
    );
    expect(refused.message).toContain("beta");
    expect((refused.data as ProjectWorkWrongProject).refused).toBe("wrong_project");
    expect((refused.data as ProjectWorkWrongProject).owningProjectId).toBe(otherId);
    // And nothing was written: Q's Spec still reads as it did.
    const still = h.store.get({ projectId: otherId, entityId: theirs.entity.entityId, body: { mode: "full" } });
    expect(JSON.stringify(still.body?.body)).toContain("Their brief.");
    expect(still.entity.revisionCount).toBe(1);
  });
});
