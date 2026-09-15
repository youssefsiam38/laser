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
import { resetLogRootForTests } from "../src/modules/task-retention.js";
import { backgroundWorkModule, backgroundWorkRetention } from "../src/modules/background-work.js";

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

function harness(options: {
  readTask?: (taskId: string, tailLines: number) => Promise<ReadTaskOutputResult>;
  logRoot?: string;
  /** Held write callbacks: storage that has stopped draining, on purpose. */
  write?: (fd: number, chunk: Buffer) => Promise<void>;
} = {}) {
  const tools = new Map<string, FakeTool>();
  const pi = {
    on: vi.fn(),
    registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
    sendMessage: vi.fn(),
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  const commands = createCommandBus();
  const send = vi.fn();
  resetLogRootForTests();
  const cwd = mkdtempSync(join(tmpdir(), "background-retention-"));
  dirs.push(cwd);
  logRoot = options.logRoot ?? mkdtempSync(join(tmpdir(), "background-retention-logs-"));
  if (!options.logRoot) dirs.push(logRoot);
  const ctx: ModuleContext = {
    pi,
    send,
    commands,
    backgroundWork: {
      cwd,
      logRoot,
      foregroundCommandSeconds: 120,
      ...(options.readTask ? { readTask: options.readTask } : {}),
      ...(options.write ? { logWrite: options.write } : {}),
    },
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
  return { call, commands, retention, updates, send, cwd, held: () => backgroundWorkRetention(ctx)! };
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

/** Storage that has stopped draining: every write is held until the test lets it go. */
function stalledWriter() {
  const settlers: Array<() => void> = [];
  const write = (_fd: number, chunk: Buffer): Promise<number> =>
    new Promise<number>((resolve) => settlers.push(() => resolve(chunk.length)));
  return { write, settlers, settle: () => { for (const settle of settlers.splice(0)) settle(); } };
}

it(
  "keeps real commands running and inside the share when storage stops draining",
  async () => {
    // The invariant itself — held bytes never pass the share, checked after
    // every append — is asserted directly against the policy in
    // `task-retention.test.ts`. This is the integration half: real commands,
    // the real module, storage that never acknowledges a write.
    const storage = stalledWriter();
    const h = harness({ write: storage.write });
    const share = 4 * 1024 * 1024;
    expect(h.commands.deliver({ type: "lasercode/task/log-budget", bytes: share })).toBe(true);

    const ids: string[] = [];
    for (let index = 0; index < 10; index++) {
      const { details } = await h.call("bash", {
        command: "node -e \"const l='z'.repeat(65536); for(let i=0;i<96;i++) process.stdout.write(l); setTimeout(()=>{},30000)\"",
        background: true,
        notify: false,
      });
      ids.push((details as { taskId: string }).taskId);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const held = h.held();
    expect(held.logBytes + held.pendingLogBytes).toBeLessThanOrEqual(share);
    expect(held.live).toBe(10);
    // Not one command was stopped, and every row still tells the exact truth.
    for (const id of ids) {
      const row = h.updates().filter((update) => update.id === id).at(-1)!;
      expect(row.status).toBe("running");
      expect(row.outputBytes).toBeGreaterThan(0);
      expect(row.outputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(["retained", "truncated", "released"]).toContain(row.logState);
    }

    // Storage comes back: the held writes settle, the abandoned bodies are
    // cleaned up, and nothing is left holding bytes or descriptors.
    storage.settle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const id of ids) await h.call("task_stop", { taskId: id });
    storage.settle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.held().pendingLogBytes).toBe(0);
    expect(diskBytes()).toBeLessThanOrEqual(share);
  },
  180_000,
);

it(
  "keeps a zero share and a tiny share honest: no body, exact facts, commands untouched",
  async () => {
    const h = harness();
    expect(h.commands.deliver({ type: "lasercode/task/log-budget", bytes: 0 })).toBe(true);
    const zero = (await h.call("bash", { command: "printf 'nothing kept\\n'", background: true, notify: false })) as { details: { taskId: string } };
    await settled(h, zero.details.taskId);
    const zeroRow = h.updates().filter((update) => update.id === zero.details.taskId).at(-1)!;
    expect(zeroRow.status).toBe("completed");
    expect(zeroRow.logState).toBe("released");
    expect(zeroRow.outputBytes).toBe(13);
    expect(zeroRow.outputDigest).toBe(createHash("sha256").update("nothing kept\n").digest("hex"));
    expect(diskBytes()).toBe(0);
    const read = await h.call("task_output", { taskId: zero.details.taskId, tail: 5 });
    expect(read.content[0]!.text).toContain("was released");

    // A share large enough for one window, and a command far larger than it.
    expect(h.commands.deliver({ type: "lasercode/task/log-budget", bytes: 2 * 1024 * 1024 })).toBe(true);
    const small = (await h.call("bash", { command: "head -c 6000000 /dev/zero | tr '\\0' 's'", background: true, notify: false })) as { details: { taskId: string } };
    await settled(h, small.details.taskId);
    const smallRow = h.updates().filter((update) => update.id === small.details.taskId).at(-1)!;
    expect(smallRow.status).toBe("completed");
    expect(smallRow.outputBytes).toBe(6_000_000);
    expect(["truncated", "released"]).toContain(smallRow.logState);
    expect(diskBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
  },
  120_000,
);

it(
  "keeps the default share as its ceiling without a worker saying anything",
  async () => {
    const h = harness();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const { details } = await h.call("bash", { command: "head -c 9000000 /dev/zero | tr '\\0' 'd'", background: true, notify: false });
      ids.push((details as { taskId: string }).taskId);
    }
    for (const id of ids) await settled(h, id);
    const held = h.held();
    // 128 MiB by default; four commands of 9 MB each keep their windows.
    expect(held.logBytes + held.pendingLogBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(diskBytes()).toBeLessThanOrEqual(128 * 1024 * 1024);
    // And each one is inside its own per-task window, not the session's.
    for (const id of ids) {
      const row = h.updates().filter((update) => update.id === id).at(-1)!;
      expect(row.outputBytes).toBe(9_000_000);
      expect(row.logState).toBe("truncated");
    }
    expect(diskBytes()).toBeLessThanOrEqual(4 * 8 * 1024 * 1024);
  },
  120_000,
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
  const { runSweep, STALE_LOG_AGE_MS } = await import("../src/modules/task-retention.js");
  const root = mkdtempSync(join(tmpdir(), "background-retention-sweep-"));
  dirs.push(root);
  const temp = mkdtempSync(join(tmpdir(), "background-retention-temp-"));
  dirs.push(temp);
  const stale = join(root, "0".repeat(32));
  const fresh = join(root, "1".repeat(32));
  mkdirSync(stale, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(stale, "t-old.0.log"), "old");
  writeFileSync(join(fresh, "t-new.0.log"), "new");
  const old = Date.now() / 1000 - 48 * 60 * 60;
  utimesSync(join(stale, "t-old.0.log"), old, old);
  utimesSync(stale, old, old);

  // Private roots other processes left behind, and one that is young enough to
  // belong to a worker running right now. Plus far more candidates than any
  // single pass may look at, to prove the walk has a cursor rather than a
  // slice it takes for ever.
  const abandoned = join(temp, `${WIRE_NAMESPACE}-tasks-abandoned`);
  const running = join(temp, `${WIRE_NAMESPACE}-tasks-running`);
  mkdirSync(abandoned, { recursive: true });
  mkdirSync(running, { recursive: true });
  utimesSync(abandoned, old, old);
  for (let index = 0; index < 600; index++) {
    const noise = join(temp, `${WIRE_NAMESPACE}-tasks-noise-${index}`);
    mkdirSync(noise, { recursive: true });
    utimesSync(noise, old, old);
  }

  let paused = 0;
  const removed = await runSweep(
    root,
    temp,
    {
      entries: async function* (directory: string) {
        const { opendir } = await import("node:fs/promises");
        const handle = await opendir(directory);
        for await (const entry of handle) yield { name: entry.name, isDirectory: entry.isDirectory() };
      },
      modifiedAt: async (path: string) => {
        const { stat } = await import("node:fs/promises");
        try {
          return (await stat(path)).mtimeMs;
        } catch {
          return undefined;
        }
      },
      remove: async (path: string, recursive: boolean) => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { recursive, force: true });
      },
      now: () => Date.now(),
      pause: async () => {
        paused += 1;
      },
    },
    `${WIRE_NAMESPACE}-tasks-`,
  );

  expect(existsSync(join(stale, "t-old.0.log"))).toBe(false);
  // A young directory may belong to a session that is still writing.
  expect(existsSync(join(fresh, "t-new.0.log"))).toBe(true);
  // Every candidate was reached, not just the first slice of a listing.
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(running)).toBe(true);
  expect(removed).toBeGreaterThan(600);
  // And it yielded to the event loop rather than doing it all in one go.
  expect(paused).toBeGreaterThan(2);
  expect(STALE_LOG_AGE_MS).toBe(24 * 60 * 60 * 1000);
});
