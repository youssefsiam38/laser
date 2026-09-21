// @vitest-environment happy-dom
/**
 * M21-T19 · verification in the Task detail.
 *
 * What is proven here is what a person is protected by, and none of it is
 * visible in a screenshot:
 *
 *   - the panel reads the **stored** report the Task's own evidence names, so
 *     a report survives the window that produced it;
 *   - starting a run sends `pi/project/verify/start` for this project's
 *     checkout, and the progress line lives in a polite live region;
 *   - stopping sends `pi/project/verify/stop` for the run that is going;
 *   - a browser-matrix item is listed with its steps and never checked here;
 *   - accepting a deviation goes through the ordinary `project/work/revise`
 *     on the exact upstream revision the proposal named.
 *
 * (AGENTS.md, D-342: a unit test over the real components, never a browser.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  type DecisionCaptureBinding,
  type ProjectWorkBody,
  type RepositoryCaptureHistoryPage,
  type RepositoryLink,
  type RepositoryLinkCaptureRevision,
  type VerificationReport,
  type VerificationRunState,
} from "@lasercode/protocol";

import { VerificationPanel } from "../../src/components/project-work/VerificationPanel.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { detail, evidence, executionLink, taskBody, type Detail } from "./plan-task-fixture.js";

let hostCalls: Array<{ method: string; params: Record<string, unknown> }>;
let hostAnswers: Record<string, unknown>;

/** The conversation this Task is being worked on in, as this window has it. */
const SESSION = { id: "s1", path: "/work/app/one.jsonl" };
let sessions: Array<{ id: string; path: string }>;

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return {
    ...actual,
    useLaserStable: () => ({
      actions: { toast: () => {} },
      client: {
        request: async (method: string, params: unknown) => {
          hostCalls.push({ method, params: params as Record<string, unknown> });
          return hostAnswers[method] ?? {};
        },
      },
    }),
    useCapability: () => ({ state: "available" }),
    useLaserState: (selector: (state: unknown) => unknown) => selector({ sessions, agents: { snapshot: { agents: [] } } } as never),
  };
});

const SOURCE = {
  authority: "task" as const,
  entityId: "e-task-44",
  kind: "task" as const,
  key: "TASK-44",
  revisionId: "e-task-44r1",
  digest: "a".repeat(64),
  title: "Failed rows say why",
};
const SPEC_SOURCE = { ...SOURCE, authority: "spec" as const, entityId: "e-spec-1", kind: "spec" as const, key: "SPEC-1", revisionId: "e-spec-1r1" };

function report(over: Partial<VerificationReport> = {}): VerificationReport {
  return {
    version: 1,
    runId: "ver_0001",
    task: SOURCE,
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:05:00.000Z",
    authorities: [SOURCE, SPEC_SOURCE],
    criteria: [
      {
        id: "task:command:0",
        authority: "task",
        kind: "command",
        text: "pnpm -F exports test passes.",
        required: true,
        machineVerifiable: true,
        source: SOURCE,
        command: "pnpm -F exports test",
      },
      {
        id: "matrix:PLAN-1:dark-narrow",
        authority: "plan",
        kind: "browser_matrix",
        text: "Checked in dark, narrow.",
        required: true,
        machineVerifiable: false,
        source: { ...SPEC_SOURCE, authority: "plan", kind: "plan", key: "PLAN-1", entityId: "e-plan-1", revisionId: "e-plan-1r1" },
        steps: ["Open the export list in the dark theme, at narrow.", "Check that nothing overflows."],
      },
    ],
    commands: [
      {
        command: "pnpm -F exports test",
        status: "passed",
        exitCode: 0,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:01:00.000Z",
        outputBytes: 12,
        outputDigest: "b".repeat(64),
        tail: "ok\n",
      },
    ],
    findings: [
      { criterionId: "task:command:0", outcome: "satisfied", detail: "pnpm -F exports test exited 0.", evidenceIds: [] },
      {
        criterionId: "matrix:PLAN-1:dark-narrow",
        outcome: "needs_person",
        detail: "A browser matrix is walked by you, never by an agent. The steps are here.",
        evidenceIds: [],
        steps: ["Open the export list in the dark theme, at narrow.", "Check that nothing overflows."],
      },
    ],
    deviations: [],
    blockers: [],
    personDecisions: [
      {
        criterionId: "matrix:PLAN-1:dark-narrow",
        question: "Checked in dark, narrow.",
        steps: ["Open the export list in the dark theme, at narrow."],
      },
    ],
    converged: false,
    outcome: "blocked",
    summary: "1 of 2 satisfied · 1 waiting on you",
    truncated: [],
    ...over,
  };
}

