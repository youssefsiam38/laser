/**
 * M21-T17: the one companion module for the whole project lifecycle.
 *
 * What only this module does: register exactly the tools the session's bridge
 * offers, and put the turn's project context in front of the model at
 * `before_agent_start` — the boundary the agent role block already uses
 * (D-140), so a packet can never be older than the turn that reads it.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LaserToolSpec } from "@lasercode/protocol";
import { projectWorkModule, registerBinding, toolLabel } from "../src/modules/project-work.js";
import { laserToolRegistry } from "../src/register-tool.js";
import type { ProjectMentionContext, ProjectWorkBridge, ProjectWorkToolBinding } from "../src/project-work-bridge.js";
import type { ModuleContext } from "../src/modules/index.js";

interface Registered {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: unknown; details: unknown }>;
}

type BeforeAgentStart = (event: { prompt: string; systemPrompt: string }) => Promise<{ systemPrompt?: string } | undefined>;
type ContextHook = (event: { messages: unknown[] }) => { messages: unknown[] } | undefined;

function fakeContext(bridge: ProjectWorkBridge | undefined, mentionContext?: ProjectMentionContext) {
  const tools = new Map<string, Registered>();
  const handlers = new Map<string, BeforeAgentStart>();
  const logs: Array<{ level: string; message: string }> = [];
  const pi = {
    registerTool: (tool: Registered) => tools.set(tool.name, tool),
    on: (event: string, handler: BeforeAgentStart) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const ctx = {
    pi,
    send: (message: { level?: string; message?: string }) => logs.push({ level: message.level ?? "", message: message.message ?? "" }),
    ...(bridge ? { projectWork: bridge } : {}),
    ...(mentionContext ? { mentionContext } : {}),
  } as unknown as ModuleContext;
  return { ctx, tools, handlers, logs };
}

function spec(name: string): LaserToolSpec {
  return {
    name,
    description: "Read this project's work, by key or by id, as a summary.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { key: { type: "string", description: "The item's key.", maxLength: 40 } },
      required: [],
    },
    output: { type: "object", properties: { key: { type: "string", description: "The item's key." } } },
    annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
    label: "injected",
  };
}

function binding(name: string, run: ProjectWorkToolBinding["run"] = async () => ({ ok: true })): ProjectWorkToolBinding {
  return { spec: spec(name), run, recovery: { code: `${name}_failed`, next: "call inspect_project_work to read the current state" } };
}

function bridgeOf(overrides: Partial<ProjectWorkBridge> = {}): ProjectWorkBridge {
  return {
    lifecycleTools: () => [],
    designTools: () => [],
    researchTools: () => [],
    turnContext: async () => undefined,
    ...overrides,
  };
}

describe("the project-work module", () => {
  it("is absent when the worker gave it no bridge", async () => {
    const { ctx, tools } = fakeContext(undefined);
    expect(await projectWorkModule.detect(ctx)).toBe(false);
    projectWorkModule.register?.(ctx);
    expect(tools.size).toBe(0);
  });

  it("registers exactly what the bridge offers, lifecycle, design and research alike", async () => {
    const { ctx, tools } = fakeContext(
      bridgeOf({
        lifecycleTools: () => [binding("inspect_project_work")],
        designTools: () => [binding("inspect_design_index")],
        researchTools: () => [binding("read_source")],
      }),
    );
    expect(await projectWorkModule.detect(ctx)).toBe(true);
    projectWorkModule.register?.(ctx);
    expect([...tools.keys()].sort()).toEqual(["inspect_design_index", "inspect_project_work", "read_source"]);
  });

  it("registers the rest when one tool does not conform, and says which", () => {
    const broken = binding("inspect_project_work");
    const { ctx, tools, logs } = fakeContext(
      bridgeOf({ lifecycleTools: () => [{ ...broken, spec: { ...broken.spec, name: "oops" } }, binding("report_project_task")] }),
    );
    projectWorkModule.register?.(ctx);
    expect([...tools.keys()]).toEqual(["report_project_task"]);
    expect(logs[0]?.message).toContain("oops");
  });

  it("runs a tool through the bridge and answers with its own result", async () => {
    const run = vi.fn(async () => ({ key: "SPEC-1" }));
    const { ctx, tools } = fakeContext(bridgeOf({ lifecycleTools: () => [binding("inspect_project_work", run)] }));
    projectWorkModule.register?.(ctx);
    const result = await tools.get("inspect_project_work")!.execute("call_1", { key: "SPEC-1", activity_label: "Reading SPEC-1" });
    // D-277: the label is a display hint, stripped before the handler sees it.
    expect(run).toHaveBeenCalledWith({ key: "SPEC-1" });
    expect(result.details).toEqual({ key: "SPEC-1" });
  });

  it("asks the bridge for this turn's context at the model-call boundary, every turn", async () => {
    const turnContext = vi.fn(async ({ prompt }: { prompt?: string }) => `# Context for ${prompt ?? ""}`);
    const { ctx, handlers } = fakeContext(bridgeOf({ turnContext }));
    await projectWorkModule.activate(ctx);
    const before = handlers.get("before_agent_start")!;
    const first = await before({ prompt: "carry on", systemPrompt: "BASE" });
    expect(first?.systemPrompt).toBe("BASE\n\n# Context for carry on");
    await before({ prompt: "and again", systemPrompt: "BASE" });
    expect(turnContext, "the packet is rebuilt at every boundary, never cached across turns").toHaveBeenCalledTimes(2);
  });

  it("puts the context in the system prompt and nothing in the transcript", async () => {
    // It is context, not something the person said: the module returns a
    // system-prompt change recorded through `recordInstructionWrite` (the
    // shared helper prompt-provenance-writers.test.ts covers), and never
    // calls `sendMessage`.
    const { ctx, handlers } = fakeContext(bridgeOf({ turnContext: async () => "# Context" }));
    const sendMessage = vi.fn();
    (ctx.pi as unknown as { sendMessage: unknown }).sendMessage = sendMessage;
    await projectWorkModule.activate(ctx);
    const result = await handlers.get("before_agent_start")!({ prompt: "go", systemPrompt: "BASE" });
    expect(result?.systemPrompt).toBe("BASE\n\n# Context");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets the turn start when the context cannot be built, and says so once", async () => {
    const { ctx, handlers, logs } = fakeContext(
      bridgeOf({
        turnContext: async () => {
          throw new Error("the app could not be reached");
        },
      }),
    );
    await projectWorkModule.activate(ctx);
    const result = await handlers.get("before_agent_start")!({ prompt: "go", systemPrompt: "BASE" });
    expect(result).toBeUndefined();
    expect(logs[0]?.message).toContain("could not be reached");
  });
});

describe("what a message mentioned", () => {
  const message = (text: string, correlationId?: string): Record<string, unknown> => ({
    role: "user",
    content: [{ type: "text", text }],
    ...(correlationId ? { correlationId } : {}),
  });

  it("puts each block after the message it belongs to and leaves the rest untouched", async () => {
    const carrier: ProjectMentionContext = {
      blocks: (messages) => [
        { afterIndex: 0, text: "## first" },
        { afterIndex: messages.length - 1, text: "## last" },
      ],
    };
    const { ctx, handlers } = fakeContext(undefined, carrier);
    expect(await projectWorkModule.detect(ctx), "a session with mentions and no project work still loads").toBe(true);
    await projectWorkModule.activate(ctx);

    const original = [message("one", "lmc-1"), { role: "assistant", content: [] }, message("two", "lmc-2")];
    const result = (handlers.get("context") as unknown as ContextHook)({ messages: [...original] });

    const roles = result!.messages.map((entry) => (entry as { role: string; customType?: string }).customType ?? (entry as { role: string }).role);
    expect(roles).toEqual(["user", "lasercode/project-work-mentions", "assistant", "user", "lasercode/project-work-mentions"]);
    expect(result!.messages[0]).toBe(original[0]);
    expect(result!.messages[2]).toBe(original[1]);
    expect(result!.messages[3]).toBe(original[2]);
    expect(JSON.stringify(result!.messages[1])).toContain("## first");
    expect(JSON.stringify(result!.messages[4])).toContain("## last");
  });

  it("hands the carrier the identity of each message and nothing else", async () => {
    const seen: unknown[] = [];
    const { ctx, handlers } = fakeContext(undefined, {
      blocks: (messages) => {
        seen.push(messages);
        return [];
      },
    });
    await projectWorkModule.activate(ctx);
    (handlers.get("context") as unknown as ContextHook)({ messages: [message("words", "lmc-1"), message("more")] });

    expect(seen[0]).toEqual([{ role: "user", correlationId: "lmc-1" }, { role: "user" }]);
  });

  it("writes nothing to the conversation, whatever it shows the model", async () => {
    const { ctx, handlers } = fakeContext(undefined, { blocks: () => [{ afterIndex: 0, text: "## context" }] });
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    Object.assign(ctx.pi as unknown as Record<string, unknown>, { sendMessage, appendEntry });
    await projectWorkModule.activate(ctx);

    const messages = [message("words", "lmc-1")];
    (handlers.get("context") as unknown as ContextHook)({ messages });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(messages, "the engine's own list is not rewritten").toHaveLength(1);
  });

  it("costs the turn nothing when the carrier fails", async () => {
    const { ctx, handlers, logs } = fakeContext(undefined, {
      blocks: () => {
        throw new Error("the app could not be reached");
      },
    });
    await projectWorkModule.activate(ctx);

    expect((handlers.get("context") as unknown as ContextHook)({ messages: [message("words", "lmc-1")] })).toBeUndefined();
    expect(logs[0]?.message).toContain("could not be reached");
  });

  it("is not mounted for a session that has neither", async () => {
    const { ctx, handlers } = fakeContext(undefined);
    expect(await projectWorkModule.detect(ctx)).toBe(false);
    await projectWorkModule.activate(ctx);
    expect(handlers.get("context")).toBeUndefined();
  });
});

describe("registerBinding", () => {
  it("labels a tool from its own verb-object name", () => {
    expect(toolLabel("inspect_project_work")).toBe("Inspect project work");
    expect(toolLabel("report_project_task")).toBe("Report project task");
  });

  it("puts the tool in the contract registry a fixture reads", () => {
    const { ctx } = fakeContext(undefined);
    registerBinding(ctx.pi, binding("write_project_artifact"));
    expect(laserToolRegistry().has("write_project_artifact")).toBe(true);
  });
});
