/**
 * Every door a person's words go through carries what they mentioned
 * (M21-T9).
 *
 * `sendToSession` in the app has four of them — Enter when idle, Cmd/Ctrl+Enter
 * to steer, Enter into the waiting tray while the agent works, and the tray
 * row's own steer — plus the edit of a row that is still waiting. The host
 * validates and projects each one; this proves the worker hands each
 * projection to the engine with that exact message, and refuses a new one
 * rather than accepting a message whose context it would then drop.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, type ContentBlock, type JsonRpcMessage, type ProjectWorkMentionProjection, type SessionState } from "@lasercode/protocol";
import type { DriverEvent, DriverListener, PromptOptions, QueuedSendOptions, SessionDriver } from "../src/driver.js";
import { WorkerServer } from "../src/server.js";
import type { SessionMentionContext } from "../src/project-work/mentions.js";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

const KIND_OF: Record<string, "spec" | "research" | "design" | "plan" | "task"> = {
  SPEC: "spec",
  RES: "research",
  DES: "design",
  PLAN: "plan",
  TASK: "task",
};

function projection(key: string): ProjectWorkMentionProjection {
  return {
    ref: {
      projectId: "p_a1",
      entityId: `e_${key.replace("-", "_")}`,
      revisionId: "r_3",
      kind: KIND_OF[key.split("-")[0]!]!,
      key,
      label: `${key} title`,
      digest: "8f1c".padEnd(64, "0"),
    },
    key,
    kind: KIND_OF[key.split("-")[0]!]!,
    title: `${key} title`,
    state: "in_progress",
    provenance: `[from Acme ${key}@3]`,
    fields: [],
  };
}

interface Sent {
  route: "prompt" | "steer" | "followUp";
  text: string;
  keys: string[];
}

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  readonly sent: Sent[] = [];
  /** The session's mention context, exactly as the real driver receives it. */
  private mentions: SessionMentionContext | undefined;
  private listeners = new Set<DriverListener>();
  private st: SessionState = {
    path: "/tmp/fake/s1.jsonl",
    id: "s1",
    cwd: "/tmp/fake",
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

  constructor(path: string) {
    this.st = { ...this.st, path, id: path };
  }

  setStreaming(streaming: boolean): void {
    this.st = { ...this.st, isStreaming: streaming };
  }

  /**
   * Park every send inside the driver, *before* it takes an identity. That is
   * the window the real driver has too: the route checks the ceiling, then
   * awaits (a phrase still being transcribed, a first-turn lease, the tray's
   * own drain) and only then does the driver take a slot.
   */
  hold(): () => void {
    let open = () => {};
    this.gate = new Promise<void>((resolve) => { open = () => resolve(); });
    return () => {
      this.gate = undefined;
      open();
    };
  }

  private gate: Promise<void> | undefined;

  async open(options: { mentionContext?: SessionMentionContext }) {
    this.mentions = options.mentionContext;
    return this.st;
  }
  state() { return this.st; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }

  /**
   * Exactly the real driver's order: take the identity **first**, because a
   * refusal there must happen before the engine is asked anything, and only
   * then record the send. A send whose slot was refused never appears here.
   */
  private note(route: Sent["route"], content: ContentBlock[], projectWork?: readonly ProjectWorkMentionProjection[]): void {
    const id = projectWork?.length && this.mentions ? this.mentions.reserve(projectWork) : undefined;
    this.sent.push({
      route,
      text: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      keys: (projectWork ?? []).map((item) => item.key),
    });
    // What a driver does with an accepted message: say which of the engine's
    // doors it went through.
    if (id !== undefined) this.mentions?.admitted(id, route === "prompt" ? "direct" : route);
  }

  /** The carrier this session was opened with, for a test that inspects it. */
  mentionContext(): SessionMentionContext | undefined {
    return this.mentions;
  }

  async prompt(content: ContentBlock[], options?: PromptOptions) {
    this.note("prompt", content, options?.projectWork);
    options?.onAccepted?.();
    if (this.st.isStreaming && options?.streamingBehavior) return { accepted: true, queued: true };
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    return { accepted: true, queued: false };
  }
  async steer(content: ContentBlock[], options?: QueuedSendOptions) {
    if (this.gate) await this.gate;
    this.note("steer", content, options?.projectWork);
  }
  async followUp(content: ContentBlock[], options?: QueuedSendOptions) { this.note("followUp", content, options?.projectWork); }
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {}
  async listModels() { return [{ provider: "p", id: "m" }]; }
  async setModel() { return this.st; }
  async setThinkingLevel(level: SessionState["thinkingLevel"]) { this.st = { ...this.st, thinkingLevel: level }; return this.st; }
  async rename() {}
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st, editorText: "" }; }
  respondToUi() {}
  async entries() { return { entries: [], leafId: null }; }
  sessionHeader() { return null; }
  async goalState() { return null; }
  async commands() { return []; }
  async prompts() { return []; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

function harness() {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  let made = 0;
  const server = new WorkerServer({
    cwd: "/tmp/fake",
    createDriver: () => {
      made += 1;
      const driver = new FakeDriver(`/tmp/fake/s${String(made)}.jsonl`);
      drivers.push(driver);
      return driver;
    },
    send: (message) => out.push(message),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  return { server, drivers, call };
}

describe("what a message mentioned, on every send path", () => {
  it("carries the host's projection on a prompt, a steer and a follow-up", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const path = h.drivers[0]!.state().path;

    await h.call(2, "session/prompt", { path, content: text("one"), projectWork: [projection("TASK-44")] });
    await h.call(3, "pi/session/steer", { path, content: text("two"), projectWork: [projection("SPEC-7")] });
    await h.call(4, "pi/session/follow_up", { path, content: text("three"), projectWork: [projection("DES-3")] });
    await h.call(5, "session/prompt", { path, content: text("four") });

    expect(h.drivers[0]!.sent).toEqual([
      { route: "prompt", text: "one", keys: ["TASK-44"] },
      { route: "steer", text: "two", keys: ["SPEC-7"] },
      { route: "followUp", text: "three", keys: ["DES-3"] },
      { route: "prompt", text: "four", keys: [] },
    ]);
  });

  it("keeps a first-turn choice's projection with its own first message", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const path = h.drivers[0]!.state().path;

    // This runtime cannot apply a first-turn choice, which is refused before
    // anything is sent: the message, and its context, stay with the caller.
    const refused = await h.call(2, "session/prompt", {
      path,
      content: text("with an agent"),
      firstTurn: { agentName: "nobody" },
      projectWork: [projection("TASK-44")],
    });
    expect(refused.error?.code).toBe(ErrorCodes.InvalidParams);
    expect(h.drivers[0]!.sent).toEqual([]);
  });

  it("hands a waiting row's projection to the engine when the tray delivers it", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    const path = driver.state().path;
    driver.setStreaming(true);

    const added = await h.call(2, "session/pending/add", { path, content: text("waiting"), projectWork: [projection("TASK-44")] });
    const id = (added.result as { message: { id: string } }).message.id;
    // A row on the wire is the person's words; the projection is not on it.
    expect(JSON.stringify(added.result)).not.toContain("TASK-44");

    // Rewriting the row replaces what it mentions with the host's new reading.
    await h.call(3, "session/pending/edit", { path, id, content: text("waiting, edited"), projectWork: [projection("SPEC-7")] });

    driver.setStreaming(false);
    await h.call(4, "session/pending/steer", { path, id });

    expect(driver.sent).toEqual([{ route: "prompt", text: "waiting, edited", keys: ["SPEC-7"] }]);
  });

  it("refuses a further mentioning message instead of taking one it cannot carry", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    const path = driver.state().path;
    driver.setStreaming(true);

    for (let at = 0; at < 16; at += 1) {
      const answer = await h.call(10 + at, "pi/session/steer", { path, content: text(`m${String(at)}`), projectWork: [projection(`TASK-${String(at + 1)}`)] });
      expect(answer.error).toBeUndefined();
    }
    const refused = await h.call(100, "pi/session/steer", { path, content: text("one too many"), projectWork: [projection("TASK-99")] });
    expect(refused.error?.code).toBe(ErrorCodes.SessionBusy);
    expect(refused.error?.message).toContain("clear the queue");
    // The message that mentions nothing is unaffected.
    const plain = await h.call(101, "pi/session/steer", { path, content: text("no mentions here") });
    expect(plain.error).toBeUndefined();
    expect(driver.sent.at(-1)).toEqual({ route: "steer", text: "no mentions here", keys: [] });
    // A message that mentions nothing holds no slot either, so it can never
    // be the reason the next mentioning message is turned away.
    expect(driver.mentionContext()!.held()).toHaveLength(16);
  });

  it("lets only one of two simultaneous sends take the last slot, and the loser reaches no engine", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    const path = driver.state().path;
    driver.setStreaming(true);

    for (let at = 0; at < 15; at += 1) {
      await h.call(10 + at, "pi/session/steer", { path, content: text(`m${String(at)}`), projectWork: [projection(`TASK-${String(at + 1)}`)] });
    }
    expect(driver.mentionContext()!.held()).toHaveLength(15);

    // Both of these pass the route's friendly check — fifteen are waiting when
    // each of them looks — and only then does either take a slot. Every send
    // route awaits in between, so this is the ordinary case and not a
    // contrived one; the ceiling therefore has to hold at the slot itself.
    const release = driver.hold();
    const both = Promise.all([
      h.call(200, "pi/session/steer", { path, content: text("first of two"), projectWork: [projection("TASK-16")] }),
      h.call(201, "pi/session/steer", { path, content: text("second of two"), projectWork: [projection("TASK-17")] }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(driver.mentionContext()!.held(), "both passed the ceiling check while fifteen were held").toHaveLength(15);

    release();
    const answers = await both;

    const refused = answers.filter((answer) => answer.error !== undefined);
    expect(refused, "one of the two is refused, not both and not neither").toHaveLength(1);
    expect(refused[0]!.error!.code).toBe(ErrorCodes.SessionBusy);
    expect(refused[0]!.error!.message).toContain("clear the queue");
    // The ceiling held, and the refused message left nothing behind.
    expect(driver.mentionContext()!.held()).toHaveLength(16);
    const delivered = driver.sent.filter((send) => send.text.endsWith("of two"));
    expect(delivered, "the refused message never reached the engine").toHaveLength(1);
    expect([["TASK-16"], ["TASK-17"]]).toContainEqual(delivered[0]!.keys);
  });

  it("keeps two conversations in one worker apart", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    await h.call(2, "session/new", { cwd: "/tmp/fake" });
    const [one, other] = h.drivers as [FakeDriver, FakeDriver];

    await h.call(3, "session/prompt", { path: one.state().path, content: text("mine"), projectWork: [projection("TASK-44")] });
    await h.call(4, "session/prompt", { path: other.state().path, content: text("mine"), projectWork: [projection("SPEC-7")] });

    expect(one.sent).toEqual([{ route: "prompt", text: "mine", keys: ["TASK-44"] }]);
    expect(other.sent).toEqual([{ route: "prompt", text: "mine", keys: ["SPEC-7"] }]);
  });
});
