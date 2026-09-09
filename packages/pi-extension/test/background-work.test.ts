import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_TOOL_NAMES, TASK_EVENT_MESSAGE_TYPE, WIRE_NAMESPACE, backgroundTaskUpdateSchema, type BackgroundTaskUpdate } from "@lasercode/protocol";
import { createLaserExtension } from "../src/index.js";
import { createCommandBus, type ModuleContext } from "../src/modules/index.js";
import { backgroundWorkModule, lastLines, TailBuffer } from "../src/modules/background-work.js";

interface FakeTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, { description?: string }>; required?: string[] };
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

/** Nothing the model can call waits (D-162); the test watches `task_list` itself. */
async function settled(h: Harness, taskId: string, timeoutMs = 5000): Promise<{ status: string; exitCode: number | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { details } = await h.call("task_list", {});
    const task = (details.tasks as Array<{ taskId: string; status: string; exitCode: number | null }>).find((t) => t.taskId === taskId);
    if (task && task.status !== "running") return { status: task.status, exitCode: task.exitCode };
    if (Date.now() > deadline) throw new Error(`task ${taskId} still running after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Harness = ReturnType<typeof harness>;

function harness(foregroundCommandSeconds = 0.3) {
  const tools = new Map<string, FakeTool>();
  const sendMessage = vi.fn();
  const pi = {
    on: vi.fn(),
    registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
    sendMessage,
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  const commands = createCommandBus();
  const send = vi.fn();
  const cwd = mkdtempSync(join(tmpdir(), "background-work-"));
  dirs.push(cwd);
  const ctx: ModuleContext = { pi, send, commands, backgroundWork: { cwd, foregroundCommandSeconds } };
  backgroundWorkModule.register!(ctx);
  const dispose = backgroundWorkModule.activate(ctx) as (() => void) | undefined;
  if (dispose) open.push(dispose);
  const toolCtx = { cwd, sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const call = (name: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void) =>
    tools.get(name)!.execute("call-1", params, signal, onUpdate, toolCtx);
  /**
   * Every `lasercode/task/update` the module published, validated against the
   * wire schema — a fleet row nobody can parse is not a fleet row.
   */
  const published = (): BackgroundTaskUpdate[] =>
    send.mock.calls
      .map(([message]) => message as { type: string; task?: unknown })
      .filter((message) => message.type === "lasercode/task/update")
      .map((message) => backgroundTaskUpdateSchema.parse(message.task) as BackgroundTaskUpdate);
  return { tools, published, sendMessage, commands, cwd, call, dispose, send };
}

const logPath = (taskId: string) => join(tmpdir(), `${WIRE_NAMESPACE}-tasks`, SESSION_ID, `${taskId}.log`);

/** Every word the model reads about a tool: description, snippet, guidelines, parameter text. */
function modelText(tool: FakeTool): string {
  return [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), ...Object.values(tool.parameters.properties).map((p) => p.description ?? "")].join("\n");
}

describe("background-work: the bash override", () => {
  it("registers bash plus the three task tools and never tells the model to wait or poll", () => {
    const h = harness(120);
    expect([...h.tools.keys()]).toEqual(["bash", ...BACKGROUND_TOOL_NAMES]);
    expect(h.tools.has("task_wait")).toBe(false);
    const bash = h.tools.get("bash")!;
    expect(bash.description).toContain("Execute a bash command");
    expect(bash.description).toContain("still running after 120 seconds keeps running as a background task");
    expect(bash.description).toContain("exit is sent to you as a message");
    expect(Object.keys(bash.parameters.properties)).toEqual(["command", "timeout", "background", "notify"]);
    expect(bash.parameters.required).toEqual(["command"]);
    expect(bash.parameters.properties.notify!.description).toContain("Only with background true");
    expect(bash.parameters.properties.notify!.description).toContain("never wakes one");
    expect(bash.parameters.properties.notify!.description).toContain("Ignored without background");
    expect(bash.parameters.properties.background!.description).toContain("You will be told when it exits; carry on meanwhile");
    expect(bash.promptSnippet).toContain("background tasks");
    expect(bash.promptGuidelines!.join("\n")).toContain("PI_*");
    expect(bash.promptGuidelines!.join("\n")).toContain("notify false");
    for (const name of BACKGROUND_TOOL_NAMES) {
      const tool = h.tools.get(name)!;
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toContain(name);
    }
    // D-162: nothing the model reads names a waiting tool, tells it to block,
    // or tells it to poll.
    for (const tool of h.tools.values()) expect(modelText(tool)).not.toMatch(/task_wait|block until|\bwait\b|\bpoll/i);
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
    expect(list.details.tasks).toEqual([expect.objectContaining({ command: "echo hi", status: "completed", exitCode: 0, background: false, promoted: false, notify: false })]);
    await expect(h.call("bash", { command: "echo oops >&2; exit 3" })).rejects.toThrow(/exited with code 3/);
    const after = await h.call("task_list", {});
    expect(after.details.tasks[1]).toMatchObject({ status: "failed", exitCode: 3 });
    // Foreground commands that finish within the limit are not fleet work:
    // their tool row carries the result, so no task is published.
    expect(h.published()).toEqual([]);
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
    // The same guidance a parent reads when a child starts (D-158): carry on,
    // the ending comes to you.
    expect(result.content[0]!.text).toContain(`Do not wait for task ${taskId}. Carry on with your own work; when it exits, its status, exit code and the last lines of its output will be sent to you as a message.`);
    expect(result.content[0]!.text).toContain(`task_output ${taskId}`);
    expect(result.content[0]!.text).toContain(`task_stop ${taskId}`);
    expect(result.content[0]!.text).not.toContain("task_wait");
    expect(h.sendMessage).not.toHaveBeenCalled();

    expect(await settled(h, taskId)).toEqual({ status: "completed", exitCode: 0 });
    const output = await h.call("task_output", { taskId });
    expect(output.content[0]!.text).toContain("a\nb");
    expect(output.content[0]!.text).toContain(`task ${taskId} completed (exit code 0)`);
    expect(readFileSync(logPath(taskId), "utf8")).toBe("a\nb\n");

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message).toMatchObject({ customType: TASK_EVENT_MESSAGE_TYPE, display: true, details: { taskId, status: "completed", exitCode: 0, promoted: true, notify: true } });
    expect(message.content).toContain(`Background task ${taskId} (echo a; sleep 0.5; echo b) exited with code 0.`);
    expect(message.content).toContain("Last lines:\na\nb");

    // A promoted task is the same task, keeping the output it already made.
    const tasks = h.published();
    expect(tasks.every((t) => t.id === taskId)).toBe(true);
    expect(tasks[0]).toMatchObject({
      title: "echo a; sleep 0.5; echo b",
      command: "echo a; sleep 0.5; echo b",
      status: "running",
      origin: "promoted",
      logPath: logPath(taskId),
    });
    expect(tasks[0]!.outputBytes).toEqual(expect.any(Number));
    expect(tasks.at(-1)).toMatchObject({ status: "completed", exitCode: 0, outputBytes: 4, activity: "b" });
    expect(tasks.at(-1)!.endedAt).toBeDefined();
  });

  it("returns immediately for an explicit background command and wakes the model when it exits", async () => {
    const h = harness(5);
    const started = Date.now();
    const result = await h.call("bash", { command: "sleep 0.3; echo done", background: true });
    expect(Date.now() - started).toBeLessThan(200);
    const taskId: string = result.details.taskId;
    expect(result.details).toEqual({ taskId, background: true });
    const text = result.content[0]!.text;
    expect(text).toContain(`Started background task ${taskId}: sleep 0.3; echo done.`);
    expect(text).toContain(`Do not wait for task ${taskId}. Carry on with your own work; when it exits, its status, exit code and the last lines of its output will be sent to you as a message.`);
    expect(text).toContain(`Use task_output ${taskId} to read its output meanwhile, or task_stop ${taskId} to end it.`);
    expect(text).not.toMatch(/task_wait|block until/);
    expect(h.sendMessage).not.toHaveBeenCalled();

    expect(await settled(h, taskId)).toEqual({ status: "completed", exitCode: 0 });
    // D-162: an explicit background exit wakes the model's turn, the same as
    // a promoted one — same message shape, same delivery.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message).toMatchObject({ customType: TASK_EVENT_MESSAGE_TYPE, display: true, details: { taskId, status: "completed", exitCode: 0, promoted: false, background: true, notify: true } });
    expect(message.content).toContain(`Background task ${taskId} (sleep 0.3; echo done) exited with code 0.`);
    expect(message.content).toContain("Last lines:\ndone");
    expect(message.content).toContain(`task_output ${taskId}`);
    expect((await h.call("task_output", { taskId, tail: 1 })).content[0]!.text).toContain("done");
  });

  it("records a notify false exit for the next turn without waking one", async () => {
    const h = harness(5);
    const result = await h.call("bash", { command: "sleep 0.2; echo served", background: true, notify: false });
    const taskId: string = result.details.taskId;
    expect(result.details).toEqual({ taskId, background: true });
    const text = result.content[0]!.text;
    expect(text).toContain(`Started background task ${taskId}: sleep 0.2; echo served.`);
    expect(text).toContain(`You asked not to be told when task ${taskId} exits: its ending is recorded and shown to you with your next turn, and never starts one.`);
    expect(text).toContain(`Use task_output ${taskId} to read its output, or task_stop ${taskId} to end it.`);
    expect(text).not.toContain("Do not wait");
    expect((await h.call("task_list", {})).details.tasks[0]).toMatchObject({ taskId, background: true, notify: false });

    expect(await settled(h, taskId)).toEqual({ status: "completed", exitCode: 0 });
    // The exit still reaches the model — with its next turn, not by starting one.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(message).toMatchObject({ customType: TASK_EVENT_MESSAGE_TYPE, display: true, details: { taskId, status: "completed", exitCode: 0, background: true, notify: false } });
    expect(message.content).toContain(`Background task ${taskId} (sleep 0.2; echo served) exited with code 0.`);
    expect(message.content).toContain("Last lines:\nserved");
    expect(h.published().at(-1)).toMatchObject({ id: taskId, status: "completed", origin: "background" });
  });

  it("ignores notify without background: a promoted command still wakes the model", async () => {
    const h = harness(0.2);
    const quick = await h.call("bash", { command: "echo now", notify: false });
    expect(quick.content[0]!.text.trim()).toBe("now");
    expect(quick.details?.taskId).toBeUndefined();

    const promoted = await h.call("bash", { command: "sleep 0.4; echo later", notify: false });
    expect(promoted.details).toMatchObject({ promoted: true });
    const taskId: string = promoted.details.taskId;
    expect(promoted.content[0]!.text).toContain(`Do not wait for task ${taskId}.`);
    expect(await settled(h, taskId)).toEqual({ status: "completed", exitCode: 0 });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(h.sendMessage.mock.calls[0]![0]).toMatchObject({ details: { taskId, promoted: true, notify: true } });
  });

  it("stops a task through task_stop and records why", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    const stopped = await h.call("task_stop", { taskId: details.taskId });
    expect(stopped.details).toEqual({ taskId: details.taskId, status: "stopped", exitCode: null });
    expect(stopped.content[0]!.text).toBe(`Task ${details.taskId} stopped.`);
    expect(h.published().at(-1)).toMatchObject({ status: "stopped", terminalReason: "the agent stopped it", exitCode: null });
    const again = await h.call("task_stop", { taskId: details.taskId });
    expect(again.content[0]!.text).toContain("already ended with status stopped");
    // The agent asked for the stop and gets the ending like any other exit.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]![0].content).toContain("was stopped (the agent stopped it)");
    expect(h.sendMessage.mock.calls[0]![1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("answers the fleet's Stop from the worker command bus", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    // A task this session does not own is not ours to answer.
    expect(h.commands.deliver({ type: "lasercode/task/stop", id: "t-nope" })).toBe(false);
    expect(h.commands.deliver({ type: "lasercode/task/stop", id: details.taskId })).toBe(true);
    expect(await settled(h, details.taskId)).toMatchObject({ status: "stopped" });
    expect(h.published().at(-1)).toMatchObject({ status: "stopped", terminalReason: "you stopped it" });
    expect(h.sendMessage.mock.calls[0]![0].content).toContain("was stopped (you stopped it)");
  });

  it("rejects unknown tasks", async () => {
    const h = harness(5);
    await expect(h.call("task_output", { taskId: "t-missing" })).rejects.toThrow(/No task t-missing/);
    await expect(h.call("task_stop", { taskId: "t-missing" })).rejects.toThrow(/No task t-missing/);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await h.call("task_output", { taskId: promoted.details.taskId })).details).toMatchObject({ status: "running" });
    await h.call("task_stop", { taskId: promoted.details.taskId });
  });

  it("stops running tasks when the session shuts down", async () => {
    const h = harness(5);
    const { details } = await h.call("bash", { command: "sleep 30", background: true });
    h.dispose?.();
    open.length = 0;
    expect(await settled(h, details.taskId)).toMatchObject({ status: "stopped" });
    expect(h.published().at(-1)).toMatchObject({ status: "stopped", terminalReason: "the session ended" });
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
    expect(registered).toEqual(["bash", "task_list", "task_output", "task_stop"]);
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
