/**
 * M0-T4 done-when: a prompt against a stub provider yields session updates in
 * order. A tiny local HTTP server speaks the OpenAI chat-completions streaming
 * format; Pi is pointed at it through a sandboxed models.json.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../src/driver.js";
import type { SessionUpdate } from "@lasercode/protocol";

const REPLY = ["Hel", "lo ", "from ", "stub"];

type Deferred = { promise: Promise<void>; release: () => void };
function deferred(): Deferred {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface FakePromptOptions {
  streamingBehavior?: "steer" | "followUp";
  preflightResult?: (accepted: boolean) => void;
}

function installPromptSession(
  target: StableSdkDriver,
  session: { isStreaming: boolean; prompt(text: string, options?: FakePromptOptions): Promise<void> },
): void {
  (target as unknown as { runtime: unknown }).runtime = {
    session,
    dispose: async () => {},
  };
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function startStubProvider(): Promise<{
  server: Server;
  url: string;
  requests: unknown[];
  holdNextResponse(): () => void;
}> {
  const requests: unknown[] = [];
  let responseGate: Promise<void> | undefined;
  let releaseResponse: (() => void) | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
      if (responseGate) {
        const gate = responseGate;
        responseGate = undefined;
        await gate;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      for (const piece of REPLY) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
      }
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        holdNextResponse: () => {
          responseGate = new Promise<void>((resolveGate) => {
            releaseResponse = resolveGate;
          });
          return () => {
            releaseResponse?.();
            releaseResponse = undefined;
          };
        },
      });
    });
  });
}

let base: string;
let driver: StableSdkDriver;
let stub: Awaited<ReturnType<typeof startStubProvider>>;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-prompt-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  stub = await startStubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000 }],
        },
      },
    }),
  );
  driver = new StableSdkDriver();
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe("StableSdkDriver.prompt", () => {
  it("serializes queued waiters across a refused idle preflight", async () => {
    const firstPreflight = deferred();
    const secondPreflight = deferred();
    const secondTurn = deferred();
    const calls: Array<{ text: string; streaming: boolean; behavior?: string }> = [];
    const acknowledgements: string[] = [];
    const session = {
      isStreaming: false,
      async prompt(text: string, options?: FakePromptOptions): Promise<void> {
        calls.push({ text, streaming: this.isStreaming, ...(options?.streamingBehavior ? { behavior: options.streamingBehavior } : {}) });
        if (text === "first") {
          await firstPreflight.promise;
          options?.preflightResult?.(false);
          throw new Error("The first prompt was refused.");
        }
        if (text === "second") {
          await secondPreflight.promise;
          options?.preflightResult?.(true);
          this.isStreaming = true;
          await secondTurn.promise;
          this.isStreaming = false;
          return;
        }
        options?.preflightResult?.(true);
      },
    };
    installPromptSession(driver, session);

    const first = driver.prompt([{ type: "text", text: "first" }]);
    const second = driver.prompt([{ type: "text", text: "second" }], {
      streamingBehavior: "steer",
      onAccepted: () => acknowledgements.push("second"),
    });
    const third = driver.prompt([{ type: "text", text: "third" }], {
      streamingBehavior: "followUp",
      onAccepted: () => acknowledgements.push("third"),
    });
    await Promise.resolve();
    expect(calls.map((call) => call.text)).toEqual(["first"]);

    firstPreflight.release();
    await expect(first).rejects.toThrow("refused");
    await Promise.resolve();
    expect(calls.map((call) => call.text)).toEqual(["first", "second"]);

    secondPreflight.release();
    expect(await third).toEqual({ accepted: true, queued: true });
    expect(calls).toEqual([
      { text: "first", streaming: false },
      { text: "second", streaming: false, behavior: "steer" },
      { text: "third", streaming: true, behavior: "followUp" },
    ]);
    expect(acknowledgements).toEqual(["second", "third"]);

    secondTurn.release();
    expect(await second).toEqual({ accepted: true, queued: false });
  });

  it("does not downgrade an acknowledged invocation when Pi throws a busy-shaped late error", async () => {
    const session = {
      isStreaming: false,
      async prompt(_text: string, options?: FakePromptOptions): Promise<void> {
        options?.preflightResult?.(true);
        throw new Error("Agent is already processing a prompt.");
      },
    };
    installPromptSession(driver, session);
    let accepted = 0;

    await expect(driver.prompt([{ type: "text", text: "accepted first" }], {
      onAccepted: () => { accepted += 1; },
    })).rejects.toThrow("already processing");
    expect(accepted).toBe(1);
  });

  it("captures instruction provenance from a real session and the actual sent payload", async () => {
    const path = join(base, "project", "AGENTS.md");
    writeFileSync(path, "Recorded project instruction.\n");
    const captures: Extract<DriverEvent, { type: "extension" }>[] = [];
    const settled = new Promise<void>(resolve => driver.subscribe(event => {
      if (event.type === "extension" && event.message.type === "lasercode/provider/request") captures.push(event);
      if (event.type === "update" && event.update.kind === "agent_settled") resolve();
    }));
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    await driver.setModel({ provider: "stub", id: "stub-1" });
    await driver.prompt([{ type: "text", text: "hello" }]);
    await settled;
    expect(captures).toHaveLength(1);
    const message = captures[0]!.message;
    if (message.type !== "lasercode/provider/request") throw new Error("Missing request");
    expect(message.payload).toEqual(stub.requests[0]);
    expect(message.context?.instructionSources?.flatMap(map => map.spans).some(span => span.source.path === path)).toBe(true);
    expect(message.context?.instructionSources?.flatMap(map => map.spans).filter(span => span.source.kind === "unrecorded")).toEqual([]);
  }, 60_000);

  it("expands an explicitly invoked skill through Pi before calling the provider", async () => {
    const skillDir = join(base, "agent", "skills", "explicit-expansion-test");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: explicit-expansion-test\ndescription: Proves explicit skill expansion\ndisable-model-invocation: true\n---\n\nFollow the hidden skill body.\n",
    );
    const settled = new Promise<void>((resolve) => {
      driver.subscribe((event) => {
        if (event.type === "update" && event.update.kind === "agent_settled") resolve();
      });
    });
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    await driver.setModel({ provider: "stub", id: "stub-1" });

    await driver.prompt([{ type: "text", text: "/skill:explicit-expansion-test preserve these arguments" }]);
    await settled;

    const request = JSON.stringify(stub.requests[0]);
    expect(request).toContain("Follow the hidden skill body.");
    expect(request).toContain("preserve these arguments");
    expect(request).not.toContain("/skill:explicit-expansion-test");
  }, 60_000);

  it("reports this prompt accepted before its user message turn settles", async () => {
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    await driver.setModel({ provider: "stub", id: "stub-1" });

    const release = stub.holdNextResponse();
    let promptSettled = false;
    let acceptedCount = 0;
    let markAccepted = () => {};
    const accepted = new Promise<void>((resolve) => (markAccepted = resolve));
    const userEnded = new Promise<void>((resolve) => {
      driver.subscribe((event) => {
        if (event.type === "update" && event.update.kind === "message_end" && event.update.role === "user") resolve();
      });
    });
    const running = driver.prompt([{ type: "text", text: "acknowledge this invocation" }], {
      onAccepted: () => {
        acceptedCount += 1;
        markAccepted();
      },
    }).then((result) => {
      promptSettled = true;
      return result;
    });

    await accepted;
    await userEnded;
    // The durable user event has arrived, but the provider response and the
    // whole `prompt()` promise remain held: acceptance is not completion.
    expect(promptSettled).toBe(false);
    expect(acceptedCount).toBe(1);
    release();
    expect(await running).toEqual({ accepted: true, queued: false });
    expect(acceptedCount).toBe(1);
  }, 60_000);

  it("keeps the accepted engine run alive when its observer throws", async () => {
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    await driver.setModel({ provider: "stub", id: "stub-1" });
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await driver.prompt([{ type: "text", text: "still run" }], {
        onAccepted: () => { throw new Error("publication failed"); },
      });
      expect(result).toEqual({ accepted: true, queued: false });
      expect(stub.requests).toHaveLength(1);
      expect(reported).toHaveBeenCalledWith(
        expect.stringContaining("could not publish an accepted prompt"),
        "publication failed",
      );
    } finally {
      reported.mockRestore();
    }
  }, 60_000);

  it("streams a reply from a stub provider as ordered session updates", async () => {
    const updates: SessionUpdate[] = [];
    const snapshots: Array<ReturnType<StableSdkDriver["entries"]>> = [];
    const settled = new Promise<void>((resolve) => {
      driver.subscribe((e: DriverEvent) => {
        if (e.type !== "update") return;
        updates.push(e.update);
        if (e.update.kind === "text_delta") snapshots.push(driver.entries({ live: true }));
        if (e.update.kind === "agent_settled") resolve();
      });
    });

    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });

    const state = await driver.setModel({ provider: "stub", id: "stub-1" });
    expect(state.model).toMatchObject({ provider: "stub", id: "stub-1" });

    const result = await driver.prompt([{ type: "text", text: "say hello" }]);
    expect(result).toEqual({ accepted: true, queued: false });
    await settled;
    const captured = await Promise.all(snapshots);
    expect(captured[0]?.live?.message?.value).toMatchObject({ content: [{ type: "text", text: REPLY[0] }] });
    expect(captured.at(-1)?.live?.message?.value).toMatchObject({ content: [{ type: "text", text: REPLY.join("") }] });
    expect(new Set(captured.map(snapshot => snapshot.live?.message?.id)).size).toBe(1);
    expect((await driver.entries({ live: true })).live).toEqual({ running: false, tools: [] });

    // The provider saw our prompt.
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(sent.messages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(sent.messages.at(-1)?.content)).toContain("say hello");

    // Updates arrive in lifecycle order. The user message's message_start/end
    // precede the assistant stream, so anchor on the first text delta.
    const kinds = updates.map((u) => u.kind);
    const first = (k: string) => kinds.indexOf(k);
    const firstDelta = first("text_delta");
    const assistantEnd = kinds.indexOf("message_end", firstDelta);
    expect(first("agent_start")).toBeGreaterThanOrEqual(0);
    expect(first("agent_start")).toBeLessThan(first("turn_start"));
    expect(first("turn_start")).toBeLessThan(firstDelta);
    expect(firstDelta).toBeLessThan(assistantEnd);
    expect(assistantEnd).toBeLessThan(first("agent_end"));
    expect(first("agent_end")).toBeLessThan(first("agent_settled"));

    // Deltas reassemble to the stub's reply.
    const text = updates
      .filter((u): u is Extract<SessionUpdate, { kind: "text_delta" }> => u.kind === "text_delta")
      .map((u) => u.delta)
      .join("");
    expect(text).toBe(REPLY.join(""));

    // Persistence: the sandboxed session file holds the user and assistant messages.
    const files = readdirSync(join(base, "sessions"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(base, "sessions", files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const roles = lines.filter((l) => l.type === "message").map((l) => l.message.role);
    expect(roles).toEqual(expect.arrayContaining(["user", "assistant"]));
    // The user message_end says where the prompt landed — the entry Pi wrote
    // for it, id and parent — and says so before the reply starts streaming,
    // not when the turn ends (M13-T44). The tree on disk is the witness.
    const userEnd = updates.find((u): u is Extract<SessionUpdate, { kind: "message_end" }> => u.kind === "message_end" && u.role === "user");
    const userEntry = lines.find((l) => l.type === "message" && l.message.role === "user");
    expect(userEnd?.entry).toEqual({ id: userEntry.id, parentId: userEntry.parentId });
    expect(updates.indexOf(userEnd!)).toBeLessThan(firstDelta);
    expect(updates.indexOf(userEnd!)).toBeGreaterThan(first("message_start"));
    // Assistant messages carry no entry: the field is about prompts.
    expect(updates.find((u) => u.kind === "message_end" && u.role === "assistant")).not.toHaveProperty("entry");
    // Note: Pi emits `entry_appended` only for extension custom entries
    // (pi.appendEntry), never for message persistence. Transcript state must be
    // built from message_*/tool_execution_* events, not from entry_appended.
    expect(kinds).not.toContain("entry_appended");

    // Final state snapshot reflects the finished turn.
    const last = updates.filter((u) => u.kind === "state").at(-1);
    expect(last).toBeDefined();
    if (last?.kind === "state") {
      expect(last.state.isStreaming).toBe(false);
      expect(last.state.messageCount).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);

  it("forks at a user entry into a new session file and keeps serving it", async () => {
    const settled = () =>
      new Promise<void>((resolve) => {
        const off = driver.subscribe((e) => {
          if (e.type === "update" && e.update.kind === "agent_settled") { off(); resolve(); }
        });
      });
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    await driver.setModel({ provider: "stub", id: "stub-1" });
    const first = driver.state().path;

    let done = settled();
    await driver.prompt([{ type: "text", text: "one" }]);
    await done;
    done = settled();
    await driver.prompt([{ type: "text", text: "two" }]);
    await done;

    const { entries, leafId } = (await driver.entries()) as unknown as {
      entries: Array<{ type: string; id: string; message?: { role: string } }>;
      leafId: string | null;
    };
    const firstUser = entries.find((e) => e.type === "message" && e.message?.role === "user")!;
    expect(firstUser).toBeDefined();
    // The leaf is the branch in play: a session nobody has navigated sits on its last entry.
    expect(leafId).toBe(entries.at(-1)!.id);

    const { state, editorText } = await driver.fork(firstUser.id);
    expect(state.path).not.toBe(first);
    expect(state.path.startsWith(join(base, "sessions"))).toBe(true);
    // Fork happens before the entry: history up to it is kept, the entry's text comes back for editing.
    expect(state.messageCount).toBeLessThan(4);
    expect(editorText).toBe("one");

    // The forked session is live: a new prompt streams into it.
    done = settled();
    await driver.prompt([{ type: "text", text: "three" }]);
    await done;
    expect(driver.state().path).toBe(state.path);
  }, 60_000);

  it("rejects a prompt while streaming unless a streaming behaviour is given", async () => {
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
    });
    await driver.setModel({ provider: "stub", id: "stub-1" });

    const settled = new Promise<void>((resolve) => {
      driver.subscribe((e) => {
        if (e.type === "update" && e.update.kind === "agent_settled") resolve();
      });
    });
    const running = driver.prompt([{ type: "text", text: "one" }]);
    // While the first prompt is in flight, a bare second prompt is refused and
    // its invocation never receives an acceptance acknowledgement.
    let refusedAccepted = 0;
    const refused = await driver.prompt([{ type: "text", text: "two" }], { onAccepted: () => { refusedAccepted += 1; } });
    expect(refused.accepted).toBe(false);
    expect(refusedAccepted).toBe(0);
    await running;
    await settled;
  }, 60_000);
});
