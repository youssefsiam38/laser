import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { goalExtensionPath } from "../src/index.js";

const root = dirname(goalExtensionPath());
const extension = (await import(pathToFileURL(goalExtensionPath()).href)).default as (pi: unknown) => void;
const engine = await import(pathToFileURL(join(root, "chunks/chunk-QWIUWKRW.js")).href);

interface GoalData {
  id: string;
  text: string;
  status: string;
  waiting?: { reason: string; resumeAt?: number };
}

interface CustomEntry {
  type: "custom";
  customType: string;
  data: unknown;
  [key: string]: unknown;
}

function activeGoal(id = "goal-1", waiting?: GoalData["waiting"]): GoalData {
  return {
    ...engine.createGoal("Finish the recovery", undefined, 0),
    id,
    status: "active",
    ...(waiting ? { waiting } : {}),
  };
}

function goalEntry(goal: GoalData | null): CustomEntry {
  return { type: "custom", customType: "goal-state", data: { goal } };
}

function activeContractEntry(goalId = "goal-1"): CustomEntry {
  const message = {
    role: "custom",
    customType: "goal-contract",
    content: "This Goal contract supersedes every earlier goal-contract message.\n\nOnly the objective and goal_id in this latest Goal contract are current.",
    display: false,
    details: { version: 2, state: "active", goalId },
    timestamp: 0,
  };
  return { type: "custom", customType: "goal-contract", data: message, ...message };
}

function latestGoal(entries: readonly CustomEntry[]): GoalData | null | undefined {
  const data = [...entries].reverse().find((entry) => entry.customType === "goal-state")?.data as { goal?: GoalData | null } | undefined;
  return data?.goal;
}

function createHarness(options: {
  entries?: CustomEntry[];
  active?: string[];
  hideRegistration?: string;
  refuseActivation?: boolean;
} = {}) {
  const entries = options.entries ?? [goalEntry(activeGoal())];
  const handlers = new Map<string, Array<(event: unknown, ctx: typeof ctx) => unknown>>();
  const commands = new Map<string, { handler(args: string, ctx: typeof ctx): unknown }>();
  const tools = new Map<string, { name: string }>();
  let active = [...(options.active ?? [])];
  let hiddenRegistration = options.hideRegistration;
  let refuseActivation = options.refuseActivation ?? false;
  const notifications: Array<{ message: string; level: string }> = [];
  const sent: string[] = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const statuses: Array<string | undefined> = [];
  const abort = vi.fn();
  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const ctx = {
    cwd: "/tmp/goal-recovery-fixture",
    mode: "rpc",
    sessionManager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort,
    ui: {
      confirm: async () => true,
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  };
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (name: string, handler: (event: unknown, context: typeof ctx) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler(args: string, context: typeof ctx): unknown }) => commands.set(name, command),
    getAllTools: () => [...tools.values()].filter((tool) => tool.name !== hiddenRegistration),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      if (refuseActivation) throw new Error("allowlist is locked");
      active = [...names];
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
    sendMessage: (message: Record<string, unknown>) => {
      sentMessages.push(message);
      entries.push({ type: "custom", customType: String(message.customType), data: message, ...message });
    },
  };
  extension(pi);
  const fire = async (name: string, event: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return {
    active: () => active,
    abort,
    commands,
    ctx,
    entries,
    fire,
    notifications,
    sent,
    sentMessages,
    setHiddenRegistration: (name?: string) => { hiddenRegistration = name; },
    setRefuseActivation: (value: boolean) => { refuseActivation = value; },
    statuses,
  };
}

const goalTools = ["goal_complete", "goal_blocked", "goal_wait"];

function inactiveBoundary(results: readonly unknown[]): Record<string, unknown> | undefined {
  return results
    .map((result) => (result as { message?: Record<string, unknown> } | undefined)?.message)
    .find((message) => (message?.details as { state?: string } | undefined)?.state === "inactive");
}