/** A Task with an attempt this window still has the conversation for. */
const owned = () => [executionLink({ linkId: "x1", targetId: SESSION.id, attempt: 1 })];

const withReport = (value: VerificationReport): Detail =>
  detail({
    entityId: "e-task-44",
    kind: "task",
    number: 44,
    state: "in_progress",
    body: taskBody({ verificationCommands: ["pnpm -F exports test"] }) as unknown as ProjectWorkBody,
    executionLinks: owned(),
    evidence: [
      evidence({
        evidenceId: "evd_1",
        kind: "verification",
        role: "supporting",
        outcome: "inconclusive",
        summary: `Verification: ${value.summary}`,
        blobId: "blb_1",
      }),
    ],
  });

let root: Root;
let container: HTMLDivElement;
let storeCalls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
let blob: VerificationReport | undefined;
/** What the host answers the next `project/work/get` with, in order. */
let getAnswers: Array<Record<string, unknown>>;

const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ProjectWorkStore => {
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      storeCalls.push({ method, params: params as Record<string, unknown> });
      if (method === "project/work/blob/read") {
        if (!blob) throw new Error("no blob");
        return {
          blobId: "blb_1",
          mediaType: VERIFICATION_REPORT_MEDIA_TYPE,
          digest: "c".repeat(64),
          totalBytes: 1,
          offset: 0,
          bytes: 1,
          data: Buffer.from(JSON.stringify(blob), "utf8").toString("base64"),
        };
      }
      if (method === "project/work/get") {
        const answer = getAnswers.shift();
        if (!answer) throw new Error("no detail answer was prepared");
        return answer;
      }
      if (method === "project/work/list") {
        return { projectId: "p1", seq: 1, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
      }
      return {};
    }) as never,
  });
  store.rememberPath("/work/app");
  return store;
};

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const button = (label: string): HTMLButtonElement | undefined => buttons().find((node) => (node.textContent ?? "").includes(label));
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await settle(10);
  });
};

const mount = async (value: Detail, store: ProjectWorkStore): Promise<void> => {
  await act(async () => {
    root.render(<VerificationPanel store={store} detail={value} cwd="/work/app" pollMs={5} />);
    await settle(10);
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  storeCalls = [];
  getAnswers = [];
  hostCalls = [];
  hostAnswers = {};
  sessions = [SESSION];
  blob = undefined;
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the stored report", () => {
  it("reads the report the task's own evidence names, rather than re-deriving one", async () => {
    blob = report();
    await mount(withReport(blob), makeStore());
    expect(storeCalls.some((call) => call.method === "project/work/blob/read")).toBe(true);
    expect(text()).toContain("1 of 2 satisfied");
    expect(text()).toContain("pnpm -F exports test exited 0.");
  });

  it("names the authorities it was checked against, at their exact revisions", async () => {
    blob = report();
    await mount(withReport(blob), makeStore());
    expect(text()).toContain("SPEC-1");
    expect(text()).toContain("at e-spec-1r1");
  });

  it("lists a browser matrix as yours, with the steps, and never says it checked it", async () => {
    blob = report();
    await mount(withReport(blob), makeStore());
    const decisions = document.querySelector("[data-slot='verification-decisions']");
    expect(decisions?.textContent).toContain("Open the export list in the dark theme, at narrow.");
    expect(document.querySelector("[data-slot='verification-needs_person']")).toBeTruthy();
  });

  it("says nothing has been verified yet when nothing has", async () => {
    const empty = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
    });
    await mount(empty, makeStore());
    expect(text()).toContain("Nothing has been verified yet.");
    expect(text()).toContain("It never marks a task done.");
  });
});

