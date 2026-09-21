// @vitest-environment happy-dom
/**
 * M21-T19 · Stop, while a verification run is winding up.
 *
 * A stop is accepted once. After that the run is ending its commands, and
 * after the report has left it cannot be recalled at all — the request comes
 * back saying nothing changed, because nothing can. An act offered in that
 * state is an offer this app cannot keep: a person presses it, nothing they
 * can see happens, and they are left wondering whether their first press
 * worked.
 *
 * So the act stays where it is and says what is actually going on, in the
 * words the run's own state gives it. What is pinned here is the behaviour:
 * no cancellation is offered while none is possible, nothing is sent when
 * there is nothing to send, and Stop is still there \u2014 lit — while the run is
 * plainly running.
 *
 * (AGENTS.md, D-342: a unit test over the real component, never a browser.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkBody, VerificationRunState } from "@lasercode/protocol";

import { VerificationPanel } from "../../src/components/project-work/VerificationPanel.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { detail, executionLink, taskBody, type Detail } from "./plan-task-fixture.js";

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

let root: Root;
let container: HTMLDivElement;

const settle = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ProjectWorkStore => {
  const store = new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod) => {
      if (method === "project/work/list") {
        return { projectId: "p1", seq: 1, items: [], counts: { total: 0, needsAttention: 0, byKind: { spec: 0, research: 0, design: 0, plan: 0, task: 0 } } };
      }
      return {};
    }) as never,
  });
  store.rememberPath("/work/app");
  return store;
};

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const stopButton = (): HTMLButtonElement | undefined =>
  buttons().find((node) => /stop|saving results/i.test(node.textContent ?? ""));

const task = (): Detail =>
  detail({
    entityId: "e-task-44",
    kind: "task",
    number: 44,
    state: "in_progress",
    body: taskBody({ verificationCommands: ["pnpm -F exports test"] }) as unknown as ProjectWorkBody,
    executionLinks: [executionLink({ linkId: "x1", targetId: SESSION.id, attempt: 1 })],
  });

function runState(over: Partial<VerificationRunState>): VerificationRunState {
  return {
    runId: "ver_9b0a5e2c-6c1f-4d8e-9c2a-6a1d7f0b2e55",
    taskKey: "TASK-44",
    entityId: "e-task-44",
    sessionPath: SESSION.path,
    fleetTaskId: "verify-ver_9b0a5e2c-6c1f-4d8e-9c2a-6a1d7f0b2e55",
    phase: "running",
    startedAt: "2026-03-01T09:00:00.000Z",
    commandsRun: 0,
    commandsTotal: 2,
    criteriaTotal: 2,
    line: "Running 2 commands",
    ...over,
  } as VerificationRunState;
}

/** Start a run and let the panel's first poll bring back `state`. */
async function started(state: VerificationRunState): Promise<void> {
  hostAnswers["pi/project/verify/start"] = { run: runState({}) };
  hostAnswers["pi/project/verify/state"] = { runs: [state] };
  hostAnswers["pi/project/verify/stop"] = { stopped: false, run: state };
  await act(async () => {
    root.render(<VerificationPanel store={makeStore()} detail={task()} cwd="/work/app" pollMs={5} />);
    await settle();
  });
  const start = buttons().find((node) => (node.textContent ?? "").includes("Verify"));
  await act(async () => {
    start!.click();
    await settle(20);
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  hostCalls = [];
  hostAnswers = {};
  sessions = [SESSION];
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("stopping a verification run", () => {
  it("offers Stop while the run is plainly running, and sends it for that run", async () => {
    await started(runState({ phase: "running" }));
    const stop = stopButton();
    expect(stop, "a running Command is stoppable from where a person is watching it").toBeDefined();
    expect(stop!.disabled).toBe(false);
    await act(async () => {
      stop!.click();
      await settle();
    });
    const sent = hostCalls.filter((call) => call.method === "pi/project/verify/stop");
    expect(sent, "one stop, for the run that is going").toHaveLength(1);
    expect(sent[0]!.params["runId"]).toBe("ver_9b0a5e2c-6c1f-4d8e-9c2a-6a1d7f0b2e55");
  });

  it("offers no second cancellation once a stop has been accepted, and says the run is stopping", async () => {
    await started(runState({ stopping: true, line: "Stopping — ending the commands and writing what this run proved" }));
    const stop = stopButton();
    expect(stop, "the act stays in place rather than disappearing under the pointer").toBeDefined();
    expect(stop!.disabled, "and cannot be pressed for something that is already happening").toBe(true);
    expect(stop!.textContent, "it says what is happening, not what could be asked for").toContain("Stopping");

    const before = hostCalls.filter((call) => call.method === "pi/project/verify/stop").length;
    await act(async () => {
      stop!.click();
      await settle();
    });
    expect(
      hostCalls.filter((call) => call.method === "pi/project/verify/stop"),
      "nothing is asked for that nothing could do",
    ).toHaveLength(before);
  });

  it("says the results are being saved once the report is with the host, and offers nothing to cancel it", async () => {
    await started(runState({ phase: "reporting", stopping: true, line: "Saving what this run proved for TASK-44" }));
    const stop = stopButton();
    expect(stop!.disabled, "a record already being written cannot be recalled").toBe(true);
    expect(stop!.textContent, "so the act says what it is waiting for").toContain("Saving results");

    await act(async () => {
      stop!.click();
      await settle();
    });
    expect(hostCalls.some((call) => call.method === "pi/project/verify/stop"), "and asks for nothing").toBe(false);
  });

  it("shows why a run that will not stop is still going, and stops saying it once the work closes", async () => {
    // The state a worker publishes when a command's process tree refused to
    // end: the run has *not* finished, nothing has been recorded, and the app
    // knows exactly why. Saying nothing here leaves a person watching a live
    // line that never changes.
    const stuck =
      "This run's command could not be stopped (EPERM), so it is still running. The run stays open until that process closes \u2014 nothing has been recorded for it.";
    await started(runState({ phase: "running", stopping: true, problem: stuck, line: "Stopping \u2014 ending this run's commands" }));

    const alert = [...document.body.querySelectorAll("[role='alert']")].find((node) => (node.textContent ?? "").includes("EPERM"));
    expect(alert, "the reason reaches the person watching, not only a log").toBeDefined();
    expect(alert!.textContent, "in words about what is happening now").toContain("could not be stopped");
    expect(alert!.textContent, "and it says nothing was recorded, because nothing was").toContain("Nothing has been recorded");
    expect(alert!.querySelector("button"), "there is nothing to retry: the run is still going").toBeNull();
    expect(
      buttons().find((node) => (node.textContent ?? "").includes("Verify"))!.disabled,
      "so no second run is offered either",
    ).toBe(true);
    expect(
      document.querySelector("[data-slot='verification-progress']")?.textContent,
      "the live line is still the run's own",
    ).toContain("Stopping");

    // The work really closes: the run ends, and a sentence about waiting is
    // not true of it any more.
    hostAnswers["pi/project/verify/state"] = {
      runs: [runState({ phase: "done", endedAt: "2026-03-01T09:05:00.000Z", line: "Verification of TASK-44 finished" })],
    };
    await act(async () => {
      await settle(30);
    });
    expect(
      [...document.body.querySelectorAll("[role='alert']")].some((node) => (node.textContent ?? "").includes("EPERM")),
      "the waiting is over, so the app stops saying it is waiting",
    ).toBe(false);
  });

  it("shows the run's own line while it winds up, so the wait is never silent", async () => {
    await started(runState({ stopping: true, line: "Stopping — ending the commands and writing what this run proved" }));
    const live = document.querySelector("[data-slot='verification-progress']");
    expect(live?.getAttribute("aria-live"), "the progress line is a polite live region").toBe("polite");
    expect(live?.textContent).toContain("Stopping");
  });
});
