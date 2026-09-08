import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PANEL_EVENT, TASK_EVENT_MESSAGE_TYPE, TASK_PANEL_PREFIX, WIRE_NAMESPACE, validatePanelEvent, type RunPanel } from "@lasercode/protocol";
import { createLaserExtension } from "../src/index.js";
import { createCommandBus, createPanelClaims, type ModuleContext } from "../src/modules/index.js";
import { backgroundWorkModule, lastLines, TailBuffer } from "../src/modules/background-work.js";

interface FakeTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

const SESSION_ID = "session-under-test";
const open: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const dispose of open.splice(0)) dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(foregroundCommandSeconds = 0.3) {
  const tools = new Map<string, FakeTool>();
  const panels: unknown[] = [];
  const sendMessage = vi.fn();
  const pi = {
    on: vi.fn(),
    registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
    sendMessage,
    events: {
      on: () => () => {},
      emit: (name: string, data: unknown) => {
        if (name === PANEL_EVENT) panels.push(data);
      },
    },
  } as unknown as ExtensionAPI;
  const commands = createCommandBus();
  const claims = createPanelClaims();
  const send = vi.fn();
  const cwd = mkdtempSync(join(tmpdir(), "background-work-"));
  dirs.push(cwd);
  const ctx: ModuleContext = { pi, send, commands, panels: claims, backgroundWork: { cwd, foregroundCommandSeconds } };
  backgroundWorkModule.register!(ctx);
  const dispose = backgroundWorkModule.activate(ctx) as (() => void) | undefined;
  if (dispose) open.push(dispose);
  const toolCtx = { cwd, sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const call = (name: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void) =>
    tools.get(name)!.execute("call-1", params, signal, onUpdate, toolCtx);
  const validated = () =>
    panels.map((raw) => {
      const result = validatePanelEvent(raw);
      if (!result.ok) throw new Error(result.error);
      return result.panel as RunPanel;
    });
  return { tools, panels, validated, sendMessage, commands, claims, cwd, call, dispose, send };
}

const logPath = (taskId: string) => join(tmpdir(), `${WIRE_NAMESPACE}-tasks`, SESSION_ID, `${taskId}.log`);

describe("background-work: the bash override", () => {
  it("registers bash plus the four task tools, naming them in the prompt text", () => {
    const h = harness(120);
    expect([...h.tools.keys()]).toEqual(["bash", "task_list", "task_output", "task_wait", "task_stop"]);
    const bash = h.tools.get("bash")!;
    expect(bash.description).toContain("Execute a bash command");
    expect(bash.description).toContain("still running after 120 seconds keeps running as a background task");
    expect(Object.keys(bash.parameters.properties)).toEqual(["command", "timeout", "background"]);
    expect(bash.parameters.required).toEqual(["command"]);
    expect(bash.promptSnippet).toContain("background tasks");
    expect(bash.promptGuidelines!.join("\n")).toContain("PI_*");
    expect(bash.promptGuidelines!.join("\n")).toContain("task_wait");
    for (const name of ["task_list", "task_output", "task_wait", "task_stop"]) {
      const tool = h.tools.get(name)!;
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toContain(name);
    }
  });

  it("returns the engine's own result for a command that finishes before the limit", async () => {
    const h = harness(0.5);
    const updates: unknown[] = [];
    const result = await h.call("bash", { command: "echo hi" }, undefined, (u) => updates.push(u));
    expect(result.content[0]!.text.trim()).toBe("hi");
    expect(result.details?.taskId).toBeUndefined();
    expect(updates.length).toBeGreaterThan(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
    const list = await h.call("task_list", {});
    expect(list.details.tasks).toEqual([expect.objectContaining({ command: "echo hi", status: "completed", exitCode: 0, background: false, promoted: false })]);
    await expect(h.call("bash", { command: "echo oops >&2; exit 3" })).rejects.toThrow(/exited with code 3/);
    const after = await h.call("task_list", {});
    expect(after.details.tasks[1]).toMatchObject({ status: "failed", exitCode: 3 });
    // Foreground commands that finish within the limit are not fleet work:
    // their tool row carries the result, so no run panel is offered.
    expect(h.validated()).toEqual([]);
  });

  it("promotes a long foreground command and reports its exit with a turn-triggering message", async () => {
    const h = harness(0.3);
    const started = Date.now();
    const result = await h.call("bash", { command: "echo a; sleep 0.5; echo b" });
    expect(Date.now() - started).toBeLessThan(550);
    expect(result.details).toMatchObject({ promoted: true });
    const taskId: string = result.details.taskId;
    expect(taskId).toMatch(/^t-[0-9a-f]{8}$/);
    expect(result.content[0]!.text).toContain(`Still running after 0.3 s; it continues as background task ${taskId}.`);
    expect(result.content[0]!.text).toContain("Output so far (last lines):\na\n");
    expect(result.content[0]!.text).toContain(`task_output ${taskId}`);
    expect(h.sendMessage).not.toHaveBeenCalled();

    const waited = await h.call("task_wait", { taskIds: [taskId] });
    expect(waited.details).toEqual({ tasks: [{ taskId, status: "completed", exitCode: 0 }], timedOut: false });
    const output = await h.call("task_output", { taskId });
    expect(output.content[0]!.text).toContain("a\nb");
    expect(output.content[0]!.text).toContain(`task ${taskId} completed (exit code 0)`);
    expect(readFileSync(logPath(taskId), "utf8")).toBe("a\nb\n");

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message).toMatchObject({ customType: TASK_EVENT_MESSAGE_TYPE, display: true, details: { taskId, status: "completed", exitCode: 0, promoted: true } });
    expect(message.content).toContain(`Background task ${taskId} (echo a; sleep 0.5; echo b) exited with code 0.`);
    expect(message.content).toContain("Last lines:\na\nb");

    const panels = h.validated();
    expect(panels.every((p) => p.id === `${TASK_PANEL_PREFIX}${taskId}`)).toBe(true);
    // The first panel appears at promotion, so it may already carry output.
    expect(panels[0]).toMatchObject({ kind: "run", intent: "follow", source: "shell", title: "echo a; sleep 0.5; echo b", handle: taskId, lifecycle: "running", actions: [{ id: "stop", label: "Stop" }] });
    expect(panels[0]!.output).toEqual({ ref: `file:${logPath(taskId)}`, bytes: expect.any(Number) });
    expect(panels.at(-1)).toMatchObject({ lifecycle: "done", output: { ref: `file:${logPath(taskId)}`, bytes: 4 } });
    expect(panels.at(-1)!.actions).toBeUndefined();
    expect(panels.at(-1)!.endedAt).toBeDefined();
  });

  it("returns immediately for an explicit background command and reports its exit without waking the model", async () => {
    const h = harness(5);
    const started = Date.now();
    const result = await h.call("bash", { command: "sleep 0.3; echo done", background: true });
    expect(Date.now() - started).toBeLessThan(200);
    const taskId: string = result.details.taskId;
    expect(result.details).toEqual({ taskId, background: true });
    expect(result.content[0]!.text).toContain(`Started background task ${taskId}: sleep 0.3; echo done.`);
    const waited = await h.call("task_wait", {});
    expect(waited.details).toEqual({ tasks: [{ taskId, status: "completed", exitCode: 0 }], timedOut: false });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![1]).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(h.sendMessage.mock.calls[0]![0]).toMatchObject({ customType: TASK_EVENT_MESSAGE_TYPE, details: { taskId, promoted: false, background: true } });
    expect((await h.call("task_output", { taskId, tail: 1 })).content[0]!.text).toContain("done");
  });

  it("stops a task through task_stop and records why", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    const stopped = await h.call("task_stop", { taskId: details.taskId });
    expect(stopped.details).toEqual({ taskId: details.taskId, status: "stopped", exitCode: null });
    expect(stopped.content[0]!.text).toBe(`Task ${details.taskId} stopped.`);
    expect(h.validated().at(-1)).toMatchObject({ lifecycle: "cancelled", terminalReason: "the agent stopped it" });
    const again = await h.call("task_stop", { taskId: details.taskId });
    expect(again.content[0]!.text).toContain("already ended with status stopped");
    expect(h.sendMessage.mock.calls[0]![0].content).toContain("was stopped (the agent stopped it)");
  });

  it("answers the panel's Stop action from the worker command bus", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    const id = `${TASK_PANEL_PREFIX}${details.taskId}`;
    expect(h.claims.claimed(id)).toBe(true);
    expect(h.commands.deliver({ type: "lasercode/panel/action", id: `${TASK_PANEL_PREFIX}nope`, actionId: "stop" })).toBe(false);
    expect(h.commands.deliver({ type: "lasercode/panel/action", id, actionId: "stop" })).toBe(true);
    const waited = await h.call("task_wait", { taskIds: [details.taskId], timeoutSeconds: 5 });
    expect(waited.details.tasks[0]).toMatchObject({ status: "stopped" });
    expect(h.validated().at(-1)).toMatchObject({ lifecycle: "cancelled", terminalReason: "you stopped it" });
  });

  it("times out a wait, honours its abort signal and rejects unknown tasks", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    const timed = await h.call("task_wait", { taskIds: [details.taskId], timeoutSeconds: 0.1 });
    expect(timed.details).toEqual({ tasks: [{ taskId: details.taskId, status: "running", exitCode: null }], timedOut: true });
    const controller = new AbortController();
    const waiting = h.call("task_wait", { taskIds: [details.taskId] }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    await expect(h.call("task_output", { taskId: "t-missing" })).rejects.toThrow(/No task t-missing/);
    await expect(h.call("task_wait", { taskIds: ["t-missing"] })).rejects.toThrow(/No task t-missing/);
    await h.call("task_stop", { taskId: details.taskId });
  });

  it("lets the turn's cancel kill a foreground command, but not a promoted one", async () => {
    const h = harness(0.2);
    const turn = new AbortController();
    const foreground = h.call("bash", { command: "sleep 30" }, turn.signal);
    setTimeout(() => turn.abort(), 50);
    await expect(foreground).rejects.toThrow(/aborted/);
    expect((await h.call("task_list", {})).details.tasks[0]).toMatchObject({ status: "stopped" });
    expect(h.sendMessage).not.toHaveBeenCalled();

    const later = new AbortController();
    const promoted = await h.call("bash", { command: "sleep 30" }, later.signal);
    expect(promoted.details.promoted).toBe(true);
    later.abort();
    const still = await h.call("task_wait", { taskIds: [promoted.details.taskId], timeoutSeconds: 0.1 });
    expect(still.details).toMatchObject({ tasks: [{ status: "running" }], timedOut: true });
    await h.call("task_stop", { taskId: promoted.details.taskId });
  });

  it("stops running tasks when the session shuts down", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    h.dispose?.();
    open.length = 0;
    const waited = await h.call("task_wait", { taskIds: [details.taskId], timeoutSeconds: 5 });
    expect(waited.details.tasks[0]).toMatchObject({ status: "stopped" });
    expect(h.validated().at(-1)).toMatchObject({ lifecycle: "cancelled", terminalReason: "the session ended" });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(existsSync(logPath(details.taskId))).toBe(true);
  });
});

