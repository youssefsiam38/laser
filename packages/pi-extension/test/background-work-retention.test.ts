/**
 * What a session's finished commands are allowed to hold (RP-6).
 *
 * The defect these tests stand on: every command a session ever ran kept its
 * full 256 KiB tail buffer, the engine's own result, and the closure that held
 * the tool call's context and per-task tool definition — for the life of the
 * session, foreground `ls` calls included. Two hundred commands meant two
 * hundred of each.
 *
 * Everything here uses the real local shell and the real module, because the
 * claim is about what survives a real command, not about a mock.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WIRE_NAMESPACE, backgroundTaskUpdateSchema, type BackgroundTaskRetention } from "@lasercode/protocol";
import type { ReadTaskOutputResult } from "../src/agents-bridge.js";
import { createCommandBus, type ModuleContext, type ModuleDispose } from "../src/modules/index.js";
import { backgroundWorkModule } from "../src/modules/background-work.js";

const SESSION_ID = "retention-session";
const open: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const dispose of open.splice(0)) dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(tmpdir(), `${WIRE_NAMESPACE}-tasks`, SESSION_ID), { recursive: true, force: true });
});

interface FakeTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function harness(options: { readTask?: (taskId: string, tailLines: number) => Promise<ReadTaskOutputResult> } = {}) {
  const tools = new Map<string, FakeTool>();
  const pi = {
    on: vi.fn(),
    registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
    sendMessage: vi.fn(),
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  const commands = createCommandBus();
  const send = vi.fn();
  const cwd = mkdtempSync(join(tmpdir(), "background-retention-"));
  dirs.push(cwd);
  const ctx: ModuleContext = {
    pi,
    send,
    commands,
    backgroundWork: { cwd, foregroundCommandSeconds: 120, ...(options.readTask ? { readTask: options.readTask } : {}) },
  };
  backgroundWorkModule.register!(ctx);
  const dispose = backgroundWorkModule.activate(ctx) as ModuleDispose | undefined;
  if (dispose) open.push(() => dispose({ reason: "quit" }));
  const toolCtx = { cwd, sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const call = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("call-1", params, undefined, undefined, toolCtx);
  const retention = (): BackgroundTaskRetention | undefined => {
    const messages = send.mock.calls
      .map(([message]) => message as { type: string; retention?: BackgroundTaskRetention })
      .filter((message) => message.type === "lasercode/task/retention");
    return messages.at(-1)?.retention;
  };
  const updates = () =>
    send.mock.calls
      .map(([message]) => message as { type: string; task?: unknown })
      .filter((message) => message.type === "lasercode/task/update")
      .map((message) => backgroundTaskUpdateSchema.parse(message.task));
  return { call, commands, retention, updates, send, cwd };
}

/** Wait for a task to leave `running`, the way the model would: by reading it. */
async function settled(h: ReturnType<typeof harness>, taskId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { details } = await h.call("task_output", { taskId, tail: 1 });
    if ((details as { status: string }).status !== "running") return;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still running after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const logDir = join(tmpdir(), `${WIRE_NAMESPACE}-tasks`, SESSION_ID);
const diskBytes = (): number => {
  try {
    return readdirSync(logDir).reduce((sum, file) => sum + statSync(join(logDir, file)).size, 0);
  } catch {
    return 0;
  }
};

it(
  "two hundred finished commands leave two hundred compact records, not two hundred tail buffers",
  async () => {
    const forgotten: string[] = [];
    const h = harness({
      readTask: async (taskId) => {
        forgotten.push(taskId);
        return {
          task: { id: taskId, command: "printf", title: "printf", status: "completed", origin: "background", startedAt: new Date().toISOString(), outputBytes: 0 },
          owner: { agentName: "default", subagentName: "this session", sessionId: SESSION_ID },
          text: "from the worker",
        };
      },
    });

    const ids: string[] = [];
    for (let index = 0; index < 205; index++) {
      const { details } = await h.call("bash", { command: `printf 'line %s\\n' ${index}`, background: true, notify: false });
      ids.push((details as { taskId: string }).taskId);
    }
    for (const id of ids) await settled(h, id);
    // The retention message is published when what is held changes, never on a
    // timer, so the last one is the truth about now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = h.retention()!;

    expect(held.live).toBe(0);
    // Not one live tail buffer survives a finished command.
    expect(held.liveTailBytes).toBe(0);
    // The count bound, and the five oldest forgotten by it.
    expect(held.terminal).toBe(200);
    expect(held.evicted).toBe(5);
    expect(held.excerptBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    // 205 × 256 KiB would have been 52 MiB of tails alone.
    expect(held.excerptBytes + held.liveTailBytes).toBeLessThan(2 * 1024 * 1024);

    // A record a bound forgot is still readable: the worker's index knows it,
    // and its log is still on disk (an in-memory bound never deletes bytes).
    const oldest = ids[0]!;
    const answer = await h.call("task_output", { taskId: oldest, tail: 5 });
    expect(forgotten.at(-1)).toBe(oldest);
    expect(answer.content[0]!.text).toContain("from the worker");

    // One the bound kept answers from its own durable window.
    const recent = ids.at(-1)!;
    const durable = await h.call("task_output", { taskId: recent, tail: 5 });
    expect(durable.content[0]!.text).toContain(`line ${ids.length - 1}`);
    expect((durable.details as { logState: string }).logState).toBe("retained");
  },
  120_000,
);

it(
  "never compacts or forgets a command that is still running",
  async () => {
    const h = harness({
      readTask: async (taskId) => ({
        task: { id: taskId, command: "printf", title: "printf", status: "completed", origin: "background", startedAt: new Date().toISOString(), outputBytes: 0 },
        owner: { agentName: "default", subagentName: "this session", sessionId: SESSION_ID },
        text: "from the worker",
      }),
    });
    const { details } = await h.call("bash", { command: "printf 'alive\\n'; sleep 30", background: true, notify: false });
    const live = (details as { taskId: string }).taskId;
    // Let its first output land so the tail buffer is not empty by accident.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const ids: string[] = [];
    for (let index = 0; index < 205; index++) {
      const finished = await h.call("bash", { command: `printf 'x %s\\n' ${index}`, background: true, notify: false });
      ids.push((finished as { details: { taskId: string } }).details.taskId);
    }
    for (const id of ids) await settled(h, id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const held = h.retention()!;
    expect(held.live).toBe(1);
    expect(held.liveTailBytes).toBeGreaterThan(0);
    expect(held.terminal).toBe(200);

    // It is still the same task, still running, still readable from memory.
    const reading = await h.call("task_output", { taskId: live, tail: 5 });
    expect((reading.details as { status: string }).status).toBe("running");
    expect(reading.content[0]!.text).toContain("alive");
    await h.call("task_stop", { taskId: live });
  },
  120_000,
);

it(
  "bounds the bytes a long-printing command leaves on disk without interrupting it",
  async () => {
    const h = harness();
    // 20 MiB through the real shell: more than one command may keep.
    const { details } = await h.call("bash", {
      command: "head -c 20000000 /dev/zero | tr '\\0' 'x'",
      background: true,
      notify: false,
    });
    const id = (details as { taskId: string }).taskId;
    await settled(h, id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = h.updates().filter((update) => update.id === id).at(-1)!;
    // The command ran to completion \u2014 nothing paused it, nothing killed it.
    expect(row.status).toBe("completed");
    expect(row.exitCode).toBe(0);
    // Every byte counted, and the digest covers all of them.
    expect(row.outputBytes).toBe(20_000_000);
    expect(row.outputDigest).toBe(createHash("sha256").update(Buffer.alloc(20_000_000, "x")).digest("hex"));
    // But the disk holds only the window, and says so.
    expect(row.logState).toBe("truncated");
    expect(row.retainedFromByte).toBeGreaterThan(0);
    expect(diskBytes()).toBeLessThanOrEqual(9 * 1024 * 1024);

    const answer = await h.call("task_output", { taskId: id, tail: 1 });
    expect(answer.content[0]!.text).toContain("was released");
    expect((answer.details as { retainedFromByte: number }).retainedFromByte).toBeGreaterThan(0);
  },
  120_000,
);

it(
  "releases its own bytes when the worker lowers this session's budget",
  async () => {
    const h = harness();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { details } = await h.call("bash", {
        command: "head -c 5000000 /dev/zero | tr '\\0' 'y'",
        background: true,
        notify: false,
      });
      ids.push((details as { taskId: string }).taskId);
    }
    for (const id of ids) await settled(h, id);
    const before = diskBytes();
    expect(before).toBeGreaterThan(8 * 1024 * 1024);

    // The worker never deletes another runtime's files; it says how much this
    // session may keep, and this session releases its own oldest bytes.
    expect(h.commands.deliver({ type: "lasercode/task/log-budget", bytes: 1 })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(diskBytes()).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(h.retention()!.released).toBeGreaterThan(0);
    // The facts survive the release: every row still carries its exact size.
    for (const id of ids) {
      const row = h.updates().filter((update) => update.id === id).at(-1)!;
      expect(row.outputBytes).toBe(5_000_000);
      expect(row.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  },
  120_000,
);

it(
  "names the command's own process for the inventory, and unnames it when it ends",
  async () => {
    const h = harness();
    const { details } = await h.call("bash", { command: "printf 'pid check\\n'", background: true, notify: false });
    const id = (details as { taskId: string }).taskId;
    await settled(h, id);
    const registrations = h.send.mock.calls
      .map(([message]) => message as { type: string; pid?: number; taskId?: string; exited?: boolean })
      .filter((message) => message.type === "lasercode/process/registration");
    // One process, named while it existed and unnamed when it ended — a record
    // must not outlive the process it describes (RP-1).
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).toMatchObject({ taskId: id });
    expect(registrations[0]!.exited).toBeUndefined();
    expect(registrations[0]!.pid).toBeGreaterThan(0);
    expect(registrations[0]!.pid).not.toBe(process.pid);
    expect(registrations[1]).toMatchObject({ taskId: id, pid: registrations[0]!.pid, exited: true });
  },
  60_000,
);

it("sweeps files a crashed run left behind, and nothing younger", async () => {
  const root = join(tmpdir(), `${WIRE_NAMESPACE}-tasks`);
  const stale = join(root, "crashed-session-retention");
  const fresh = join(root, "live-session-retention");
  const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  mkdirSync(stale, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(stale, "t-old.log"), "old");
  writeFileSync(join(fresh, "t-new.log"), "new");
  const old = Date.now() / 1000 - 48 * 60 * 60;
  utimesSync(join(stale, "t-old.log"), old, old);
  utimesSync(stale, old, old);

  harness();

  expect(existsSync(join(stale, "t-old.log"))).toBe(false);
  // A young file may belong to a command another session is still writing.
  expect(existsSync(join(fresh, "t-new.log"))).toBe(true);
  rmSync(fresh, { recursive: true, force: true });
  rmSync(stale, { recursive: true, force: true });
});
