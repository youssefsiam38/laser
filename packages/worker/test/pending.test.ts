/**
 * The pending tray (M13-T28).
 *
 * The point of the tray is that leaving a message alone is the default and
 * every other outcome is one deliberate act, so these tests are about the acts:
 * add, edit, drop, steer, and the delivery that happens on its own when the run
 * ends. The engine's queue has none of these verbs, which is why the list lives
 * here — see `src/pending.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ContentBlock, JsonRpcMessage, PendingMessage, SessionState } from "@lasercode/protocol";
import type { DriverEvent, DriverListener, PromptOptions, SessionDriver } from "../src/driver.js";
import { PendingTray } from "../src/pending.js";
import { WorkerServer } from "../src/server.js";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

function harness(options: { streaming?: boolean } = {}) {
  let streaming = options.streaming ?? true;
  const prompted: string[] = [];
  const steered: string[] = [];
  const published: PendingMessage[][] = [];
  let promptResult: { accepted: boolean } | Error = { accepted: true };
  let steerResult: Error | undefined;
  let ids = 0;

  const tray = new PendingTray({
    prompt: async (content, onAccepted) => {
      prompted.push(textOf(content));
      if (promptResult instanceof Error) throw promptResult;
      if (promptResult.accepted) onAccepted();
      return promptResult;
    },
    steer: async (content) => {
      steered.push(textOf(content));
      if (steerResult) throw steerResult;
    },
    streaming: () => streaming,
    publish: (messages) => published.push(messages),
    now: () => "2026-09-08T00:00:00.000Z",
    newId: () => `p-${String(++ids).padStart(8, "0")}`,
  });

  return {
    tray,
    prompted,
    steered,
    published,
    settle: () => {
      streaming = false;
      return tray.drain();
    },
    set running(value: boolean) {
      streaming = value;
    },
    failPrompt: (error: Error) => (promptResult = error),
    refusePrompt: () => (promptResult = { accepted: false }),
    failSteer: (error: Error) => (steerResult = error),
  };
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

describe("PendingTray · leaving it alone is the default", () => {
  it("keeps what was written, in order, and delivers it when the run ends", async () => {
    const h = harness();
    h.tray.add(text("run the tests"));
    h.tray.add(text("then commit"));
    expect(h.tray.list().map((m) => m.text)).toEqual(["run the tests", "then commit"]);
    expect(h.prompted).toEqual([]);
    expect(h.steered).toEqual([]);

    await h.settle();
    // Each message is its own turn, in the order it was written.
    expect(h.prompted).toEqual(["run the tests", "then commit"]);
    expect(h.tray.list()).toEqual([]);
  });

  it("does nothing while the agent is still working", async () => {
    const h = harness();
    h.tray.add(text("wait for me"));
    await h.tray.drain();
    expect(h.prompted).toEqual([]);
    expect(h.tray.list()).toHaveLength(1);
  });

  it("acknowledges the exact message at accepted preflight, while its turn is still running", async () => {
    let release = () => {};
    const completion = new Promise<void>((resolve) => (release = resolve));
    const content: ContentBlock[] = [
      { type: "text", text: "keep the image" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ];
    let promptSettled = false;
    const published: PendingMessage[][] = [];
    const tray = new PendingTray({
      prompt: async (received, onAccepted) => {
        expect(received).toEqual(content);
        onAccepted();
        await completion;
        promptSettled = true;
        return { accepted: true };
      },
      steer: async () => {},
      streaming: () => false,
      publish: (messages) => published.push(messages),
      newId: () => "p-accepted",
    });
    tray.add(content);

    const draining = tray.drain();
    expect(promptSettled).toBe(false);
    expect(tray.list()).toEqual([]);
    expect(published.at(-1)).toEqual([]);

    release();
    await draining;
  });

  it("uses the pending id, so duplicate acknowledgements cannot consume an equal message behind it", async () => {
    let running = false;
    let acknowledgeFirst = () => {};
    const tray = new PendingTray({
      prompt: async (_content, onAccepted) => {
        acknowledgeFirst = onAccepted;
        onAccepted();
        running = true;
        return { accepted: true };
      },
      steer: async () => {},
      streaming: () => running,
      publish: () => {},
      newId: (() => {
        let id = 0;
        return () => `p-same-${++id}`;
      })(),
    });
    tray.add(text("same words"));
    const second = tray.add(text("same words"));

    await tray.drain();
    expect(tray.list().map((message) => message.id)).toEqual([second.id]);
    acknowledgeFirst();
    expect(tray.list().map((message) => message.id)).toEqual([second.id]);
  });

  it("publishes the whole list on every change, so a second client sees the same rows", () => {
    const h = harness();
    const first = h.tray.add(text("one"));
    h.tray.add(text("two"));
    h.tray.remove(first.id);
    expect(h.published.map((list) => list.map((m) => m.text))).toEqual([["one"], ["one", "two"], ["two"]]);
  });

  it("counts the images that ride along rather than carrying them into the row's text", () => {
    const h = harness();
    const message = h.tray.add([
      { type: "text", text: "like this" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]);
    expect(message.text).toBe("like this");
    expect(message.images).toBe(1);
  });
});

describe("PendingTray · the three acts on one message", () => {
  it("edits one message and leaves the rest alone", () => {
    const h = harness();
    const first = h.tray.add(text("run the tests"));
    h.tray.add(text("then commit"));
    const edited = h.tray.edit(first.id, text("run the tests twice"));
    expect(edited.text).toBe("run the tests twice");
    expect(h.tray.list().map((m) => m.text)).toEqual(["run the tests twice", "then commit"]);
  });

  it("drops one message and hands its text back", () => {
    const h = harness();
    const first = h.tray.add(text("never mind"));
    h.tray.add(text("keep this"));
    expect(h.tray.remove(first.id)?.text).toBe("never mind");
    expect(h.tray.list().map((m) => m.text)).toEqual(["keep this"]);
    // Dropping the same row twice is a click on a row that is already gone.
    expect(h.tray.remove(first.id)).toBeNull();
  });

  it("steers one message into the engine's queue and takes it out of the tray", async () => {
    const h = harness();
    const first = h.tray.add(text("actually, use the other file"));
    h.tray.add(text("then commit"));
    expect(await h.tray.steer(first.id)).toBe(true);
    // Handed over exactly once, and never in both places.
    expect(h.steered).toEqual(["actually, use the other file"]);
    expect(h.prompted).toEqual([]);
    expect(h.tray.list().map((m) => m.text)).toEqual(["then commit"]);
  });

  it("steering with nothing running sends it now instead of parking it in a queue no turn reads", async () => {
    const h = harness({ streaming: false });
    h.tray.add(text("first"));
    const second = h.tray.add(text("second"));
    expect(await h.tray.steer(second.id)).toBe(true);
    // The one the person chose goes first; the rest follow in order.
    expect(h.steered).toEqual([]);
    expect(h.prompted).toEqual(["second", "first"]);
    expect(h.tray.list()).toEqual([]);
  });

  it("steering a row that has already gone answers false rather than throwing at a stale click", async () => {
    const h = harness();
    const first = h.tray.add(text("gone"));
    h.tray.remove(first.id);
    expect(await h.tray.steer(first.id)).toBe(false);
  });

  it("clears every waiting message and hands them all back, without touching the run", () => {
    const h = harness();
    h.tray.add(text("one"));
    h.tray.add(text("two"));
    expect(h.tray.clear().map((m) => m.text)).toEqual(["one", "two"]);
    expect(h.tray.list()).toEqual([]);
    expect(h.prompted).toEqual([]);
    expect(h.steered).toEqual([]);
    expect(h.tray.clear()).toEqual([]);
  });

  it("refuses more than the tray holds, in a sentence a person can act on", () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.tray.add(text(`m${i}`));
    expect(() => h.tray.add(text("one too many"))).toThrow(/Send or drop some/);
  });
});

describe("PendingTray · delivery that does not land", () => {
  it("never steers a prompt whose callback accepted it even if a driver later reports false", async () => {
    let steers = 0;
    const tray = new PendingTray({
      prompt: async (_content, onAccepted) => {
        onAccepted();
        return { accepted: false };
      },
      steer: async () => { steers += 1; },
      streaming: () => false,
      publish: () => {},
      newId: () => "p-mismatched-result",
    });
    tray.add(text("accepted once"));

    await tray.drain();
    expect(steers).toBe(0);
    expect(tray.list()).toEqual([]);
  });

  it("keeps acceptance monotonic when publishing its removal throws", async () => {
    let engineRan = false;
    const reported: unknown[] = [];
    const tray = new PendingTray({
      prompt: async (_content, onAccepted) => {
        try {
          onAccepted();
        } catch (error) {
          // The real driver owns this no-throw observer boundary.
          reported.push(error);
        }
        engineRan = true;
        return { accepted: true };
      },
      steer: async () => {},
      streaming: () => false,
      publish: (messages) => {
        if (messages.length === 0) throw new Error("socket closed during publication");
      },
      newId: () => "p-publication-error",
    });
    tray.add(text("still run this"));

    await tray.drain();
    expect(reported).toEqual([expect.objectContaining({ message: "socket closed during publication" })]);
    expect(engineRan).toBe(true);
    expect(tray.list()).toEqual([]);
  });

  it("never retries a message whose accepted turn fails later", async () => {
    let prompts = 0;
    const tray = new PendingTray({
      prompt: async (_content, onAccepted) => {
        prompts += 1;
        onAccepted();
        throw new Error("The accepted turn failed later.");
      },
      steer: async () => {},
      streaming: () => false,
      publish: () => {},
      newId: () => "p-later-failure",
    });
    tray.add(text("already entered the transcript"));

    await tray.drain();
    await tray.drain();
    expect(prompts).toBe(1);
    expect(tray.list()).toEqual([]);
  });

  it("keeps the message and the reason, and tries again on the next settle", async () => {
    const h = harness();
    h.tray.add(text("run the tests"));
    h.failPrompt(new Error("The provider is not reachable."));
    await h.settle();
    expect(h.tray.list()).toEqual([
      expect.objectContaining({ text: "run the tests", state: "failed", error: "The provider is not reachable." }),
    ]);

    // The row is still the person's message: the next settle takes it again.
    const h2 = harness();
    h2.tray.add(text("run the tests"));
    h2.failPrompt(new Error("nope"));
    await h2.settle();
    expect(h2.tray.list()[0]?.state).toBe("failed");
  });

  it("stops the pass at the failure rather than reordering what is behind it", async () => {
    const h = harness();
    h.tray.add(text("first"));
    h.tray.add(text("second"));
    h.failPrompt(new Error("no"));
    await h.settle();
    expect(h.prompted).toEqual(["first"]);
    expect(h.tray.list().map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("steers a message the engine refused to prompt, exactly as a live send does", async () => {
    const h = harness();
    h.tray.add(text("held by an extension"));
    h.refusePrompt();
    await h.settle();
    expect(h.steered).toEqual(["held by an extension"]);
    expect(h.tray.list()).toEqual([]);
  });

  it("puts a failed steer back at the head with its reason, so nothing is silently lost", async () => {
    const h = harness();
    const first = h.tray.add(text("redirect"));
    h.tray.add(text("later"));
    h.failSteer(new Error("Nothing is running."));
    await expect(h.tray.steer(first.id)).rejects.toThrow("Nothing is running.");
    expect(h.tray.list().map((m) => [m.text, m.state, m.error])).toEqual([
      ["redirect", "failed", "Nothing is running."],
      ["later", "waiting", undefined],
    ]);
  });

  it("will not edit or drop a message that is already on its way", async () => {
    const h = harness();
    h.tray.add(text("in flight"));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new PendingTray({
      prompt: async (_content, onAccepted) => {
        await gate;
        onAccepted();
        return { accepted: true };
      },
      steer: async () => {},
      streaming: () => false,
      publish: () => {},
      newId: () => "p-0000000a",
    });
    const message = slow.add(text("in flight"));
    const draining = slow.drain();
    expect(slow.list()[0]?.state).toBe("delivering");
    expect(() => slow.edit(message.id, text("changed my mind"))).toThrow(/already on its way/);
    expect(() => slow.remove(message.id)).toThrow(/already on its way/);
    expect(slow.clear()).toEqual([]);
    release();
    await draining;
    expect(slow.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the worker's own dispatch, so the wire shape is covered too.
// ---------------------------------------------------------------------------

const PATH = "/tmp/tray/s1.jsonl";

/** Only the driver surface the tray touches; the rest throws if it is reached. */
class TrayDriver implements Partial<SessionDriver> {
  readonly kind = "stable-sdk" as const;
  streaming = false;
  readonly prompted: string[] = [];
  readonly steered: string[] = [];
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = {
    path: PATH,
    id: "s1",
    cwd: "/tmp/tray",
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  async open() {
    return this.st;
  }
  state() {
    return { ...this.st, isStreaming: this.streaming };
  }
  subscribe(listener: DriverListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: DriverEvent) {
    for (const listener of this.listeners) listener(event);
  }
  completion: Promise<void> | undefined;
  failBeforeAcceptance: Error | undefined;
  failAfterAcceptance: Error | undefined;
  acceptPrompts = true;
  readonly acceptedObserverErrors: unknown[] = [];
  async prompt(content: ContentBlock[], options?: PromptOptions) {
    this.prompted.push(textOf(content));
    if (this.failBeforeAcceptance) throw this.failBeforeAcceptance;
    if (!this.acceptPrompts) return { accepted: false, queued: false };
    try {
      options?.onAccepted?.();
    } catch (error) {
      // Matches StableSdkDriver's no-throw accepted-observer boundary.
      this.acceptedObserverErrors.push(error);
    }
    this.streaming = true;
    this.emit({ type: "update", update: { kind: "message_start", role: "user" } });
    this.emit({
      type: "update",
      update: { kind: "message_end", role: "user", message: { role: "user", content, timestamp: Date.now() } },
    });
    if (this.completion) await this.completion;
    this.streaming = false;
    if (this.failAfterAcceptance) throw this.failAfterAcceptance;
    return { accepted: true, queued: false };
  }
  async steer(content: ContentBlock[]) {
    this.steered.push(textOf(content));
  }
  async followUp() {}
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
  async abort() {}
  async entries() {
    return [];
  }
  async dispose() {
    this.emit({ type: "closed", reason: "disposed" });
  }
}

async function server(options: { onSend?: (message: JsonRpcMessage) => void } = {}) {
  const out: JsonRpcMessage[] = [];
  let driver!: TrayDriver;
  const worker = new WorkerServer({
    cwd: "/tmp/tray",
    createDriver: () => (driver = new TrayDriver()) as unknown as SessionDriver,
    send: (message) => {
      out.push(message);
      options.onSend?.(message);
    },
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await worker.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as
      | { result?: unknown; error?: { code: number; message: string } }
      | undefined;
  };
  const notifications = (method: string) =>
    out.filter((message) => "method" in message && !("id" in message) && message.method === method) as Array<{ params: unknown }>;
  await call(1, "session/load", { path: PATH });
  return { worker, call, notifications, out, get driver() { return driver; } };
}

describe("WorkerServer · the tray on the wire", () => {
  it("removes an accepted row while its reply is still running, even when nobody was viewing the session", async () => {
    const { call, driver, notifications, out } = await server();
    driver.streaming = true;
    await call(2, "session/pending/add", { path: PATH, content: text("delivered off screen") });

    // No UI is holding this session now. Delivery remains worker-owned.
    out.length = 0;
    let release = () => {};
    driver.completion = new Promise<void>((resolve) => (release = resolve));
    driver.streaming = false;
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.streaming).toBe(true);
    expect(driver.prompted).toEqual(["delivered off screen"]);
    const userEnd = notifications("session/update").find((notification) => {
      const update = (notification.params as { update: { kind: string; role?: string } }).update;
      return update.kind === "message_end" && update.role === "user";
    });
    expect(userEnd).toBeDefined();
    // Reopening, then reconciling after a reconnect, both read the worker's
    // canonical empty tray before the assistant turn has settled.
    expect((await call(3, "session/pending/list", { path: PATH }))?.result).toEqual({ messages: [] });
    expect((await call(4, "session/pending/list", { path: PATH }))?.result).toEqual({ messages: [] });

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("runs an accepted prompt once even when publishing its tray removal throws", async () => {
    let failAcceptedPublication = false;
    const context = await server({
      onSend: (message) => {
        if (!failAcceptedPublication || !("method" in message) || message.method !== "session/update") return;
        const update = (message.params as { update?: { kind?: string; pending?: unknown[] } }).update;
        if (update?.kind === "pending_update" && update.pending?.length === 0) {
          throw new Error("connection closed during pending publication");
        }
      },
    });
    const { call, driver } = context;
    driver.streaming = true;
    await call(2, "session/pending/add", { path: PATH, content: text("publish then run") });

    failAcceptedPublication = true;
    driver.streaming = false;
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.acceptedObserverErrors).toEqual([
      expect.objectContaining({ message: "connection closed during pending publication" }),
    ]);
    expect(driver.prompted).toEqual(["publish then run"]);
    expect((await call(3, "session/pending/list", { path: PATH }))?.result).toEqual({ messages: [] });
  });

  it("keeps only pre-acceptance failures and never resends an accepted prompt after a later failure", async () => {
    const { call, driver } = await server();
    driver.streaming = true;
    await call(2, "session/pending/add", { path: PATH, content: text("one attempt only") });

    driver.failBeforeAcceptance = new Error("The provider is not configured.");
    driver.streaming = false;
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await call(3, "session/pending/list", { path: PATH }))?.result).toEqual({
      messages: [expect.objectContaining({ text: "one attempt only", state: "failed", error: "The provider is not configured." })],
    });

    driver.failBeforeAcceptance = undefined;
    driver.failAfterAcceptance = new Error("The accepted turn failed.");
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await call(4, "session/pending/list", { path: PATH }))?.result).toEqual({ messages: [] });
    expect(driver.prompted).toEqual(["one attempt only", "one attempt only"]);

    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.prompted).toHaveLength(2);
  });

  it("falls back to one steer when idle prompt preflight refuses the delivery", async () => {
    const { call, driver } = await server();
    driver.streaming = true;
    await call(2, "session/pending/add", { path: PATH, content: text("extension-held") });
    driver.acceptPrompts = false;
    driver.streaming = false;
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.prompted).toEqual(["extension-held"]);
    expect(driver.steered).toEqual(["extension-held"]);
    expect((await call(3, "session/pending/list", { path: PATH }))?.result).toEqual({ messages: [] });
  });

  it("adds, publishes, steers and delivers on settle, and never draws a stop", async () => {
    const { call, notifications, driver } = await server();

    const added = (await call(2, "session/pending/add", { path: PATH, content: text("run the tests") }))?.result as {
      message: PendingMessage;
    };
    expect(added.message.state).toBe("waiting");
    const second = (await call(3, "session/pending/add", { path: PATH, content: text("then commit") }))?.result as {
      message: PendingMessage;
    };

    // Every change reaches clients as a numbered session update, so a phone
    // that reconnects replays the tray in order with everything else.
    const published = notifications("session/update")
      .map((n) => (n.params as { update: { kind: string; pending?: PendingMessage[] } }).update)
      .filter((update) => update.kind === "pending_update");
    expect(published.at(-1)?.pending?.map((m) => m.text)).toEqual(["run the tests", "then commit"]);

    driver.streaming = true;
    expect((await call(4, "session/pending/steer", { path: PATH, id: added.message.id }))?.result).toEqual({ steered: true });
    expect(driver.steered).toEqual(["run the tests"]);

    // The turn ends: what is left goes in on its own.
    driver.streaming = false;
    driver.emit({ type: "update", update: { kind: "agent_settled" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.prompted).toEqual(["then commit"]);

    // Steering never aborts, so nothing in the stream says the run stopped.
    const stops = notifications("session/update").filter((n) => {
      const update = (n.params as { update: { kind: string; stopReason?: string } }).update;
      return update.kind === "message_end" && update.stopReason === "aborted";
    });
    expect(stops).toEqual([]);
    void second;
  });

  it("drops one message, hands the text back, and refuses an id that is not one of ours", async () => {
    const { call } = await server();
    const added = (await call(2, "session/pending/add", { path: PATH, content: text("never mind") }))?.result as {
      message: PendingMessage;
    };
    expect((await call(3, "session/pending/remove", { path: PATH, id: added.message.id }))?.result).toEqual({
      message: expect.objectContaining({ text: "never mind" }),
    });
    expect((await call(4, "session/pending/remove", { path: PATH, id: added.message.id }))?.result).toEqual({ message: null });
    // The schema owns the id shape; a queue index from the engine is not one.
    expect((await call(5, "session/pending/remove", { path: PATH, id: "steer:0" }))?.error?.code).toBeDefined();
  });
});
