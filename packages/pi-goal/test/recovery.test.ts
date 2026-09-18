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
  data: { goal?: GoalData | null } | Record<string, unknown>;
}

class SharedEvents {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  suppressRelease = false;

  on(channel: string, listener: (payload: unknown) => void): void {
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(listener);
  }

  emit(channel: string, payload: unknown): void {
    if (this.suppressRelease && isRelease(payload)) return;
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(payload);
  }
}

function isRelease(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "released" in payload;
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

function latestGoal(entries: readonly CustomEntry[]): GoalData | null | undefined {
  return [...entries].reverse().find((entry) => entry.customType === "goal-state")?.data.goal as GoalData | null | undefined;
}

function createHarness(options: {
  events?: SharedEvents;
  entries?: CustomEntry[];
  active?: string[];
  hideRegistration?: string;
  refuseActivation?: boolean;
  sessionManager?: { getBranch(): CustomEntry[]; getEntries(): CustomEntry[] };
} = {}) {
  const events = options.events ?? new SharedEvents();
  const entries = options.entries ?? [goalEntry(activeGoal())];
  const handlers = new Map<string, Array<(event: unknown, ctx: typeof ctx) => unknown>>();
  const commands = new Map<string, { handler(args: string, ctx: typeof ctx): unknown }>();
  const tools = new Map<string, { name: string }>();
  let active = [...(options.active ?? [])];
  const notifications: Array<{ message: string; level: string }> = [];
  const sent: string[] = [];
  const statuses: Array<string | undefined> = [];
  const abort = vi.fn();
  const sessionManager = options.sessionManager ?? {
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
    events,
    on: (name: string, handler: (event: unknown, context: typeof ctx) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler(args: string, context: typeof ctx): unknown }) => commands.set(name, command),
    getAllTools: () => [...tools.values()].filter((tool) => tool.name !== options.hideRegistration),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      if (options.refuseActivation) throw new Error("allowlist is locked");
      active = [...names];
    },
    appendEntry: (customType: string, data: CustomEntry["data"]) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
    },
    sendMessage: () => undefined,
  };
  extension(pi);
  const fire = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return {
    active: () => active,
    abort,
    commands,
    ctx,
    entries,
    events,
    fire,
    notifications,
    sent,
    statuses,
  };
}

const goalTools = ["goal_complete", "goal_blocked", "goal_wait"];

describe("active goal tool recovery", () => {
  it("reactivates every registered goal tool before restoring an active goal", async () => {
    const h = createHarness({ active: ["read"] });

    await h.fire("session_start");

    expect(h.active()).toEqual(["read", ...goalTools]);
    expect(latestGoal(h.entries)?.status).toBe("active");
    expect(h.entries.some((entry) => entry.customType === "goal-state" && entry.data.goal?.status === "paused")).toBe(false);
    expect(h.notifications).toEqual([]);
  });

  it.each([
    { name: "missing registration", options: { hideRegistration: "goal_complete" } },
    { name: "activation refusal", options: { refuseActivation: true } },
  ])("keeps canonical state active and shows an actionable error for $name", async ({ options }) => {
    const entries = [goalEntry(activeGoal("goal-1", { reason: "External result" }))];
    const h = createHarness({ entries, active: ["read"], ...options });

    await h.fire("session_start");

    expect(latestGoal(h.entries)).toMatchObject({ status: "active", waiting: { reason: "External result" } });
    expect(h.entries.some((entry) => entry.customType === "goal-state" && entry.data.goal?.status === "paused")).toBe(false);
    expect(h.notifications).toContainEqual({
      level: "error",
      message: expect.stringMatching(/goal tools.*(reload|feature|available)/i),
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
});

describe("contended active-goal restore", () => {
  it("uses the real shared mutex interface and resumes exactly once when its owner releases", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal())];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    expect(latestGoal(entries)?.status).toBe("active");
    expect(recovering.sent).toEqual([]);

    await owner.fire("session_shutdown");
    await recovering.fire("agent_settled");
    await recovering.fire("agent_settled");

    expect(recovering.sent).toHaveLength(1);
    expect(recovering.sent[0]).toMatch(/<goal_id>\s*goal-1\s*<\/goal_id>/u);
    expect(entries.some((entry) => entry.customType === "goal-state" && entry.data.goal?.status === "paused")).toBe(false);
  });

  it("falls back to a safe settlement retry when an existing owner emits no release signal", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal())];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    events.suppressRelease = true;
    await owner.fire("session_shutdown");
    events.suppressRelease = false;

    await recovering.fire("agent_settled");
    await recovering.fire("agent_settled");

    expect(recovering.sent).toHaveLength(1);
  });

  it("preserves waiting semantics after contention", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal("goal-wait", { reason: "Waiting for the child" }))];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    await owner.fire("session_shutdown");
    await recovering.fire("agent_settled");

    expect(latestGoal(entries)).toMatchObject({ id: "goal-wait", status: "active", waiting: { reason: "Waiting for the child" } });
    expect(recovering.sent).toEqual([]);
  });

  it("re-reads canonical state and cannot revive a replaced goal", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal("goal-old"))];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    events.suppressRelease = true;
    await owner.fire("session_shutdown");
    events.suppressRelease = false;
    entries.push(goalEntry(activeGoal("goal-new")));
    await recovering.fire("agent_settled");

    expect(latestGoal(entries)?.id).toBe("goal-new");
    expect(recovering.sent).toEqual([]);
  });

  it("generic abort cancels pending recovery without retrying or pausing", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal())];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    await recovering.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Request aborted" }] });
    await owner.fire("session_shutdown");
    await recovering.fire("agent_settled");

    expect(latestGoal(entries)?.status).toBe("active");
    expect(recovering.sent).toEqual([]);
  });

  it.each([
    { action: "pause", expected: "paused" },
    { action: "clear", expected: null },
  ])("explicit $action invalidates pending recovery and remains usable", async ({ action, expected }) => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal())];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    await owner.commands.get("goal")!.handler(action, owner.ctx);
    await recovering.fire("agent_settled");

    expect(latestGoal(entries)?.status ?? null).toBe(expected);
    expect(recovering.sent).toEqual([]);
  });

  it("invalidates pending recovery on shutdown and ignores later release/settlement", async () => {
    const events = new SharedEvents();
    const entries = [goalEntry(activeGoal())];
    const sessionManager = { getBranch: () => entries, getEntries: () => entries };
    const owner = createHarness({ events, entries, sessionManager, active: [...goalTools] });
    const recovering = createHarness({ events, entries, sessionManager, active: [...goalTools] });

    await owner.fire("session_start");
    await recovering.fire("session_start");
    await recovering.fire("session_shutdown");
    await owner.fire("session_shutdown");
    await recovering.fire("agent_settled");

    expect(recovering.sent).toEqual([]);
  });
});
