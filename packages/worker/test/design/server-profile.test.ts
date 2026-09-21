/**
 * The Design profile, wired (M21-T14 follow-up).
 *
 * T14 and T10 both landed their engines with the profile left unpassed, so
 * every synthesis and every foundation step on every machine was the honest
 * fallback. These are the proofs that it is wired now, taken through
 * `WorkerServer` itself rather than around it:
 *
 * - a real settings file with `designIndexProfileId` → `design/index/build`
 *   asks exactly that profile's model, and the built index records it;
 * - a machine with no profile asks nothing and says why, in the index's gaps;
 * - the `ProjectWorkSession` the server hands the driver proposes a
 *   foundation on the same profile, and falls back to the neutral foundation
 *   with the reason when there is nothing to ask.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, type DesignIndex, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { WorkerServer } from "../../src/server.js";
import type { CompletionContext, CompletionResult, CompletionRuntime } from "../../src/agents/session-naming.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, SessionDriver } from "../../src/driver.js";
import type { ProjectWorkSession } from "../../src/project-work/session.js";
import { copyFixture, cleanupFixtures } from "./helpers.js";

const DESIGN_PROFILE = "mp_testdesign00000000000";
const OTHER_PROFILE = "mp_testdefault0000000000";

let base: string;
let projectCwd: string;

interface Asked {
  provider: string;
  model: string;
  context: CompletionContext;
}

type Answer = string | ((context: CompletionContext) => string);

/** A runtime that answers for exactly the models it was given, and records who asked. */
function runtime(answers: Record<string, Answer>): { runtime: CompletionRuntime; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    runtime: {
      getModel: (provider, id) => (answers[id] === undefined ? undefined : { provider, id }),
      completeSimple: async (model, context): Promise<CompletionResult> => {
        asked.push({ provider: model.provider, model: model.id, context });
        const answer = answers[model.id];
        return { content: [{ type: "text", text: typeof answer === "function" ? answer(context) : (answer ?? "") }] };
      },
    },
  };
}

/**
 * A synthesis answer that cites facts this parse really produced: the brief
 * lists them, and an item citing anything else is dropped by the citation
 * rule rather than shown.
 */
function philosophyCitingTheBrief(text: string): (context: CompletionContext) => string {
  return (context) => {
    const brief = context.messages.map((message) => message.content).join("\n");
    const ids = [...brief.matchAll(/^- (f_[A-Za-z0-9]+) · /gm)].map((match) => match[1]!);
    return JSON.stringify({ philosophy: { text, cites: ids.slice(0, 2) } });
  };
}

