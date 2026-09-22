import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_LABEL_PARAM, parseToolError, toolError } from "@lasercode/protocol";
import { Type } from "typebox";
import { LaserToolFailure, laserToolSpec, registerLaserTool, toolFailure, type LaserToolDefinition } from "../src/register-tool.js";

interface Registered {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: unknown; details: unknown }>;
}

function fakePi() {
  const tools = new Map<string, Registered>();
  const pi = { registerTool: (tool: Registered) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  return { pi, tools };
}

const parameters = Type.Object(
  { runId: Type.String({ minLength: 1, maxLength: 128, description: "The runId to read." }) },
  { additionalProperties: false },
);

function definition(overrides: Partial<LaserToolDefinition<typeof parameters, unknown>> = {}): LaserToolDefinition<typeof parameters, unknown> {
  return {
    name: "inspect_agent",
    label: "Inspect an agent",
    description: "One agent in depth.",
    parameters,
    output: { type: "object", properties: { status: { type: "string", description: "How the run is doing." } } },
    annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
    recovery: { code: "inspect_agent_failed", next: "call inspect_fleet to list the agents under you with their runIds" },
    activityLabel: "injected",
    ...overrides,
  };
}

describe("registerLaserTool", () => {
  it("registers a conforming tool with the engine", () => {
    const { pi, tools } = fakePi();
    registerLaserTool(pi, definition(), async () => ({ content: [{ type: "text", text: "ok" }], details: {} }));
    expect([...tools.keys()]).toEqual(["inspect_agent"]);
  });

  it("refuses a tool that does not conform, naming the rule", () => {
    const { pi, tools } = fakePi();
    expect(() =>
      registerLaserTool(pi, definition({ name: "inspect", description: "" }), async () => ({ content: [], details: {} })),
    ).toThrow(/tool contract/);
    expect(tools.size).toBe(0);
  });

  it("refuses an unbounded string a new tool forgot to bound", () => {
    const { pi } = fakePi();
    const open = Type.Object({ note: Type.String({ description: "Anything." }) }, { additionalProperties: false });
    expect(() =>
      registerLaserTool(pi, { ...definition(), parameters: open } as unknown as LaserToolDefinition<typeof parameters, unknown>, async () => ({ content: [], details: {} })),
    ).toThrow(/maxLength/);
  });

  it("strips the injected activity label before execute", async () => {
    const { pi, tools } = fakePi();
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], details: {} }));
    registerLaserTool(pi, definition(), execute as never);
    await tools.get("inspect_agent")!.execute("call-1", { runId: "run_7", [TOOL_LABEL_PARAM]: "Inspecting an agent" });
    expect(execute).toHaveBeenCalledWith("call-1", { runId: "run_7" }, undefined, undefined, undefined);
  });

  it("leaves an exempt tool's arguments exactly as they came", async () => {
    const { pi, tools } = fakePi();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    registerLaserTool(pi, definition({ name: "inspect_fleet", activityLabel: "exempt" }), execute as never);
    const args = { runId: "run_7" };
    await tools.get("inspect_fleet")!.execute("call-1", args);
    expect(execute.mock.calls[0]![1]).toBe(args);
  });

  it("passes a successful result through untouched", async () => {
    const { pi, tools } = fakePi();
    const result = { content: [{ type: "text", text: "ok" }], details: { status: "running" } };
    registerLaserTool(pi, definition(), async () => result);
    await expect(tools.get("inspect_agent")!.execute("call-1", { runId: "run_7" })).resolves.toBe(result);
  });

  it("turns a plain failure into the contract's error shape", async () => {
    const { pi, tools } = fakePi();
    registerLaserTool(pi, definition(), async () => {
      throw new Error('No run called "run_9" was started by this session.');
    });
    const failure = await tools.get("inspect_agent")!.execute("call-1", { runId: "run_9" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LaserToolFailure);
    expect(parseToolError((failure as Error).message)).toEqual({
      code: "inspect_agent_failed",
      message: 'No run called "run_9" was started by this session.',
      committed: false,
      next: "call inspect_fleet to list the agents under you with their runIds",
    });
    // The person's sentence survives the wrapping, so a caller matching on it still matches.
    expect((failure as Error).message).toContain('No run called "run_9" was started by this session.');
  });

  it("keeps a failure's own code and next when it carries them", async () => {
    const { pi, tools } = fakePi();
    const carried = toolError({ code: "worktree_unmerged", message: "The branch still holds work.", committed: false, next: "merge it with git, then call remove_agent_worktree again" });
    registerLaserTool(pi, definition({ name: "remove_agent_worktree", annotations: { readOnly: false, idempotent: true, destructive: true, external: false } }), async () => {
      throw Object.assign(new Error(carried.message), { toolError: carried });
    });
    const failure = await tools.get("remove_agent_worktree")!.execute("call-1", { runId: "run_9" }).catch((error: unknown) => error);
    expect(parseToolError((failure as Error).message)).toEqual(carried);
  });

  it("does not let a read-only tool claim it saved something", () => {
    const carried = toolError({ code: "read_failed", message: "The log is gone.", committed: true, next: "call inspect_fleet" });
    expect(toolFailure(Object.assign(new Error(carried.message), { toolError: carried }), definition()).committed).toBe(false);
  });

  it("reports a committed failure of a mutating tool honestly", () => {
    const carried = toolError({ code: "removal_partial", message: "The branch went; the directory did not.", committed: true, next: "remove the directory yourself, then carry on" });
    const mutating = definition({ annotations: { readOnly: false, idempotent: true, destructive: true, external: false } });
    expect(toolFailure(Object.assign(new Error(carried.message), { toolError: carried }), mutating).committed).toBe(true);
  });

  it("does not wrap an already-rendered error a second time", () => {
    const rendered = new LaserToolFailure(toolError({ code: "no_such_run", message: "No such run.", committed: false, next: "call inspect_fleet" }));
    expect(toolFailure(rendered, definition())).toEqual({ code: "no_such_run", message: "No such run.", committed: false, next: "call inspect_fleet" });
  });

  it("lets a cancelled turn through as the engine's own ending", async () => {
    const { pi, tools } = fakePi();
    const abort = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    registerLaserTool(pi, definition(), async () => {
      throw abort;
    });
    await expect(tools.get("inspect_agent")!.execute("call-1", { runId: "run_7" })).rejects.toBe(abort);
  });

  it("says something honest about a failure with no message", () => {
    expect(toolFailure(new Error(""), definition()).message).toBe("The tool failed without saying why.");
  });

  it("exposes the spec a conformance fixture records", () => {
    expect(laserToolSpec(definition())).toMatchObject({ name: "inspect_agent", label: "injected", annotations: { readOnly: true } });
  });
});
