/**
 * M0-T4 done-when: a prompt against a stub provider yields session updates in
 * order. A tiny local HTTP server speaks the OpenAI chat-completions streaming
 * format; Pi is pointed at it through a sandboxed models.json.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../src/driver.js";
import type { SessionUpdate } from "@piorbit/protocol";

const REPLY = ["Hel", "lo ", "from ", "stub"];

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function startStubProvider(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
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
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

let base: string;
let driver: StableSdkDriver;
let stub: Awaited<ReturnType<typeof startStubProvider>>;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "piorbit-prompt-"));
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
  it("streams a reply from a stub provider as ordered session updates", async () => {
    const updates: SessionUpdate[] = [];
    const settled = new Promise<void>((resolve) => {
      driver.subscribe((e: DriverEvent) => {
        if (e.type !== "update") return;
        updates.push(e.update);
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

    const entries = (await driver.entries()) as Array<{ type: string; id: string; message?: { role: string } }>;
    const firstUser = entries.find((e) => e.type === "message" && e.message?.role === "user")!;
    expect(firstUser).toBeDefined();

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
    // While the first prompt is in flight, a bare second prompt is refused; a steer is accepted.
    const refused = await driver.prompt([{ type: "text", text: "two" }]);
    expect(refused.accepted).toBe(false);
    await running;
    await settled;
  }, 60_000);
});
