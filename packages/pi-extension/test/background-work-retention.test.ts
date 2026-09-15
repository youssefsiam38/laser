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
/** The private root the worker hands the module in production; a scratch one here. */
let logRoot = "";

afterEach(() => {
  for (const dispose of open.splice(0)) dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function harness(options: { readTask?: (taskId: string, tailLines: number) => Promise<ReadTaskOutputResult>; logRoot?: string } = {}) {
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
  logRoot = options.logRoot ?? mkdtempSync(join(tmpdir(), "background-retention-logs-"));
  if (!options.logRoot) dirs.push(logRoot);
  const ctx: ModuleContext = {
    pi,
    send,
    commands,
    backgroundWork: { cwd, logRoot, foregroundCommandSeconds: 120, ...(options.readTask ? { readTask: options.readTask } : {}) },
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

/** Bytes under the private root, whatever opaque directory the module chose. */
const diskBytes = (): number => {
  let total = 0;
  try {
    for (const entry of readdirSync(logRoot)) {
      const directory = join(logRoot, entry);
      if (!statSync(directory).isDirectory()) continue;
      for (const file of readdirSync(directory)) total += statSync(join(directory, file)).size;
    }
  } catch {
    return total;
  }
  return total;
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
  "keeps many commands running at once inside one live-tail ceiling",
  async () => {
    const h = harness();
    const ids: string[] = [];
    // Forty commands printing at once: per-command windows alone would be
    // forty times 256 KiB, past the ceiling for the session.
    for (let index = 0; index < 40; index++) {
      const { details } = await h.call("bash", {
        command: "node -e \"const line='x'.repeat(4096)+'\\n'; for (let i=0;i<400;i++) process.stdout.write(line); setTimeout(()=>{}, 30000)\"",
        background: true,
        notify: false,
      });
      ids.push((details as { taskId: string }).taskId);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const held = h.retention()!;
    expect(held.live).toBe(40);
    // The ceiling holds across the session, not per command, and it had to be
    // applied: forty full windows would have been ten megabytes.
    expect(held.liveTailBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(held.tailsShrunk).toBeGreaterThan(0);
    // Every row still says what its command is doing, and every command is
    // still running: nothing was stopped to make room.
    for (const id of ids) {
      const row = h.updates().filter((update) => update.id === id).at(-1)!;
      expect(row.status).toBe("running");
      const reading = await h.call("task_output", { taskId: id, tail: 1 });
      expect((reading.details as { status: string }).status).toBe("running");
    }
    for (const id of ids) await h.call("task_stop", { taskId: id });
  },
  180_000,
);

it(
  "publishes the window the moment it moves, so a ranged read never uses stale offsets",
  async () => {
    const h = harness();
    const { details } = await h.call("bash", {
      command: "head -c 20000000 /dev/zero | tr '\\0' 'w'",
      background: true,
      notify: false,
    });
    const id = (details as { taskId: string }).taskId;
    await settled(h, id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = h.updates().filter((update) => update.id === id);
    // Several rotations happened inside one command. Each one published its
    // own row: the offsets a host read uses are never a throttle tick behind
    // the files they name.
    const offsets = rows.map((row) => row.retainedFromByte ?? 0);
    expect(new Set(offsets).size).toBeGreaterThan(1);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(rows.at(-1)!.logState).toBe("truncated");
    // Every published offset is one a reader could have used: it never names
    // more bytes than the command had produced at the time.
    for (const row of rows) expect(row.retainedFromByte ?? 0).toBeLessThanOrEqual(row.outputBytes);
  },
  120_000,
);

it(
  "names the command's own process for the inventory, and never claims it has ended",
  async () => {
    const h = harness();
    const { details } = await h.call("bash", { command: "printf 'pid check\\n'", background: true, notify: false });
    const id = (details as { taskId: string }).taskId;
    await settled(h, id);
    const registrations = h.send.mock.calls
      .map(([message]) => message as { type: string; pid?: number; taskId?: string })
      .filter((message) => message.type === "lasercode/process/registration");
    // Exactly one message, and it only ever says what a process *is*. A pid
    // with no start token is not an identity once the process has gone: the
    // host's own table notices the end, so the module never asserts it and
    // cannot delete the attribution of whatever takes that number next (RP-1).
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ taskId: id });
    expect(registrations[0]!.pid).toBeGreaterThan(0);
    expect(registrations[0]!.pid).not.toBe(process.pid);
    expect(Object.keys(registrations[0]!).sort()).toEqual(["pid", "taskId", "type"]);
  },
  60_000,
);

it("sweeps what a crashed run left behind, in its own root and in abandoned ones, and nothing younger", async () => {
  const { mkdirSync, utimesSync, writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "background-retention-sweep-"));
  dirs.push(root);
  const stale = join(root, "0".repeat(32));
  const fresh = join(root, "1".repeat(32));
  mkdirSync(stale, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(stale, "t-old.log"), "old");
  writeFileSync(join(fresh, "t-new.log"), "new");
  const old = Date.now() / 1000 - 48 * 60 * 60;
  utimesSync(join(stale, "t-old.log"), old, old);
  utimesSync(stale, old, old);

  // A private root a crashed process left in the system temp directory.
  const abandoned = join(tmpdir(), `${WIRE_NAMESPACE}-tasks-abandoned-test`);
  const running = join(tmpdir(), `${WIRE_NAMESPACE}-tasks-running-test`);
  mkdirSync(abandoned, { recursive: true });
  mkdirSync(running, { recursive: true });
  writeFileSync(join(abandoned, "t.log"), "gone");
  writeFileSync(join(running, "t.log"), "live");
  utimesSync(abandoned, old, old);

  harness({ logRoot: root });

  expect(existsSync(join(stale, "t-old.log"))).toBe(false);
  // A young directory may belong to a session that is still writing.
  expect(existsSync(join(fresh, "t-new.log"))).toBe(true);
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(running)).toBe(true);
  rmSync(running, { recursive: true, force: true });
});