describe("running one", () => {
  it("starts a run for this project's checkout and says what it is doing in a live region", async () => {
    const running: VerificationRunState = {
      runId: "ver_0001",
      taskKey: "TASK-44",
      entityId: "e-task-44",
      phase: "running",
      startedAt: "2026-03-01T09:00:00.000Z",
      currentCommand: "pnpm -F exports test",
      commandsRun: 0,
      commandsTotal: 1,
      criteriaTotal: 2,
      line: "pnpm -F exports test — command 1 of 1",
    };
    hostAnswers["pi/project/verify/start"] = { run: running };
    hostAnswers["pi/project/verify/state"] = { runs: [running] };
    const empty = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      executionLinks: owned(),
    });
    await mount(empty, makeStore());
    await click(button("Verify…"));
    const start = hostCalls.find((call) => call.method === "pi/project/verify/start");
    expect(start?.params["cwd"]).toBe("/work/app");
    expect(start?.params["entityId"]).toBe("e-task-44");
    expect(start?.params["sessionPath"], "the run belongs to the conversation this task is worked on in").toBe(SESSION.path);
    const live = document.querySelector("[data-slot='verification-progress']");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toContain("command 1 of 1");
  });

  it("starts nothing when no conversation owns the task, and hands the person to Start…", async () => {
    const unowned = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
    });
    await mount(unowned, makeStore());
    expect(button("Verify…")?.disabled, "a run nobody can watch is not offered").toBe(true);
    const explanation = document.querySelector("[data-slot='verification-needs-session']");
    expect(explanation?.textContent).toContain("Start…");
    await click(button("Verify…"));
    expect(hostCalls.some((call) => call.method === "pi/project/verify/start"), "nothing invisible was started").toBe(false);
  });

  it("does not offer a run for a conversation this window no longer has", async () => {
    sessions = [];
    const gone = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      executionLinks: owned(),
    });
    await mount(gone, makeStore());
    expect(button("Verify…")?.disabled).toBe(true);
  });

  it("stops the run that is going, naming it", async () => {
    const running: VerificationRunState = {
      runId: "ver_0002",
      taskKey: "TASK-44",
      entityId: "e-task-44",
      phase: "running",
      startedAt: "2026-03-01T09:00:00.000Z",
      commandsRun: 0,
      commandsTotal: 2,
      criteriaTotal: 2,
      line: "Running 2 commands",
    };
    hostAnswers["pi/project/verify/start"] = { run: running };
    hostAnswers["pi/project/verify/state"] = { runs: [running] };
    hostAnswers["pi/project/verify/stop"] = { stopped: true, run: { ...running, phase: "stopped", line: "Stopped after 0 of 2 commands" } };
    const empty = detail({
      entityId: "e-task-44",
      kind: "task",
      number: 44,
      state: "in_progress",
      body: taskBody() as unknown as ProjectWorkBody,
      executionLinks: owned(),
    });
    await mount(empty, makeStore());
    await click(button("Verify…"));
    await click(button("Stop"));
    const stop = hostCalls.find((call) => call.method === "pi/project/verify/stop");
    expect(stop?.params["runId"]).toBe("ver_0002");
  });
});

describe("deviations", () => {
  it("accepts one through the ordinary revise path, on the exact revision it named", async () => {
    const proposed: ProjectWorkBody = {
      kind: "spec",
      spec: {
        form: "full",
        brief: "An export that fails says why, without naming a path.",
        outcomes: [],
        nonGoals: [],
        requirements: [],
        acceptance: [],
        constraints: [],
      },
    };
    blob = report({
      deviations: [
        {
          id: "dev-1",
          reason: "The must requirement cannot be met without naming the path.",
          proposal: "Let the reason name the export instead.",
          upstream: { entityId: "e-spec-1", kind: "spec", key: "SPEC-1", revisionId: "e-spec-1r1", digest: "a".repeat(64) },
          proposedBody: proposed,
          state: "proposed",
        },
      ],
    });
    await mount(withReport(blob), makeStore());
    expect(text()).toContain("The must requirement cannot be met without naming the path.");
    await click(button("Accept and revise SPEC-1"));
    const revise = storeCalls.find((call) => call.method === "project/work/revise");
    expect(revise?.params["entityId"]).toBe("e-spec-1");
    expect(revise?.params["expectedRevisionId"], "the exact revision the proposal was written against").toBe("e-spec-1r1");
    expect(String(revise?.params["note"])).toContain("Accepted a verification deviation");
  });

  it("offers only to open the upstream when the proposal is words rather than a body", async () => {
    blob = report({
      deviations: [
        {
          id: "dev-2",
          reason: "The rule does not exist in this package.",
          proposal: "Name the rules it really has.",
          upstream: { entityId: "e-spec-1", kind: "spec", key: "SPEC-1", revisionId: "e-spec-1r1", digest: "a".repeat(64) },
          state: "proposed",
        },
      ],
    });
    await mount(withReport(blob), makeStore());
    expect(button("Accept and revise SPEC-1")).toBeUndefined();
    expect(button("Open SPEC-1")).toBeTruthy();
  });
});

/**
 * D-363 · which evidence a decision was really made on.
 *
 * The panel already shows what a repository record points at now. These are
 * the two things that are *not* that, and that a person needs when they come
 * back to a decision months later: the capture an approval or a completion was
 * bound to, and how this work's evidence changed since. Both are read one
 * bounded page at a time, and a decision whose proof has been corrected since
 * says so rather than borrowing the current pointer's authority.
 */
