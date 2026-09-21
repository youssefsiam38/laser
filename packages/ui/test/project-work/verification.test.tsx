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
  type ProjectWorkBody,
  type VerificationReport,
  type VerificationRunState,
} from "@lasercode/protocol";

import { VerificationPanel } from "../../src/components/project-work/VerificationPanel.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { detail, evidence, taskBody, type Detail } from "./plan-task-fixture.js";

let hostCalls: Array<{ method: string; params: Record<string, unknown> }>;
let hostAnswers: Record<string, unknown>;

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
    useLaserState: (selector: (state: unknown) => unknown) => selector({ sessions: [], agents: { snapshot: { agents: [] } } } as never),
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

const withReport = (value: VerificationReport): Detail =>
  detail({
    entityId: "e-task-44",
    kind: "task",
    number: 44,
    state: "in_progress",
    body: taskBody({ verificationCommands: ["pnpm -F exports test"] }) as unknown as ProjectWorkBody,
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
  hostCalls = [];
  hostAnswers = {};
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
    });
    await mount(empty, makeStore());
    await click(button("Verify…"));
    const start = hostCalls.find((call) => call.method === "pi/project/verify/start");
    expect(start?.params["cwd"]).toBe("/work/app");
    expect(start?.params["entityId"]).toBe("e-task-44");
    const live = document.querySelector("[data-slot='verification-progress']");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toContain("command 1 of 1");
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