describe("background-work: helpers and wiring", () => {
  it("keeps only the last bytes and the last lines", () => {
    const tail = new TailBuffer(8);
    tail.append(Buffer.from("abcdef"));
    tail.append(Buffer.from("ghij"));
    expect(tail.text()).toBe("cdefghij");
    expect(lastLines("a\nb\nc\n\n", 2)).toBe("b\nc");
    expect(lastLines("", 5)).toBe("");
  });

  it("is active only when the worker supplies shell options", async () => {
    const registered: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = { on: (n: string, cb: (...args: unknown[]) => unknown) => handlers.set(n, cb), registerTool: (t: { name: string }) => registered.push(t.name), events: { on: () => () => {}, emit: () => {} }, sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const send = vi.fn();
    createLaserExtension({ send, only: ["background-work"], backgroundWork: { cwd: tmpdir(), foregroundCommandSeconds: 120 } }).factory(pi);
    await handlers.get("session_start")!({}, {});
    expect(send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: ["background-work"], failed: [] });
    expect(registered).toEqual(["bash", "task_list", "task_output", "task_wait", "task_stop"]);
    await handlers.get("session_shutdown")!({}, {});

    const bare: string[] = [];
    const bareHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const barePi = { on: (n: string, cb: (...args: unknown[]) => unknown) => bareHandlers.set(n, cb), registerTool: (t: { name: string }) => bare.push(t.name) } as unknown as ExtensionAPI;
    const bareSend = vi.fn();
    createLaserExtension({ send: bareSend, only: ["background-work"] }).factory(barePi);
    await bareHandlers.get("session_start")!({}, {});
    expect(bareSend).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: [], failed: [] });
    expect(bare).toEqual([]);
  });
});
