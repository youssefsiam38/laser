/**
 * The review corrections for the owned-Command branch (M21-T10/T13 review):
 * a fork that moves the owning conversation's file (F2), a settlement
 * observer that throws (F1), and a failure sentence too long for a row (F3).
 *
 * F2, the one with a behaviour change:
 *
 * The owner of a build is decided once, at admission, and is never re-derived
 * from whatever conversation is current — that is the rule the ownership
 * branch established and these proofs keep. What a fork changes is the
 * *address* of that same conversation: its file moves, the worker re-keys
 * everything it holds under the old path, and until this correction the design
 * structures were not in that list. The row kept being published under a path
 * no runtime serves, the moved conversation kept a `running` row it could
 * never lose, and an unload that should have been allowed was refused for ever.
 *
 * Taken through a real `WorkerServer` and its real `pi/session/fork` →
 * `rekeySessionState` seam, with the real design workspace, index and build
 * engine. The **only** stub is the session driver at the engine boundary (no
 * Pi runtime in a unit test): its `fork` moves the session file exactly as the
 * real driver's does, which is the one thing the seam reads.
 *
 * What is asserted, for one build that is running across the fork:
 *
 * - the current row is published under the new path, and the old path is never
 *   published to again;
 * - the worker's own task index keeps the row — and the `task` pin — at the
 *   new path, so `pi/session/unload` still refuses while the build runs;
 * - `design/index/get` (the workspace's projection) and the index's own
 *   `owner()` both answer the new path, for the running build and for a
 *   finished one alike;
 * - Stop from the fleet row still reaches the build after the move;
 * - settlement publishes its terminal row at the new path — *stopped*, in the
 *   person's own words, because that is what happened — and clears the pin;
 * - a build owned by another conversation is untouched by the fork.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, type BackgroundTask, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import { FINISHED_COMMANDS_KEPT, ProjectDesignIndex } from "../../src/design/index/bridge.js";
import { DesignWorkspace, designCommandTaskId } from "../../src/design/workspace.js";
import type { CompletionRuntime } from "../../src/agents/session-naming.js";
import type { DesignBuildCommand, DesignBuildProgress, DesignBuildResult } from "../../src/design/index/command.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, SessionDriver } from "../../src/driver.js";
import { cleanupFixtures, copyFixture } from "./helpers.js";

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";
const DESIGN_PROFILE = "mp_testdesign00000000000";

let base: string;
let projectCwd: string;

/**
 * The driver stub, at the engine boundary.
 *
 * It holds no Pi runtime — a unit test has none — and does exactly two things
 * the seam under test reads: it remembers what it was opened with, and its
 * `fork` moves the session to a new file, which is what makes the server
 * re-key everything held under the old path.
 */
class ForkingDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  static opened: DriverOpenOptions[] = [];
  /** Where the next fork lands, in the order the tests fork. */
  static forkTargets: string[] = [];
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
    ForkingDriver.opened.push(options);
    this.st = {
      ...this.st,
      path: options.sessionPath ?? join(base, "sessions", `s${String(ForkingDriver.opened.length)}.jsonl`),
      id: `id-${String(ForkingDriver.opened.length)}`,
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
  /** A fork that really moves the file, which is what the re-key seam reads. */
  async fork() {
    const target = ForkingDriver.forkTargets.shift();
    if (target !== undefined) this.st = { ...this.st, path: target };
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

/**
 * A worker with a Design profile whose model answers only when the test lets
 * it, so a build is genuinely still working — at the describing step, after a
 * real scan of a real fixture — for as long as a proof needs it to be.
 */
function harness() {
  const out: JsonRpcMessage[] = [];
  ForkingDriver.opened = [];
  ForkingDriver.forkTargets = [];
  writeFileSync(
    join(base, "agent", "settings.json"),
    JSON.stringify({
      modelProfiles: [{ id: DESIGN_PROFILE, name: "Design", models: [{ provider: "stub", id: "stub-1" }], origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" }],
      designIndexProfileId: DESIGN_PROFILE,
    }),
  );
  let release!: (runtime: CompletionRuntime) => void;
  const models = new Promise<CompletionRuntime>((resolve) => {
    release = resolve;
  });
  const server = new WorkerServer({
    cwd: projectCwd,
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new ForkingDriver(),
    send: (message) => out.push(message),
    designModels: () => models,
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    id += 1;
    const mine = id;
    await server.handle({ jsonrpc: "2.0", id: mine, method, params });
    return out.find((message) => "id" in message && message.id === mine) as { result?: unknown; error?: { code: number; message: string } };
  };
  return {
    server,
    call,
    out,
    /** Let every build past the describing step, so they settle for real. */
    answerTheModel: () => {
      release({ getModel: (provider, model) => ({ provider, id: model }), completeSimple: async () => ({ content: [{ type: "text", text: "{}" }] }) });
    },
  };
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
async function settled(out: JsonRpcMessage[], commandId: string): Promise<{ path: string; task: BackgroundTask }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const published = rowsFor(out, commandId);
    const last = published[published.length - 1];
    if (last && last.task.status !== "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the build ${commandId} never published a terminal row`);
}

/** Open one conversation in this project and answer the host as the host does. */
async function openSession(call: ReturnType<typeof harness>["call"], server: WorkerServer, out: JsonRpcMessage[]): Promise<string> {
  const before = ForkingDriver.opened.length;
  const opening = call("session/new", { cwd: projectCwd });
  const answered = new Set<string>();
  for (let attempt = 0; attempt < 200 && ForkingDriver.opened.length === before; attempt += 1) {
    for (const message of out) {
      if (!("method" in message) || message.method !== "project/work/bridge" || !("id" in message)) continue;
      const id = String(message.id);
      if (answered.has(id)) continue;
      answered.add(id);
      server.hostResponse({ jsonrpc: "2.0", id, result: { method: "project/work/list", result: { projectId: "prj_1", items: [] }, projectId: "prj_1" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const opened = (await opening) as { result?: { state?: { path?: string } } };
  const path = opened.result?.state?.path;
  expect(typeof path, "the conversation opened and has a file").toBe("string");
  return path!;
}

/** Start a build owned by that conversation, and wait until it is really working. */
async function startBuild(call: ReturnType<typeof harness>["call"], out: JsonRpcMessage[], sessionPath: string): Promise<string> {
  const started = (await call("design/index/build", { projectId: PROJECT_ID, sessionPath })) as {
    result?: { command: { commandId: string } };
    error?: { message: string };
  };
  expect(started.error, JSON.stringify(started.error)).toBeUndefined();
  const commandId = started.result!.command.commandId;
  // Wait for the describing step: the model this harness gives the worker does
  // not answer until the test says so, so from here the build is genuinely
  // running until then — no timing window to lose.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (rowsFor(out, commandId).some((entry) => entry.task.activity?.includes("Describing") === true)) return commandId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the build never reached the step where it waits for a model");
}

/** What this worker says is holding one conversation. */
async function pinsOf(call: ReturnType<typeof harness>["call"], path: string): Promise<string[]> {
  const safety = (await call("pi/worker/safety")) as { result?: { sessions: Array<{ path: string; pins: Array<{ kind: string }> }> } };
  return safety.result?.sessions.find((session) => session.path === path)?.pins.map((pin) => pin.kind) ?? [];
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-design-rekey-`));
  for (const directory of ["agent", "sessions", "state"]) mkdirSync(join(base, directory), { recursive: true });
  projectCwd = copyFixture("react-tailwind");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  cleanupFixtures();
});

describe("an index build whose conversation is forked to a new file", () => {
  it("follows the conversation: new path published, old path never again, pin and Stop still reach it", async () => {
    const { server, call, out, answerTheModel } = harness();
    const source = await openSession(call, server, out);
    const commandId = await startBuild(call, out, source);

    const beforeFork = rowsFor(out, commandId);
    expect(beforeFork.length, "a running row exists under the conversation that started it").toBeGreaterThan(0);
    expect(beforeFork.every((entry) => entry.path === source)).toBe(true);
    expect(beforeFork[beforeFork.length - 1]?.task.status).toBe("running");
    const rowsSeenBeforeFork = rows(out).length;

    // The fork, through the real request: the driver moves the file and the
    // server re-keys everything it holds under the old path.
    const forked = join(base, "sessions", "forked.jsonl");
    ForkingDriver.forkTargets = [forked];
    const answer = (await call("pi/session/fork", { path: source, entryId: "e1" })) as { result?: { state?: { path?: string } }; error?: { message: string } };
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    expect(answer.result?.state?.path, "the conversation now lives in the forked file").toBe(forked);

    // The row moved with it, and nothing is ever published under the old path
    // again — not a progress report, and not the terminal row.
    const afterFork = rows(out).slice(rowsSeenBeforeFork).filter((entry) => entry.task.id === designCommandTaskId(commandId));
    expect(afterFork.length, "the moved build republishes its row at once").toBeGreaterThan(0);
    expect(afterFork.every((entry) => entry.path === forked)).toBe(true);
    expect(afterFork[0]?.task.sessionPath).toBe(forked);
    expect(afterFork[0]?.task.status).toBe("running");

    // The workspace's projection says the same, and so does the fleet index:
    // the conversation that exists is pinned, and cannot be released.
    const read = (await call("design/index/get", { projectId: PROJECT_ID })) as { result?: { commands: Array<{ commandId: string; sessionPath: string; running: boolean }> } };
    const projected = read.result?.commands.find((command) => command.commandId === commandId);
    expect(projected?.sessionPath).toBe(forked);
    expect(projected?.running).toBe(true);
    expect(await pinsOf(call, forked)).toContain("task");
    expect(await pinsOf(call, source), "nothing is held under a path no runtime serves").not.toContain("task");

    const refused = (await call("pi/session/unload", { path: forked })) as { result?: { unloaded: boolean; pins: Array<{ kind: string }> } };
    expect(refused.result?.unloaded, "a running build still refuses to let its conversation go").toBe(false);
    expect(refused.result?.pins.map((pin) => pin.kind)).toContain("task");

    // Stop from the fleet row still finds it after the move: the row's id is
    // the build's, not the session's.
    const stopped = (await call("pi/task/stop", { path: forked, id: designCommandTaskId(commandId) })) as { result?: { delivered: boolean } };
    expect(stopped.result?.delivered).toBe(true);

    // Settlement lands where the conversation is now, and releases the pin.
    //
    // And it says what really happened: the person stopped this build while it
    // was waiting for its model, so the terminal row is *stopped* in their own
    // words — not "completed" because the descriptions came back afterwards.
    answerTheModel();
    const last = await settled(out, commandId);
    expect(last.path).toBe(forked);
    expect(last.task.sessionPath).toBe(forked);
    expect(last.task.status, "a build the person stopped is stopped, whatever arrived after").toBe("stopped");
    expect(last.task.terminalReason).toBe("you stopped it");
    expect(rowsFor(out, commandId).some((entry) => entry.task.status === "completed"), "no row ever said it finished").toBe(false);
    expect(last.task.endedAt).toBeDefined();
    expect(rowsFor(out, commandId).filter((entry) => entry.path === source).every((entry) => entry.task.status === "running")).toBe(true);
    expect(await pinsOf(call, forked), "a build that has ended holds nothing").not.toContain("task");

    const after = (await call("design/index/get", { projectId: PROJECT_ID })) as { result?: { commands: Array<{ commandId: string; sessionPath: string; running: boolean }> } };
    const finished = after.result?.commands.find((command) => command.commandId === commandId);
    expect(finished?.running, "the build really ended").toBe(false);
    expect(finished?.sessionPath, "a finished build's row belongs to the conversation that owns it now").toBe(forked);

    const released = (await call("pi/session/unload", { path: forked })) as { result?: { pins: Array<{ kind: string }> } };
    expect(released.result?.pins.map((pin) => pin.kind) ?? []).not.toContain("task");
  });

  it("leaves another conversation's build exactly where it was", async () => {
    const { server, call, out, answerTheModel } = harness();
    const source = await openSession(call, server, out);
    const other = await openSession(call, server, out);
    expect(other).not.toBe(source);
    const mine = await startBuild(call, out, source);
    const theirs = await startBuild(call, out, other);

    const forked = join(base, "sessions", "forked-2.jsonl");
    ForkingDriver.forkTargets = [forked];
    const seen = rows(out).length;
    await call("pi/session/fork", { path: source, entryId: "e1" });

    // One conversation moved; the other did not, and neither did its build.
    const afterFork = rows(out).slice(seen);
    expect(afterFork.filter((entry) => entry.task.id === designCommandTaskId(theirs)).every((entry) => entry.path === other)).toBe(true);
    const read = (await call("design/index/get", { projectId: PROJECT_ID })) as { result?: { commands: Array<{ commandId: string; sessionPath: string }> } };
    const owners = new Map(read.result?.commands.map((command) => [command.commandId, command.sessionPath]));
    expect(owners.get(mine)).toBe(forked);
    expect(owners.get(theirs)).toBe(other);
    expect(await pinsOf(call, other)).toContain("task");

    answerTheModel();
    const mineLast = await settled(out, mine);
    const theirsLast = await settled(out, theirs);
    expect(mineLast.path).toBe(forked);
    expect(theirsLast.path).toBe(other);
  });
});

/**
 * The same transition, at the two structures the server moves, without a
 * server in the way: the index's recorded owner and the workspace's tracked
 * address are one canonical step, and the argument the admission was called
 * with is never written to.
 */
describe("the canonical rekey, on the design structures themselves", () => {
  function fixture() {
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    let workspace!: DesignWorkspace;
    const commands = new Map<string, { command: DesignBuildCommand; settle: () => void }>();
    let next = 0;
    const engine = {
      startBuild: async (input: { owner: { sessionPath: string } }) => {
        next += 1;
        const id = `cmd-${String(next)}`;
        let phase: "scanning" | "done" = "scanning";
        const progress = (): DesignBuildProgress => ({ phase, filesParsed: 1, filesFound: 1, filesFromCache: 0, elapsedMs: 1 });
        const owners = new Map<string, { sessionPath: string }>();
        owners.set(id, input.owner);
        const held = {
          command: { id, title: `Build ${id}`, progress, stop: () => {}, done: new Promise<DesignBuildResult>(() => {}) } as unknown as DesignBuildCommand,
          settle: () => {
            phase = "done";
            workspace.observeSettled(held.command, owners.get(id)!, { kind: "done", result: { progress: progress(), stopped: false } as unknown as DesignBuildResult });
          },
        };
        commands.set(id, held);
        workspace.observeCommand(held.command, input.owner);
        return { commandId: id, title: held.command.title, appRoot: "." };
      },
      command: (id: string) => commands.get(id)?.command,
      index: async () => undefined,
      stop: () => false,
    };
    workspace = new DesignWorkspace({
      projectCwd: "/project",
      index: () => engine as never,
      grounding: () => ({}) as never,
      publishTask: (path, task) => published.push({ path, task }),
      holdsSession: () => true,
    });
    return { workspace, published, commands };
  }

  it("moves a running build's address and republishes it, and leaves a finished one's row where the fleet can still read it", async () => {
    const { workspace, published, commands } = fixture();
    const running = (await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s/old.jsonl" })).command.commandId;
    const finished = (await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s/old.jsonl" })).command.commandId;
    const elsewhere = (await workspace.build({ projectId: PROJECT_ID, sessionPath: "/s/other.jsonl" })).command.commandId;
    commands.get(finished)!.settle();
    const before = published.length;

    workspace.rekeySession("/s/old.jsonl", "/s/new.jsonl");

    const moved = published.slice(before);
    expect(moved.map((entry) => entry.task.id), "only what is still running republishes").toEqual([designCommandTaskId(running)]);
    expect(moved[0]?.path).toBe("/s/new.jsonl");
    expect(moved[0]?.task.status).toBe("running");

    const listed = new Map((await workspace.get({ projectId: PROJECT_ID })).commands.map((command) => [command.commandId, command.sessionPath]));
    expect(listed.get(running)).toBe("/s/new.jsonl");
    expect(listed.get(finished), "a build that has ended belongs to the same conversation, at its new address").toBe("/s/new.jsonl");
    expect(listed.get(elsewhere), "another conversation's build is untouched").toBe("/s/other.jsonl");
  });

  it("replaces the index's recorded owner instead of writing into the object the admission was given", async () => {
    const index = new ProjectDesignIndex({ projectCwd, stateDir: join(base, "state"), projectKey: "fixture" });
    const owner = Object.freeze({ sessionPath: "/s/old.jsonl" });
    const started = await index.startBuild({ rebuild: false, maxFiles: 1, owner });

    index.rekeySession("/s/old.jsonl", "/s/new.jsonl");

    expect(index.owner(started.commandId)?.sessionPath).toBe("/s/new.jsonl");
    expect(owner.sessionPath, "the caller's admission argument is still its own").toBe("/s/old.jsonl");

    // A path this project never owned moves nothing.
    index.rekeySession("/s/ghost.jsonl", "/s/other.jsonl");
    expect(index.owner(started.commandId)?.sessionPath).toBe("/s/new.jsonl");
    index.stop(started.commandId);
    await index.wait(started.commandId);
  });
});

/**
 * A settlement observer that throws (review F1).
 *
 * The row is lost either way — that is the observer's failure, not this
 * class's — but it must not be lost *silently*, and it must not leave every
 * finished build in this worker held for the life of the process.
 */
describe("when the settlement observer throws", () => {
  it("says so once, without the exception's own words, and still bounds what it holds", async () => {
    const lines: string[] = [];
    const index = new ProjectDesignIndex({
      projectCwd,
      stateDir: join(base, "state"),
      projectKey: "fixture",
      log: (line) => lines.push(line),
      onSettled: () => {
        throw new Error(`secret: ${join(projectCwd, "src", "private.tsx")}`);
      },
    });

    const ids: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = await index.startBuild({ rebuild: false, maxFiles: 1, owner: { sessionPath: "/s/a.jsonl" } });
      ids.push(started.commandId);
      await index.wait(started.commandId);
    }

    expect(lines.length, "one line per lost row, and nothing retried").toBe(ids.length);
    for (const line of lines) {
      expect(line).toContain("settlement");
      expect(line).toContain("Error");
      expect(line, "never the exception's message, which can carry a path this build read").not.toContain("secret");
      expect(line).not.toContain("private.tsx");
      expect(line.length).toBeLessThanOrEqual(200);
    }
    expect(lines.some((line) => line.includes(ids[0]!)), "the line names the build whose row was lost").toBe(true);
    expect(lines[0]).not.toContain("\n");
    // The bound still holds: a thrown observer cannot pin every finished build.
    expect(index.commands().length).toBe(FINISHED_COMMANDS_KEPT);
  });
});

/**
 * A failure long enough to be cut (review F3).
 *
 * A row shows a sentence, so it is cut where a reader would cut it: a hard
 * slice ends mid-word and reads as a rendering fault rather than as a long
 * message.
 */
describe("a failure sentence too long for a row", () => {
  it("is cut at a word, and says it was cut", () => {
    const published: BackgroundTask[] = [];
    const workspace = new DesignWorkspace({
      projectCwd: "/project",
      index: () => ({ index: async () => undefined, command: () => undefined, stop: () => false }) as never,
      grounding: () => ({}) as never,
      publishTask: (_path, task) => published.push(task),
      holdsSession: () => true,
    });
    const command = {
      id: "cmd-long",
      title: "Build cmd-long",
      progress: () => ({ phase: "scanning", filesParsed: 0, filesFound: 0, filesFromCache: 0, elapsedMs: 0 }),
      stop: () => {},
      done: new Promise<DesignBuildResult>(() => {}),
    } as unknown as DesignBuildCommand;
    const owner = { sessionPath: "/s/a.jsonl" };
    workspace.observeCommand(command, owner);

    const words = Array.from({ length: 120 }, (_, index) => `word${String(index)}`).join(" ");
    workspace.observeSettled(command, owner, { kind: "failed", error: new Error(`${words}.`) });

    const whole = `${words}.`;
    const failure = published[published.length - 1]?.error ?? "";
    expect(failure.length).toBeLessThanOrEqual(500);
    expect(failure.endsWith("\u2026")).toBe(true);
    const kept = failure.slice(0, -1);
    expect(whole.startsWith(kept), "what is shown is the sentence's own beginning").toBe(true);
    expect(kept.endsWith(" "), "trimmed, not left hanging on a space").toBe(false);
    // The cut fell between words: the character after what was kept is a space.
    expect(whole[kept.length]).toBe(" ");
    expect(kept.length).toBeGreaterThan(400);
  });
});
