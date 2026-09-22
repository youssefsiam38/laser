/**
 * The research Command, through the real worker server (M21-T26).
 *
 * What only exists in `server.ts` is what this covers, and it covers it
 * through the server's own dispatch and the real `ProjectWorkSession` the
 * worker hands the driver — so what is asserted is what actually reaches the
 * fleet:
 *
 *   - the first research tool call of a turn publishes a fleet row under the
 *     conversation it was called in, as the same `lasercode/task/update`
 *     extension message every Command row travels on (M21-T13), into **this
 *     worker's own task index first** and the host's after it — which is why
 *     the conversation is pinned, cannot be unloaded and cannot be retired
 *     out from under a live research loop;
 *   - `pi/task/stop` with that row's id is delivered because this worker
 *     holds it, the row ends as *stopped*, and the loop's next tool call is
 *     refused with the sentence that tells the model to report what it found;
 *   - the turn ending settles the row, so nothing stays `running` under a
 *     conversation nobody is working in;
 *   - a conversation that closes while a research write is in flight keeps
 *     this worker alive until that write is done, and nothing is ever
 *     published under the path no runtime serves any more.
 *
 * Nothing here reaches the network: the only adapter used is `project`, which
 * reads this temporary project's own files, and the host link is answered by
 * hand one request at a time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, isResearchFleetTaskId, type BackgroundTask, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, SessionDriver } from "../../src/driver.js";
import type { ProjectWorkSession } from "../../src/project-work/session.js";

let base: string;
let projectCwd: string;

/** A driver that remembers what it was opened with, and can be crashed. */
class CapturingDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  static opened: DriverOpenOptions[] = [];
  static instances: CapturingDriver[] = [];
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
  constructor() {
    CapturingDriver.instances.push(this);
  }
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
    for (const listener of [...this.listeners]) listener(event);
  }
  /** The engine's runtime went away on its own: no unload, nothing prepared. */
  crash() {
    this.emit({ type: "closed", reason: "crashed" });
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
  async prepareRelease() {
    return { ok: true as const };
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

interface BridgeRequest {
  id: string;
  method: string;
}

function harness() {
  const out: JsonRpcMessage[] = [];
  CapturingDriver.opened = [];
  CapturingDriver.instances = [];
  const server = new WorkerServer({
    cwd: projectCwd,
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new CapturingDriver(),
    send: (message) => out.push(message),
    projectWork: true,
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    id += 1;
    const mine = id;
    await server.handle({ jsonrpc: "2.0", id: mine, method, params });
    return out.find((message) => "id" in message && message.id === mine) as { result?: unknown; error?: { code: number; message: string } };
  };
  const answered = new Set<string>();
  /** Host requests this worker has sent and nobody has answered yet. */
  const asked = (): BridgeRequest[] =>
    (out.filter((message) => "method" in message && "id" in message && typeof message.id === "string" && message.method === "project/work/bridge") as unknown as BridgeRequest[]).filter(
      (request) => !answered.has(request.id),
    );
  const answer = (result: unknown): void => {
    const request = asked()[0];
    expect(request, "the worker asked the host something").toBeDefined();
    answered.add(request!.id);
    server.hostResponse({ jsonrpc: "2.0", id: request!.id, result });
  };
  const rows = (): Array<{ path: string; task: BackgroundTask }> => {
    const published: Array<{ path: string; task: BackgroundTask }> = [];
    for (const message of out) {
      if (!("method" in message) || message.method !== "pi/extension/message") continue;
      const params = message.params as { path: string; message: { type: string; task?: BackgroundTask } };
      if (params.message.type !== "lasercode/task/update" || !params.message.task) continue;
      published.push({ path: params.path, task: params.message.task });
    }
    return published;
  };
  const researchRows = () => rows().filter((row) => isResearchFleetTaskId(row.task.id));
  return { server, out, call, rows, researchRows, asked, answer };
}

const turn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Open a session and take the project-work surface its driver was given. */
async function openSession(h: ReturnType<typeof harness>): Promise<{ session: ProjectWorkSession; path: string }> {
  const opening = h.call("session/new", { cwd: projectCwd });
  for (let attempt = 0; attempt < 200 && CapturingDriver.opened.length === 0; attempt += 1) {
    for (const request of h.asked()) {
      void request;
      h.answer({ method: "project/work/list", result: { projectId: "prj_1", items: [] }, projectId: "prj_1" });
    }
    await turn();
  }
  const opened = (await opening) as { result?: { state?: { path?: string } } };
  const session = CapturingDriver.opened.at(-1)?.projectWork as ProjectWorkSession | undefined;
  expect(session, "the worker gives the driver this session's project-work surface").toBeDefined();
  const path = opened.result?.state?.path;
  expect(typeof path).toBe("string");
  return { session: session!, path: path! };
}

/** Run one research tool exactly as the model would. */
function researchTool(session: ProjectWorkSession, name: string): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const binding = session.researchTools().find((tool) => tool.spec.name === name);
  expect(binding, `a session with research sources is offered ${name}`).toBeDefined();
  return (input) => binding!.run(input) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-research-command-`));
  for (const directory of ["agent", "sessions", "state"]) mkdirSync(join(base, directory), { recursive: true });
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ modelProfiles: [] }));
  projectCwd = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-research-project-`));
  writeFileSync(join(projectCwd, "notes.md"), "The reader uses a streaming parser for large documents.\n");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

describe("a research loop, as the worker dispatches it", () => {
  it("publishes a row under its own conversation and pins it while the loop is live", async () => {
    const h = harness();
    const { session, path } = await openSession(h);

    const answer = await researchTool(session, "search_sources")({ adapter: "project", query: "streaming parser" });
    expect(String(answer["budget"]), "the tool itself reports the spend it made").toContain("searches");

    const published = h.researchRows();
    expect(published.length, "the loop is visible the moment it starts").toBeGreaterThan(0);
    const first = published[0]!;
    expect(first.path, "under the conversation it runs in").toBe(path);
    expect(first.task.sessionPath).toBe(path);
    expect(first.task.status).toBe("running");
    expect(first.task.outputBytes, "the row is not a log").toBe(0);
    expect(first.task.activity).toContain("searches");
    expect(first.task.activity, "no percentage, no invented ETA").not.toContain("%");
    expect(JSON.stringify(published), "and no question text or source address on the row").not.toContain("streaming parser");

    // The row went into this worker's own fleet index before it went to the
    // host, which is what makes the conversation pinned: the same rule every
    // Command row already lives by.
    const safety = (await h.call("pi/worker/safety")).result as { sessions: Array<{ path: string; pins: Array<{ kind: string }> }> };
    expect(safety.sessions.find((entry) => entry.path === path)!.pins.map((pin) => pin.kind)).toContain("task");
    const unload = (await h.call("pi/session/unload", { path })).result as { unloaded: boolean; pins: Array<{ kind: string }> };
    expect(unload.unloaded, "a conversation with a live research loop is not released").toBe(false);
    const retire = (await h.call("pi/worker/retire", { mode: "explicit" })).result as { retiring: boolean; reason?: string };
    expect(retire.retiring, "nor is the worker retired out from under it").toBe(false);
    expect(retire.reason).toBe("pinned");
  });

  it("is stopped from its own fleet row, and the loop's next call is refused", async () => {
    const h = harness();
    const { session, path } = await openSession(h);
    await researchTool(session, "search_sources")({ adapter: "project", query: "streaming parser" });
    const rowId = h.researchRows()[0]!.task.id;

    const stopped = (await h.call("pi/task/stop", { path, id: rowId })).result as { delivered: boolean } | undefined;
    expect(stopped?.delivered, "this worker holds that row").toBe(true);

    const ended = h.researchRows().at(-1)!.task;
    expect(ended.status).toBe("stopped");
    expect(ended.endedAt).toBeDefined();
    expect(ended.terminalReason).toContain("You stopped it");
    expect(ended.terminalReason).toContain("already recorded are kept");

    // The run ends on a refusal the model can report, not on a killed
    // process: the next call says what happened and what to do instead.
    await expect(researchTool(session, "search_sources")({ adapter: "project", query: "something else" })).rejects.toThrow(/stopped/i);

    // A row id nobody here holds is said so.
    const unknown = (await h.call("pi/task/stop", { path, id: "research-res_9999" })).result as { delivered: boolean } | undefined;
    expect(unknown?.delivered).toBe(false);

    // And with the loop over, the conversation is free again.
    const unload = (await h.call("pi/session/unload", { path })).result as { unloaded: boolean; pins: unknown[] };
    expect(unload.pins).toEqual([]);
    expect(unload.unloaded).toBe(true);
  });

  it("settles the row when the turn that was running the loop ends", async () => {
    const h = harness();
    const { session, path } = await openSession(h);
    await researchTool(session, "search_sources")({ adapter: "project", query: "streaming parser" });
    expect(h.researchRows().at(-1)!.task.status).toBe("running");

    CapturingDriver.instances[0]!.emit({ type: "update", update: { kind: "agent_settled" } });
    const ended = h.researchRows().at(-1)!.task;
    expect(ended.status, "the loop is the agent's own turn, so its end is the run's").toBe("completed");
    expect(ended.terminalReason).toContain("The turn this research ran in ended");
    expect(ended.endedAt).toBeDefined();

    const unload = (await h.call("pi/session/unload", { path })).result as { unloaded: boolean; pins: unknown[] };
    expect(unload.pins, "nothing stays running under a conversation nobody is working in").toEqual([]);
    expect(unload.unloaded).toBe(true);
  });

  it("keeps this worker alive while a research write is still in flight after its conversation closed", async () => {
    const h = harness();
    const { session, path } = await openSession(h);
    // A write the host has not answered yet: this is the case where ending
    // the process would cut a project's own record in half.
    const writing = researchTool(session, "resolve_question")({
      research_ref: "RES-1",
      expected_revision_id: "rev_1",
      idempotency_key: "k1",
      question_id: "q1",
      state: "answered",
    }).catch(() => undefined);
    await turn();
    expect(h.asked().length, "the write is with the host and unanswered").toBeGreaterThan(0);
    const before = h.researchRows().length;
    expect(before).toBeGreaterThan(0);

    CapturingDriver.instances[0]!.crash();
    const safety = (await h.call("pi/worker/safety")).result as { sessions: Array<{ path: string; pins: Array<{ kind: string; detail?: string }> }> };
    const owed = safety.sessions.find((entry) => entry.path === path);
    expect(owed, "work this worker still owes is not invisible because a driver closed").toBeDefined();
    expect(owed!.pins.map((pin) => pin.kind)).toContain("task");
    expect(owed!.pins.map((pin) => pin.detail ?? "").join(" ")).toContain("research run");
    const refused = (await h.call("pi/worker/retire", { mode: "explicit" })).result as { retiring: boolean; reason?: string };
    expect(refused.retiring).toBe(false);
    expect(refused.reason).toBe("pinned");

    // The host answers, the write finishes, and the run settles privately.
    h.answer({ method: "project/work/get", error: { code: -32602, message: "no such research" } });
    await writing;
    await turn();
    expect(h.researchRows().length, "nothing is published under a path no runtime serves, not even its ending").toBe(before);

    const after = (await h.call("pi/worker/safety")).result as { sessions: Array<{ path: string }> };
    expect(after.sessions.some((entry) => entry.path === path)).toBe(false);
    const retire = (await h.call("pi/worker/retire", { mode: "explicit" })).result as { retiring: boolean };
    expect(retire.retiring, "the worker retires once the work it owed is really done").toBe(true);
  });
});
