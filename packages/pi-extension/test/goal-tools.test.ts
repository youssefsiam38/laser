/**
 * D-146 · the goal engine registers `goal_complete`, `goal_blocked` and
 * `goal_wait` at load; they belong in a request only while a goal is in play.
 */
import { GOAL_TOOL_NAMES } from "@lasercode/pi-goal";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalModule, isGoalCommand, syncGoalTools } from "../src/modules/goal.js";
import type { ModuleContext, OutboundMessage } from "../src/modules/index.js";

function fakeCtx(active: string[], known = [...active]) {
  const setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  const ctx = {
    pi: {
      getAllTools: () => known.map((name) => ({ name })),
      getActiveTools: () => [...active],
      setActiveTools,
    },
  } as unknown as ModuleContext;
  return { ctx, setActiveTools, active: () => active };
}

const ORDINARY = ["read", "bash", "edit", "write"];
const WITH_GOAL = [...ORDINARY, ...GOAL_TOOL_NAMES];

describe("the goal tool gate", () => {
  it("takes the goal tools away when no goal is in play, and leaves everything else alone", () => {
    const { ctx, setActiveTools, active } = fakeCtx([...WITH_GOAL]);
    syncGoalTools(ctx, false);
    expect(setActiveTools).toHaveBeenCalledOnce();
    expect(active()).toEqual(ORDINARY);
  });

  it("puts them back when a goal is in play", () => {
    const { ctx, setActiveTools, active } = fakeCtx([...ORDINARY], [...WITH_GOAL]);
    syncGoalTools(ctx, true);
    expect(setActiveTools).toHaveBeenCalledOnce();
    expect(active()).toEqual(WITH_GOAL);
  });

  it("writes nothing when the tools are already where they belong", () => {
    const settled = fakeCtx([...ORDINARY], [...WITH_GOAL]);
    syncGoalTools(settled.ctx, false);
    expect(settled.setActiveTools).not.toHaveBeenCalled();
    const running = fakeCtx([...WITH_GOAL]);
    syncGoalTools(running.ctx, true);
    expect(running.setActiveTools).not.toHaveBeenCalled();
  });

  it("does nothing in a no-goal session without the goal engine", () => {
    const { ctx, setActiveTools } = fakeCtx([...ORDINARY], [...ORDINARY]);
    expect(syncGoalTools(ctx, false)).toEqual({ ok: true });
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("distinguishes missing registration from inactive registered tools", () => {
    const missing = fakeCtx([...ORDINARY], [...ORDINARY]);
    expect(syncGoalTools(missing.ctx, true)).toMatchObject({ ok: false, reason: "missing_registration" });
    expect(missing.setActiveTools).not.toHaveBeenCalled();

    const inactive = fakeCtx([...ORDINARY], [...WITH_GOAL]);
    expect(syncGoalTools(inactive.ctx, true)).toEqual({ ok: true });
    expect(inactive.active()).toEqual(WITH_GOAL);
  });

  it("keeps a no-goal session quiet when deactivation is refused", () => {
    const ctx = {
      pi: {
        getAllTools: () => GOAL_TOOL_NAMES.map((name) => ({ name })),
        getActiveTools: () => [...GOAL_TOOL_NAMES],
        setActiveTools: () => {
          throw new Error("no");
        },
      },
    } as unknown as ModuleContext;
    expect(syncGoalTools(ctx, false)).toEqual({ ok: true });
  });

  it("classifies an active goal whose tool activation is refused", () => {
    const ctx = {
      pi: {
        getAllTools: () => GOAL_TOOL_NAMES.map((name) => ({ name })),
        getActiveTools: () => [],
        setActiveTools: () => {
          throw new Error("no");
        },
      },
    } as unknown as ModuleContext;
    expect(syncGoalTools(ctx, true)).toMatchObject({ ok: false, reason: "activation_refused" });
  });

  it("emits one durable actionable diagnostic for an active goal whose registration is absent", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: OutboundMessage[] = [];
    const ctx = {
      pi: {
        on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
        getAllTools: () => ORDINARY.map((name) => ({ name })),
        getActiveTools: () => [...ORDINARY],
        setActiveTools: () => {},
      } as unknown as ExtensionAPI,
      send: (message: OutboundMessage) => sent.push(message),
      session: {
        sessionManager: {
          getBranch: () => [{
            type: "custom",
            customType: "goal-state",
            data: { goal: { id: "g1", text: "Recover", status: "active", startedAt: 1, updatedAt: 1, iteration: 0 } },
          }],
        },
      } as unknown as ExtensionContext,
    } as ModuleContext;

    goalModule.activate(ctx);
    handlers.get("before_agent_start")!({}, ctx.session);

    const errors = sent.filter((message) => message.type === "lasercode/module/log" && message.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ module: "goal", message: expect.stringMatching(/reload this conversation.*Features/i) });
    expect(sent).toContainEqual(expect.objectContaining({ type: "lasercode/goal/state", goal: expect.objectContaining({ status: "active" }) }));
  });

  it("reports a session it cannot read instead of taking the turn down with it", () => {
    // `getBranch` belongs to the engine and can throw — a session being
    // rewritten, a shape the goal engine does not recognise. Every hook this
    // module installs is the engine's, so an escape here ends the turn.
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: OutboundMessage[] = [];
    const ctx = {
      pi: {
        on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
        getAllTools: () => GOAL_TOOL_NAMES.map((name) => ({ name })),
        getActiveTools: () => [],
        setActiveTools: () => {},
      } as unknown as ExtensionAPI,
      send: (message: OutboundMessage) => {
        sent.push(message);
      },
      session: {
        sessionManager: {
          getBranch: () => {
            throw new Error("session file is being rewritten");
          },
        },
      } as unknown as ExtensionContext,
    } as ModuleContext;

    expect(() => goalModule.activate(ctx)).not.toThrow();
    for (const event of ["before_agent_start", "agent_start", "agent_end", "agent_settled", "session_compact", "session_start"]) {
      const handler = handlers.get(event);
      expect(handler, event).toBeTypeOf("function");
      expect(() => handler!({}, ctx.session), event).not.toThrow();
    }
    // The person is told, once per attempt, in words rather than a stack trace.
    expect(sent.length).toBe(7);
    for (const message of sent) {
      expect(message).toMatchObject({ type: "lasercode/module/log", module: "goal", level: "warn" });
      expect((message as { message: string }).message).toContain("could not read this session's goal");
    }
    // Nothing about the goal's own state was published from a session it could
    // not read: a wrong "no goal" would clear the person's goal bar.
    expect(sent.some((message) => message.type === "lasercode/goal/state")).toBe(false);
  });

  it("survives a worker that can no longer be told", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = {
      pi: {
        on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
        getAllTools: () => [],
        getActiveTools: () => [],
        setActiveTools: () => {},
      } as unknown as ExtensionAPI,
      send: () => {
        throw new Error("the worker is gone");
      },
      session: { sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext,
    } as ModuleContext;
    expect(() => goalModule.activate(ctx)).not.toThrow();
    expect(() => handlers.get("agent_end")!({}, ctx.session)).not.toThrow();
  });

  it("recognises the goal command in the forms a person types", () => {
    for (const text of ["/goal", "/goal ship the release", "  /goal clear", "/goal edit something"]) {
      expect(isGoalCommand(text)).toBe(true);
    }
    for (const text of ["goal", "/goals", "/goalie now", "tell me the /goal", ""]) {
      expect(isGoalCommand(text)).toBe(false);
    }
  });
});
