import { SessionManager, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { startStubProvider, writeStubModels, type StubProvider, type StubRequest } from "./stub-provider.js";

interface GoalStateEntry {
  type?: unknown;
  id?: string;
  customType?: unknown;
  data?: { goal?: { id?: string; status?: string; waiting?: { reason?: string } } | null };
  message?: { role?: string };
}

interface GoalTransitionEntry {
  type?: unknown;
  customType?: unknown;
  data?: {
    goalId?: string;
    cause?: string;
    initiator?: string;
    previousStatus?: string;
    status?: string;
    abortReason?: string;
    invocationId?: string;
    runId?: string;
  };
}

let base: string;
let stub: StubProvider;
let driver: StableSdkDriver;
let wakeChildFailure: (() => Promise<void>) | undefined;

const childFailureExtension: InlineExtension = {
  name: "goal-abort-incident-fixture",
  factory(pi: ExtensionAPI) {
    pi.on("session_start", () => {
      wakeChildFailure = () => pi.sendMessage(
        {
          customType: "lasercode/agent-event",
          content: "agent.failed: child run run_incident ended without complete_agent_run",
          display: true,
          details: { runId: "run_incident", type: "agent.failed" },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    });
  },
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-goal-abort-`));
  for (const name of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, name), { recursive: true });
  wakeChildFailure = undefined;
});

afterEach(async () => {
  await driver?.dispose().catch(() => undefined);
  await stub?.close();
  rmSync(base, { recursive: true, force: true });
});

function userTextOf(request: StubRequest): string {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (part as { text?: string })?.text ?? "").join(" ")
        : "")
    .join("\n");
}

function goalIdOf(request: StubRequest): string {
  const goalId = /<goal_id>\s*([^\s<>]+)\s*<\/goal_id>/u.exec(userTextOf(request))?.[1];
  if (!goalId) throw new Error("Goal prompt carried no goal id");
  return goalId;
}

function goalStates(entries: readonly unknown[]): Array<NonNullable<GoalStateEntry["data"]>["goal"]> {
  return (entries as GoalStateEntry[])
    .filter((entry) => entry.type === "custom" && entry.customType === "goal-state" && entry.data?.goal)
    .map((entry) => entry.data!.goal!);
}

function goalTransitions(entries: readonly unknown[]): GoalTransitionEntry["data"][] {
  return (entries as GoalTransitionEntry[])
    .filter((entry) => entry.type === "custom" && entry.customType === "goal-transition")
    .map((entry) => entry.data);
}

async function allEntries(): Promise<unknown[]> {
  return (await driver.entries()).entries;
}

async function expectNoPause(entries?: readonly unknown[]): Promise<void> {
  const sessionEntries = entries ?? await allEntries();
  const states = goalStates(sessionEntries);
  expect(states.at(-1)?.status).toBe("active");
  expect(states.some((goal) => goal?.status === "paused")).toBe(false);
  expect(goalTransitions(sessionEntries).at(-1)?.invocationId).toBeTypeOf("string");
}

async function openWaitingGoal(extraExtensions: InlineExtension[] = []): Promise<void> {
  stub = await startStubProvider((request, index) => {
    if (index === 0) {
      return {
        toolCall: {
          name: "goal_wait",
          args: {
            goal_id: goalIdOf(request),
            reason: "Waiting for child run run_incident",
            activity_label: "Waiting for child",
          },
        },
      };
    }
    return { text: "Handling the wake.", delayMs: 30_000 };
  });
  writeStubModels(join(base, "agent"), stub.url);
  driver = new StableSdkDriver(extraExtensions);
  await driver.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: ["goals"],
  });
  await driver.setModel({ provider: "stub", id: "stub-1" });
  await driver.goalAction?.({ action: "start", objective: "Complete the overnight work" });
  await vi.waitFor(async () => {
    expect(goalStates(await allEntries()).at(-1)).toMatchObject({
      status: "active",
      waiting: { reason: "Waiting for child run run_incident" },
    });
  }, { timeout: 20_000, interval: 25 });
  await vi.waitFor(() => expect(driver.state().isStreaming).toBe(false), { timeout: 20_000, interval: 25 });
}

async function startWake(options?: Parameters<StableSdkDriver["prompt"]>[1]): Promise<{ turn: Promise<unknown> }> {
  const turn = driver.prompt([{ type: "text", text: "The external work changed." }], options);
  await vi.waitFor(() => expect(stub.requests).toHaveLength(2), { timeout: 20_000, interval: 25 });
  return { turn };
}

describe("goal abort policy", () => {
  it("keeps a waiting goal active when a child-failure wake is aborted, without spinning", async () => {
    await openWaitingGoal([childFailureExtension]);
    expect(wakeChildFailure).toBeTypeOf("function");

    const wake = wakeChildFailure!();
    await vi.waitFor(() => expect(stub.requests).toHaveLength(2), { timeout: 20_000, interval: 25 });
    await driver.abort();
    await wake;
    await vi.waitFor(() => expect(driver.state().isStreaming).toBe(false), { timeout: 20_000, interval: 25 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expectNoPause();
    expect(stub.requests).toHaveLength(2);
    const incidentEntries = await allEntries();
    expect(goalTransitions(incidentEntries).at(-1)).toMatchObject({
      cause: "parent_control",
      initiator: "agent",
      previousStatus: "active",
      status: "active",
      abortReason: "A parent agent interrupted or stopped this request.",
    });
  }, 120_000);

  it("keeps a goal active when the person cancels a user-owned turn", async () => {
    await openWaitingGoal();
    const { turn } = await startWake({ origin: "user" });
    await driver.abort();
    await turn;

    await expectNoPause();
    expect(goalTransitions(await allEntries()).at(-1)).toMatchObject({
      cause: "user_cancel",
      initiator: "person",
      previousStatus: "active",
      status: "active",
      abortReason: "The person cancelled this request.",
    });
  }, 120_000);

  it("keeps a goal active when its parent interrupts or stops the current run", async () => {
    await openWaitingGoal();
    const { turn } = await startWake({ origin: "agent", ownerRunId: "run_parent_control" });
    await driver.abort();
    await turn;

    await expectNoPause();
    expect(goalTransitions(await allEntries()).at(-1)).toMatchObject({
      cause: "parent_control",
      initiator: "agent",
      runId: "run_parent_control",
      previousStatus: "active",
      status: "active",
    });
  }, 120_000);

  it.each([
    { operation: "navigation", run: async (target: string) => driver.navigateTree(target, { stopFirst: true }) },
    { operation: "fork", run: async (target: string) => driver.fork(target, { stopFirst: true }) },
  ])("keeps a goal active across stop-first $operation", async ({ operation, run }) => {
    await openWaitingGoal();
    const before = await allEntries();
    const target = (before as GoalStateEntry[]).find((entry) => entry.type === "message" && entry.message?.role === "user")?.id;
    expect(target).toBeTypeOf("string");
    const originalPath = driver.state().path;
    const { turn } = await startWake();
    await run(target!);
    await turn;

    const entries = operation === "fork"
      ? SessionManager.open(originalPath).getEntries()
      : await allEntries();
    const transitions = goalTransitions(entries);
    expect(goalStates(entries).some((goal) => goal?.status === "paused")).toBe(false);
    expect(transitions.at(-1)).toMatchObject({
      cause: operation,
      initiator: "ui",
      previousStatus: "active",
      status: "active",
    });
  }, 120_000);

  it("keeps a goal active when the provider-side request abort has no worker context", async () => {
    await openWaitingGoal();
    const { turn } = await startWake();
    const native = (driver as unknown as { session(): { abort(): Promise<void> } }).session();
    await native.abort();
    await turn;

    await expectNoPause();
    expect(goalTransitions(await allEntries()).at(-1)).toMatchObject({
      cause: "provider_abort",
      initiator: "failure",
      previousStatus: "active",
      status: "active",
      abortReason: "Request aborted",
    });
  }, 120_000);

  it("writes paused only after an explicit pause action is accepted", async () => {
    await openWaitingGoal();
    expect(await driver.goalAction?.({ action: "pause" })).toMatchObject({ status: "paused" });
    const entries = await allEntries();
    expect(goalStates(entries).at(-1)?.status).toBe("paused");
    expect(goalTransitions(entries).at(-1)).toMatchObject({
      cause: "pause_action",
      initiator: "person",
      previousStatus: "active",
      status: "paused",
      invocationId: expect.stringMatching(/^goal:/u),
    });
  }, 120_000);
});