describe("active goal tool recovery", () => {
  it("reactivates every registered goal tool before restoring an active goal", async () => {
    const h = createHarness({ active: ["read"] });

    await h.fire("session_start");

    expect(h.active()).toEqual(["read", ...goalTools]);
    expect(latestGoal(h.entries)?.status).toBe("active");
    expect(h.entries.some((entry) => entry.customType === "goal-state" && (entry.data as { goal?: GoalData }).goal?.status === "paused")).toBe(false);
    expect(h.notifications).toEqual([]);
  });

  it.each([
    { name: "missing registration", options: { hideRegistration: "goal_complete" } },
    { name: "activation refusal", options: { refuseActivation: true } },
  ])("keeps canonical waiting state active and shows an actionable error for $name", async ({ options }) => {
    const entries = [goalEntry(activeGoal("goal-1", { reason: "External result" }))];
    const h = createHarness({ entries, active: ["read"], ...options });

    await h.fire("session_start");

    expect(latestGoal(h.entries)).toMatchObject({ status: "active", waiting: { reason: "External result" } });
    expect(h.entries.some((entry) => entry.customType === "goal-state" && (entry.data as { goal?: GoalData }).goal?.status === "paused")).toBe(false);
    expect(h.notifications).toContainEqual({
      level: "error",
      message: expect.stringMatching(/goal tools.*\/goal pause/i),
    });
    expect(h.sent).toEqual([]);
  });

  it("keeps explicit pause and clear usable while activation is unavailable", async () => {
    const h = createHarness({ active: ["read"], refuseActivation: true });
    await h.fire("session_start");

    await h.commands.get("goal")!.handler("pause", h.ctx);
    expect(latestGoal(h.entries)?.status).toBe("paused");

    await h.commands.get("goal")!.handler("clear", h.ctx);
    expect(latestGoal(h.entries)).toBeNull();
  });

  it("keeps ordinary prompts usable, inactive, and free of goal continuations when registration is missing", async () => {
    const entries = [goalEntry(activeGoal()), activeContractEntry()];
    const h = createHarness({ entries, active: ["read"], hideRegistration: "goal_complete" });
    await h.fire("session_start");
    expect(h.notifications).toHaveLength(1);

    for (const prompt of ["ordinary question one", "ordinary question two"]) {
      const boundary = await h.fire("before_agent_start", { prompt });
      expect(inactiveBoundary(boundary)).toBeDefined();
      await h.fire("agent_start");
      await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ordinary answer" }] }] });
      await h.fire("agent_settled");
    }

    expect(h.abort).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(latestGoal(h.entries)?.status).toBe("active");
    expect(h.notifications).toHaveLength(1);
  });

  it("aborts only a goal-owned prompt when registration disappears", async () => {
    const h = createHarness({ entries: [goalEntry(null)], active: ["read", ...goalTools] });
    await h.fire("session_start");
    await h.commands.get("goal")!.handler("Finish the owned request", h.ctx);
    const ownedPrompt = h.sent.at(-1);
    expect(ownedPrompt).toBeTypeOf("string");

    h.setHiddenRegistration("goal_complete");
    const boundary = await h.fire("before_agent_start", { prompt: ownedPrompt });

    expect(h.abort).toHaveBeenCalledOnce();
    expect(inactiveBoundary(boundary)).toBeDefined();
    expect(latestGoal(h.entries)?.status).toBe("active");
    expect(h.notifications.at(-1)?.message).toMatch(/\/goal pause/i);
  });

  it("deduplicates each failure class and notifies again after real recovery", async () => {
    const h = createHarness({ active: ["read"], hideRegistration: "goal_complete" });
    await h.fire("session_start");
    await h.fire("before_agent_start", { prompt: "first ordinary prompt" });
    await h.fire("before_agent_start", { prompt: "second ordinary prompt" });
    expect(h.notifications.filter((notice) => notice.level === "error")).toHaveLength(1);

    h.setHiddenRegistration(undefined);
    await h.fire("before_agent_start", { prompt: "repair the allowlist" });
    h.setRefuseActivation(true);
    h.setHiddenRegistration(undefined);
    h.active().splice(0, h.active().length, "read");
    await h.fire("before_agent_start", { prompt: "activation now refused" });
    await h.fire("before_agent_start", { prompt: "activation still refused" });

    expect(h.notifications.filter((notice) => notice.level === "error")).toHaveLength(2);
    expect(h.notifications.at(-1)?.message).toMatch(/\/goal pause/i);
  });

  it("restores a registered waiting goal quietly without continuing it", async () => {
    const entries = [goalEntry(activeGoal("goal-wait", { reason: "Waiting for the child" }))];
    const h = createHarness({ entries, active: ["read", ...goalTools] });

    await h.fire("session_start");
    await h.fire("agent_settled");

    expect(latestGoal(entries)).toMatchObject({ id: "goal-wait", status: "active", waiting: { reason: "Waiting for the child" } });
    expect(h.sent).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("keeps a no-goal restore quiet", async () => {
    const h = createHarness({ entries: [goalEntry(null)], active: ["read"] });

    await h.fire("session_start");
    await h.fire("agent_settled");

    expect(h.abort).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.notifications).toEqual([]);
  });
});
