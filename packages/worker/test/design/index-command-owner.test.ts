/**
 * Every index build is a visible, session-owned Command (M21-T10/T13
 * follow-up).
 *
 * The contract is `docs/design-phase.md` ("Re-index") and the leap's
 * "Outside the workspace → Fleet": a build runs as a Command with a budget
 * that the person can watch by files and stop. A build nobody can see is not
 * a build with a missing row — it is work that must not have started.
 *
 * These proofs are taken through a real `WorkerServer`, with the real
 * `ProjectWorkSession` the worker hands the driver, so what is asserted is
 * what actually reaches the fleet:
 *
 * - the model's `build_design_index` binds the conversation it is called in,
 *   and its rows are published to that session's path while it runs;
 * - Stop from a fleet row reaches the build even when no runtime answers for
 *   that conversation, and really ends it;
 * - a build with no owning conversation, and one naming a conversation this
 *   worker does not hold, are refused before a file is read;
 * - a conversation of another project can never own one, because it can never
 *   be opened here in the first place;
 * - while a build runs its conversation is pinned, so it cannot be released —
 *   and therefore cannot be deleted — with the build still going.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, type BackgroundTask, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import { indexPath } from "../../src/design/index/storage.js";
import { designCommandTaskId } from "../../src/design/workspace.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, SessionDriver } from "../../src/driver.js";
import type { ProjectWorkSession } from "../../src/project-work/session.js";
import { cleanupFixtures, copyFixture } from "./helpers.js";

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";

let base: string;
let projectCwd: string;

/** A driver that does nothing but remember what it was opened with. */
class CapturingDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  static opened: DriverOpenOptions[] = [];
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = {
    path: "",
    id: "",
    cwd: "",
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  async open(options: DriverOpenOptions) {
    CapturingDriver.opened.push(options);
    this.st = {
      ...this.st,
      path: options.sessionPath ?? join(base, "sessions", `s${String(CapturingDriver.opened.length)}.jsonl`),
      id: `id-${String(CapturingDriver.opened.length)}`,
      cwd: options.cwd,
    };
    return this.st;
  }
  state() {
    return this.st;
  }
  subscribe(listener: DriverListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: DriverEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async prompt() {
    return { accepted: true, queued: false };
  }
  async steer() {}
  async followUp() {}
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
  async abort() {}
  async listModels() {
    return [];
  }
  async setModel() {
    return this.st;
  }
  async setThinkingLevel() {
    return this.st;
  }
  async rename() {}
  async compact() {}
  async navigateTree() {
    return { cancelled: false };
  }
  async fork() {
    return { state: this.st };
  }
  respondToUi() {}
  async commands() {
    return [];
  }
  async prompts() {
    return [];
  }
  async entries() {
    return [];
  }
  async appendEntry() {
    return "e";
  }
  async dispose() {
    this.emit({ type: "closed", reason: "disposed" });
  }
}

function harness() {
  const out: JsonRpcMessage[] = [];
  CapturingDriver.opened = [];
  const server = new WorkerServer({
    cwd: projectCwd,
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new CapturingDriver(),
    send: (message) => out.push(message),
    projectWork: true,
    // No model on this machine: the build is the parse, which is what these
    // proofs are about, and nothing asks the network.
    designModels: async () => ({ getModel: () => undefined, completeSimple: async () => ({ content: [] }) }),
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    id += 1;
    const mine = id;
    await server.handle({ jsonrpc: "2.0", id: mine, method, params });
    return out.find((message) => "id" in message && message.id === mine) as { result?: unknown; error?: { code: number; message: string } };
  };
  return { server, call, out };
}

/** Every fleet row this worker published, in order. */
function rows(out: JsonRpcMessage[]): Array<{ path: string; task: BackgroundTask }> {
  const published: Array<{ path: string; task: BackgroundTask }> = [];
  for (const message of out) {
    if (!("method" in message) || message.method !== "pi/extension/message") continue;
    const params = message.params as { path: string; message: { type: string; task?: BackgroundTask } };
    if (params.message.type !== "lasercode/task/update" || !params.message.task) continue;
    published.push({ path: params.path, task: params.message.task });
  }
  return published;
}

function rowsFor(out: JsonRpcMessage[], commandId: string): Array<{ path: string; task: BackgroundTask }> {
  const id = designCommandTaskId(commandId);
  return rows(out).filter((entry) => entry.task.id === id);
}

/** Wait until this build's last published row is a terminal one. */
async function settled(out: JsonRpcMessage[], commandId: string): Promise<BackgroundTask> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const published = rowsFor(out, commandId);
    const last = published[published.length - 1]?.task;
    if (last && last.status !== "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the build ${commandId} never published a terminal row`);
}

/**
 * Open a session and take the `ProjectWorkSession` the driver was given, plus
 * the path that session really has.
 */
async function openSession(
  call: ReturnType<typeof harness>["call"],
  server: WorkerServer,
  out: JsonRpcMessage[],
): Promise<{ session: ProjectWorkSession; path: string }> {
  const opening = call("session/new", { cwd: projectCwd });
  const answered = new Set<string>();
  for (let attempt = 0; attempt < 200 && CapturingDriver.opened.length === 0; attempt += 1) {
    for (const message of out) {
      if (!("method" in message) || message.method !== "project/work/bridge" || !("id" in message)) continue;
      const id = String(message.id);
      if (answered.has(id)) continue;
      answered.add(id);
      server.hostResponse({
        jsonrpc: "2.0",
        id,
        result: { method: "project/work/list", result: { projectId: "prj_1", items: [] }, projectId: "prj_1" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const opened = (await opening) as { result?: { state?: { path?: string } } };
  const session = CapturingDriver.opened.at(-1)?.projectWork as ProjectWorkSession | undefined;
  expect(session, "the worker gives the driver this session's project-work surface").toBeDefined();
  const path = opened.result?.state?.path;
  expect(typeof path, "the new session has a file path").toBe("string");
  return { session: session!, path: path! };
}

/** Run `build_design_index` exactly as the model would. */
async function modelBuild(session: ProjectWorkSession, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const binding = session.designTools().find((tool) => tool.spec.name === "build_design_index");
  expect(binding, "a session with a design surface is offered build_design_index").toBeDefined();
  return (await binding!.run(input)) as Record<string, unknown>;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-design-owner-`));
  for (const directory of ["agent", "sessions", "state"]) mkdirSync(join(base, directory), { recursive: true });
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ modelProfiles: [] }));
  // Fifteen files: enough that the build yields between batches, so a row is
  // published while it is still reading and Stop has something to reach.
  projectCwd = copyFixture("react-tailwind");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  cleanupFixtures();
});

describe("the model's build_design_index", () => {
  it("binds the conversation it was called in, and publishes that session's fleet row before it ends", async () => {
    const { server, call, out } = harness();
    const { session, path } = await openSession(call, server, out);

    const answer = await modelBuild(session, { activity_label: "Indexing the design system" });
    const commandId = String(answer["commandId"]);
    expect(commandId).toMatch(/^cmd_/);
    expect(String(answer["note"])).toContain("fleet");

    // A row exists already, under this conversation, and it says the build is
    // running: the publication is before the work, not after it.
    const first = rowsFor(out, commandId)[0];
    expect(first?.path, "the row hangs under the session that asked for it").toBe(path);
    expect(first?.task.status).toBe("running");
    expect(first?.task.sessionPath).toBe(path);
    expect(first?.task.activity ?? "").not.toContain("%");

    const last = await settled(out, commandId);
    expect(last.status).toBe("completed");
    expect(last.endedAt).toBeDefined();
    expect(rowsFor(out, commandId).every((entry) => entry.path === path)).toBe(true);

    // And the workspace answers the window with the same owner.
    const read = (await call("design/index/get", { projectId: PROJECT_ID })) as {
      result?: { commands: Array<{ commandId: string; sessionPath: string }> };
    };
    expect(read.result?.commands.find((command) => command.commandId === commandId)?.sessionPath).toBe(path);
  });

  it("is stopped by the fleet row's own id, without a runtime answering for that conversation", async () => {
    const { server, call, out } = harness();
    const { session, path } = await openSession(call, server, out);
    const answer = await modelBuild(session);
    const commandId = String(answer["commandId"]);

    // Stop as the fleet sends it. The path is deliberately one this worker has
    // never opened: an index build is the worker's own loop, so Stop is
    // answered before any session runtime is looked up — which is what keeps a
    // released conversation's Command stoppable.
    const stopped = (await call("pi/task/stop", { path: "/not/open.jsonl", id: designCommandTaskId(commandId) })) as {
      result?: { delivered: boolean };
    };
    expect(stopped.result?.delivered).toBe(true);

    const last = await settled(out, commandId);
    expect(last.status).toBe("stopped");
    expect(last.sessionPath, "the owner is the one it was admitted with").toBe(path);
    expect(last.terminalReason).toBe("you stopped it");
  });

  it("pins the conversation while it runs, so it cannot be released — or deleted — underneath the build", async () => {
    const { server, call, out } = harness();
    const { session, path } = await openSession(call, server, out);
    const answer = await modelBuild(session);
    const commandId = String(answer["commandId"]);

    const refused = (await call("pi/session/unload", { path })) as { result?: { unloaded: boolean; pins: Array<{ kind: string }> } };
    expect(refused.result?.unloaded).toBe(false);
    expect(refused.result?.pins.map((pin) => pin.kind)).toContain("task");

    await settled(out, commandId);
    // Once it has ended it holds nothing: the build is no longer among the
    // reasons this conversation cannot be released.
    const after = (await call("pi/session/unload", { path })) as { result?: { pins: Array<{ kind: string }> } };
    expect(after.result?.pins.map((pin) => pin.kind) ?? []).not.toContain("task");
  });
});

describe("a build nobody would own", () => {
  it("cannot even be asked for without naming one: the method requires it", async () => {
    const { call, out } = harness();
    const refused = (await call("design/index/build", { projectId: PROJECT_ID })) as { error?: { code: number; message: string } };
    // The wire itself fences it (`sessionPath` is required on the method), so
    // a build with no owner is refused before the worker looks at anything.
    expect(refused.error?.message).toContain("design/index/build");
    expect(rows(out)).toEqual([]);
    expect(existsSync(indexPath(projectCwd)), "nothing was written").toBe(false);
  });

  it("is refused when it names a conversation this worker does not hold", async () => {
    const { call, out } = harness();
    const refused = (await call("design/index/build", { projectId: PROJECT_ID, sessionPath: join(base, "sessions", "ghost.jsonl") })) as {
      error?: { message: string };
    };
    expect(refused.error?.message).toMatch(/not open in this project/);
    expect(rows(out)).toEqual([]);
    expect(existsSync(indexPath(projectCwd))).toBe(false);
  });

  /**
   * The eligibility rule is "a conversation this worker holds", and this is
   * why that is also "a conversation of this project": a worker refuses to
   * open a session for any other directory, so a foreign-project session can
   * never be in the table the admission reads.
   */
  it("cannot be owned by another project's conversation, because none can be opened here", async () => {
    const { call } = harness();
    const elsewhere = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-other-project-`));
    try {
      const refused = (await call("session/new", { cwd: elsewhere })) as { error?: { message: string } };
      expect(refused.error?.message).toContain(`this worker serves ${projectCwd}`);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the person's build and the model's are the same admission", () => {
  it("takes the owning conversation from the request and publishes under it", async () => {
    const { server, call, out } = harness();
    const { path } = await openSession(call, server, out);
    const started = (await call("design/index/build", { projectId: PROJECT_ID, sessionPath: path })) as {
      result?: { command: { commandId: string; sessionPath: string; running: boolean } };
    };
    const command = started.result?.command;
    expect(command?.sessionPath).toBe(path);
    expect(rowsFor(out, command!.commandId)[0]?.path).toBe(path);
    const last = await settled(out, command!.commandId);
    expect(last.status).toBe("completed");
  });
});