function profile(id: string, name: string, model: string) {
  return { id, name, models: [{ provider: "stub", id: model }], origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** The settings file a machine with both profiles has. */
function writeSettings(doc: Record<string, unknown>): void {
  mkdirSync(join(base, "agent"), { recursive: true });
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify(doc));
}

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
    this.st = { ...this.st, path: options.sessionPath ?? join(base, "sessions", `s${String(CapturingDriver.opened.length)}.jsonl`), id: "id-1", cwd: options.cwd };
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

function harness(designRuntime: CompletionRuntime, options: { projectWork?: boolean } = {}) {
  const out: JsonRpcMessage[] = [];
  CapturingDriver.opened = [];
  const server = new WorkerServer({
    cwd: projectCwd,
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => new CapturingDriver(),
    send: (message) => out.push(message),
    designModels: async () => designRuntime,
    ...(options.projectWork === true ? { projectWork: true } : {}),
  });
  const call = async (id: number, method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  return { server, call, out };
}

const PROJECT_ID = "pw_9f2c1a0400000000000000000000";

/**
 * Build the index and wait for the command to finish.
 *
 * A build belongs to a conversation — it is a Command the person watches and
 * stops — so one is opened first and owns it, exactly as the window does.
 */
async function buildIndex(call: ReturnType<typeof harness>["call"]): Promise<DesignIndex | undefined> {
  const opened = (await call(1, "session/new", { cwd: projectCwd })) as { result?: { state?: { path?: string } } };
  const sessionPath = opened.result?.state?.path;
  expect(typeof sessionPath, "the owning conversation opened").toBe("string");
  const started = await call(2, "design/index/build", { projectId: PROJECT_ID, sessionPath });
  expect(started.error, JSON.stringify(started.error)).toBeUndefined();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const answer = (await call(100 + attempt, "design/index/get", { projectId: PROJECT_ID })) as {
      result?: { state: string; index?: DesignIndex; commands: Array<{ running: boolean }> };
    };
    const result = answer.result;
    if (result && result.commands.every((command) => !command.running) && result.index) return result.index;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-design-profile-`));
  for (const directory of ["agent", "sessions", "state"]) mkdirSync(join(base, directory), { recursive: true });
  projectCwd = copyFixture("vue-scss");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  cleanupFixtures();
});

describe("design/index/build, on the profile the person configured", () => {
  it("asks the assigned profile's model and records it on the index", async () => {
    writeSettings({
      modelProfiles: [profile(OTHER_PROFILE, "Balanced", "balanced-1"), profile(DESIGN_PROFILE, "Smart", "smart-1")],
      defaultProfileId: OTHER_PROFILE,
      designIndexProfileId: DESIGN_PROFILE,
    });
    const { runtime: stub, asked } = runtime({
      "smart-1": philosophyCitingTheBrief("Quiet, dense, and typographic."),
      "balanced-1": "{}",
    });
    const { call } = harness(stub);
    const index = await buildIndex(call);
    expect(index, "the build finished and the index was read back").toBeDefined();
    // The configured profile, and only it: the default is never asked.
    expect(asked.map((one) => one.model)).toEqual(["smart-1"]);
    expect(index?.builtWith?.profileId).toBe(DESIGN_PROFILE);
    expect(index?.builtWith?.model).toBe("smart-1");
    expect(index?.builtWith?.layers).toEqual(["l0", "l1"]);
    // What was asked for is the parse, not the repository's code.
    expect(asked[0]?.context.systemPrompt).toContain("JSON only");
  });

  it("inherits the default profile when nothing is assigned to design work", async () => {
    writeSettings({ modelProfiles: [profile(OTHER_PROFILE, "Balanced", "balanced-1")], defaultProfileId: OTHER_PROFILE });
    const { runtime: stub, asked } = runtime({ "balanced-1": philosophyCitingTheBrief("Plain and legible.") });
    const { call } = harness(stub);
    const index = await buildIndex(call);
    expect(asked.map((one) => one.model)).toEqual(["balanced-1"]);
    expect(index?.builtWith?.profileId).toBe(OTHER_PROFILE);
  });

  it("asks nothing and says why when the machine has no profile", async () => {
    writeSettings({ modelProfiles: [] });
    const { runtime: stub, asked } = runtime({ "smart-1": "{}" });
    const { call } = harness(stub);
    const index = await buildIndex(call);
    expect(asked).toEqual([]);
    expect(index?.builtWith?.layers).toEqual(["l0"]);
    expect(index?.gaps.some((gap) => gap.reason.includes("No model profile is connected for design work"))).toBe(true);
    // The index is still the parse's own truth, written where it belongs.
    const stored = JSON.parse(readFileSync(join(projectCwd, `.${PRODUCT_NAME}`, "design", "index.json"), "utf8")) as DesignIndex;
    expect(stored.entries.length).toBeGreaterThan(0);
  });
});

describe("the session the server hands the driver", () => {
  /** Open a session and take the `ProjectWorkSession` the driver was given. */
  async function openSession(call: ReturnType<typeof harness>["call"], server: WorkerServer, out: JsonRpcMessage[]): Promise<ProjectWorkSession> {
    const opening = call(1, "session/new", { cwd: projectCwd });
    // The session asks the host which project it belongs to before its tools
    // are registered; the host's answer is what gives it a project id.
    for (let attempt = 0; attempt < 200 && CapturingDriver.opened.length === 0; attempt += 1) {
      const request = out.find((message) => "method" in message && message.method === "project/work/bridge" && "id" in message) as
        | { id: string }
        | undefined;
      if (request) {
        server.hostResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { method: "project/work/list", result: { projectId: "prj_1", items: [] }, projectId: "prj_1" },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await opening;
    const session = CapturingDriver.opened.at(-1)?.projectWork as ProjectWorkSession | undefined;
    expect(session, "the worker gives the driver this session's project-work surface").toBeDefined();
    return session!;
  }

  /** Run `propose_foundation`, answering the host's writes as the host would. */
  async function proposeFirstStep(
    server: WorkerServer,
    session: ProjectWorkSession,
    out: JsonRpcMessage[],
  ): Promise<Record<string, unknown>> {
    const binding = session.designTools().find((tool) => tool.spec.name === "propose_foundation");
    expect(binding, "propose_foundation is offered to a session with a project and a design surface").toBeDefined();
    const running = binding!.run({ idempotency_key: "idem-1", product: "a reading app" }) as Promise<Record<string, unknown>>;
    const answered = new Set<string>();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      for (const message of out) {
        if (!("method" in message) || message.method !== "project/work/bridge" || !("id" in message)) continue;
        const id = String(message.id);
        if (answered.has(id)) continue;
        answered.add(id);
        const forwarded = (message.params as { request?: { method?: string } }).request?.method;
        if (forwarded !== "project/work/create") continue;
        server.hostResponse({
          jsonrpc: "2.0",
          id,
          result: {
            method: "project/work/create",
            projectId: "prj_1",
            result: {
              ref: {},
              entity: { entityId: "e_des", key: "DES-1", kind: "design", title: "Design foundation" },
              revision: { index: 1, revisionId: "r1", digest: "a".repeat(64) },
              seq: 1,
            },
          },
        });
      }
      const settled = await Promise.race([running.then((value) => ({ value })), new Promise((resolve) => setTimeout(() => resolve(undefined), 5))]);
      if (settled && typeof settled === "object" && "value" in settled) return settled.value as Record<string, unknown>;
    }
    return await running;
  }

  it("proposes a foundation on the profile the person configured for design work", async () => {
    writeSettings({
      modelProfiles: [profile(OTHER_PROFILE, "Balanced", "balanced-1"), profile(DESIGN_PROFILE, "Smart", "smart-1")],
      defaultProfileId: OTHER_PROFILE,
      designIndexProfileId: DESIGN_PROFILE,
    });
    const { runtime: stub, asked } = runtime({
      "smart-1": JSON.stringify({ principles: ["One colour carries meaning.", "Nothing below 12px.", "Quiet by default."], summary: "Three rules for a reading app." }),
      "balanced-1": "{}",
    });
    const { server, call, out } = harness(stub, { projectWork: true });
    const session = await openSession(call, server, out);
    const answer = await proposeFirstStep(server, session, out);

    expect(asked.map((one) => one.model), "the assigned profile, never the default").toEqual(["smart-1"]);
    expect(answer["step"]).toBe("principles");
    expect(answer["state"]).toBe("proposed");
    expect(answer["fallback"]).toBeUndefined();
    expect(answer["key"]).toBe("DES-1");
    expect(String(answer["summary"])).toContain("reading app");
  });

  it("falls back to the neutral foundation, with the reason, when there is no profile", async () => {
    writeSettings({ modelProfiles: [] });
    const { runtime: stub, asked } = runtime({ "smart-1": "{}" });
    const { server, call, out } = harness(stub, { projectWork: true });
    const session = await openSession(call, server, out);
    const answer = await proposeFirstStep(server, session, out);

    expect(asked).toEqual([]);
    expect(answer["fallback"]).toBe(true);
    expect(String(answer["note"])).toContain("No model profile is connected for design work");
    expect(String(answer["note"])).toContain("neutral starting point");
  });
});