describe("what a decision rests on", () => {
  const LINK: RepositoryLink = {
    projectId: "p1",
    linkId: "rl_1",
    subject: { entityId: "e-task-44", revisionId: "e-task-44r1", kind: "task", key: "TASK-44", digest: "a".repeat(64) },
    relation: "implemented_by",
    repositoryId: "repo_1",
    target: {
      change: {
        base: { vcs: "git", objectFormat: "sha1", commitObjectId: "1".repeat(40) },
        head: { vcs: "git", objectFormat: "sha1", commitObjectId: "2".repeat(40) },
        diffDigest: "d".repeat(64),
      },
    },
    createdBy: { kind: "person", label: "You" },
    createdAt: "2026-03-01T09:00:00.000Z",
    captureBlobId: "blb_corrected",
  };

  const binding = (over: Partial<DecisionCaptureBinding> = {}): DecisionCaptureBinding => ({
    kind: "task_completion",
    decisionId: "42",
    entityId: "e-task-44",
    linkId: "rl_1",
    blobId: "blb_atthetime",
    associationRevisionId: "rlc_1",
    associationSeq: 2,
    boundAt: "2026-03-01T09:06:00.000Z",
    ...over,
  });

  const association = (over: Partial<RepositoryLinkCaptureRevision> = {}): RepositoryLinkCaptureRevision => ({
    revisionId: "rlc_1",
    linkId: "rl_1",
    blobId: "blb_atthetime",
    attachedAt: "2026-03-01T09:05:00.000Z",
    seq: 2,
    reason: "gate_preparation",
    actor: { kind: "person", label: "You" },
    ...over,
  });

  const page = (over: Partial<RepositoryCaptureHistoryPage>): Record<string, unknown> => ({
    ...withReport(report()),
    repositoryLinks: [LINK],
    captureHistory: { of: "associations", associations: [], bindings: [], ...over },
  });

  const withLink = (): Detail => ({ ...withReport(report()), repositoryLinks: [LINK] });

  it("asks for nothing until a person asks, then reads one bounded page", async () => {
    blob = report();
    await mount(withLink(), makeStore());
    expect(storeCalls.some((call) => call.method === "project/work/get"), "nothing is read on mount").toBe(false);
    expect(button("What decisions here rest on")).toBeTruthy();

    getAnswers = [page({ of: "decisions", bindings: [binding()] })];
    await click(button("What decisions here rest on"));
    const asked = storeCalls.find((call) => call.method === "project/work/get");
    expect((asked?.params["include"] as { captureHistory?: unknown }).captureHistory, "one selection, no cursor, no flag").toEqual({
      of: "decisions",
    });
    expect(text()).toContain("Marked done");
    expect(text(), "the capture it was bound to, not the one the record points at now").toContain("blb_atthetim");
    expect(text()).toContain("has been corrected since");
  });

  it("says when a decision's evidence is still what the record points at", async () => {
    blob = report();
    await mount(withLink(), makeStore());
    getAnswers = [page({ of: "decisions", bindings: [binding({ blobId: "blb_corrected", kind: "approval" })] })];
    await click(button("What decisions here rest on"));
    expect(text()).toContain("An approval");
    expect(text()).toContain("still what this record points at");
    expect(text()).not.toContain("has been corrected since");
  });

  it("reads the rest of a long history only when asked, and carries the cursor", async () => {
    blob = report();
    await mount(withLink(), makeStore());
    getAnswers = [
      page({
        of: "associations",
        associations: [association(), association({ revisionId: "rlc_0", seq: 1, reason: "first_capture", blobId: "blb_first" })],
        nextCursor: "rl_1:1",
      }),
    ];
    await click(button("Every proof this work has had"));
    expect(text()).toContain("Kept with this record when it was made.");
    expect(text()).toContain("which is not a decision that happened");
    const more = button("Show 50 more");
    expect(more, "there is more, and it says so rather than looking complete").toBeTruthy();

    getAnswers = [page({ of: "associations", associations: [association({ revisionId: "rlc_old", seq: 0, reason: "legacy_baseline" })] })];
    await click(more);
    const second = storeCalls.filter((call) => call.method === "project/work/get")[1];
    expect((second?.params["include"] as { captureHistory?: { cursor?: string } }).captureHistory?.cursor).toBe("rl_1:1");
    expect(text(), "and a baseline says what it is, rather than standing in for a history").toContain(
      "what came before it is not known",
    );
    expect(button("Show 50 more"), "the last page offers nothing more").toBeUndefined();
    expect(text()).toContain("All 3 of them.");
  });

  it("says plainly when this app cannot attest what a decision rested on", async () => {
    blob = report();
    await mount(withLink(), makeStore());
    getAnswers = [page({ of: "decisions", bindings: [] })];
    await click(button("What decisions here rest on"));
    expect(text()).toContain("No decision here has recorded evidence it rests on yet.");
    expect(text(), "and it does not pretend the absence is an answer").toContain("not something this app can attest");
  });
});
