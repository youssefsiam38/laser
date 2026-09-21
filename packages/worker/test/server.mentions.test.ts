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

  async open(options: { mentionContext?: SessionMentionContext }) {
    this.mentions = options.mentionContext;
    return this.st;
  }
  state() { return this.st; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }

  private note(route: Sent["route"], content: ContentBlock[], projectWork?: readonly ProjectWorkMentionProjection[]): void {
    this.sent.push({
      route,
      text: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      keys: (projectWork ?? []).map((item) => item.key),
    });
    // What a driver does with an accepted message: take an identity for it and
    // say which of the engine's doors it went through.
    if (!projectWork?.length || !this.mentions) return;
    const id = this.mentions.reserve(projectWork);
    this.mentions.admitted(id, route === "prompt" ? "direct" : route);
  }

  async prompt(content: ContentBlock[], options?: PromptOptions) {
    this.note("prompt", content, options?.projectWork);
    options?.onAccepted?.();
    if (this.st.isStreaming && options?.streamingBehavior) return { accepted: true, queued: true };
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    return { accepted: true, queued: false };
  }
  async steer(content: ContentBlock[], options?: QueuedSendOptions) { this.note("steer", content, options?.projectWork); }
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

    console.error("SENT", JSON.stringify(h.drivers.map(d=>d.sent)), JSON.stringify((await h.call(9,"pi/session/steer",{path,content:text("x"),projectWork:[projection("Z-1")]}))));
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
