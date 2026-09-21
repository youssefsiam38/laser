/**
 * What a message mentioned reaches the model — for that message (M21-T9/T17).
 *
 * The host validates every project-work mention a person's words carry and
 * hands the worker a bounded projection. This proves the rest of the promise
 * against the **real engine** and a stub provider, because the only proof that
 * matters is what the provider was actually sent:
 *
 *   1. three sends with byte-identical text — a prompt, a steer and a
 *      follow-up, each mentioning something different — put each projection
 *      beside its own message and nobody else's;
 *   2. the conversation on disk keeps the person's words and no projection:
 *      a mention is captured by reference, never copied into the session file;
 *   3. a later, unrelated prompt carries none of it;
 *   4. a session with **no project work of its own** — no bridge, no tools —
 *      still shows the model what its message mentioned, which is what makes a
 *      projectless chat and a cross-project mention useful (leap,
 *      "Cross-session mentions and context").
 */
import { PRODUCT_NAME, type ProjectWorkMentionProjection, type SessionUpdate } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { SessionMentionContext } from "../src/project-work/mentions.js";

const SAME_WORDS = "look at this again";

const KIND_OF: Record<string, "spec" | "research" | "design" | "plan" | "task"> = {
  SPEC: "spec",
  RES: "research",
  DES: "design",
  PLAN: "plan",
  TASK: "task",
};

function projection(key: string, title: string, excerpt: string): ProjectWorkMentionProjection {
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
    title,
    state: "in_progress",
    provenance: `[from Acme ${key}@3]`,
    fields: [{ label: "Outcome", value: `${key} outcome line` }],
    excerpt,
  };
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

interface StubRequest {
  messages: Array<{ role: string; content: unknown }>;
}

function startStubProvider(): Promise<{
  server: Server;
  url: string;
  requests: StubRequest[];
  holdNextResponse(): () => void;
}> {
  const requests: StubRequest[] = [];
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
      requests.push(JSON.parse(body) as StubRequest);
      if (responseGate) {
        const gate = responseGate;
        responseGate = undefined;
        await gate;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }));
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
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

/** Each user turn of one provider request, as `text` plus what followed it. */
function userTurns(request: StubRequest): Array<{ text: string; following: string }> {
  const texts = request.messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") return { role: message.role, text: content };
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("");
    return { role: message.role, text };
  });
  const turns: Array<{ text: string; following: string }> = [];
  texts.forEach((message, index) => {
    if (message.role !== "user" || message.text !== SAME_WORDS) return;
    turns.push({ text: message.text, following: texts[index + 1]?.text ?? "" });
  });
  return turns;
}

let base: string;
let driver: StableSdkDriver;
let mentions: SessionMentionContext;
let stub: Awaited<ReturnType<typeof startStubProvider>>;

function sessionFiles(): string {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(at, entry.name)) : [join(at, entry.name)],
    );
  return walk(join(base, "sessions"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mention-context-`));
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
  mentions = new SessionMentionContext();
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

async function open(): Promise<void> {
  await driver.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    mentionContext: mentions,
  });
  await driver.setModel({ provider: "stub", id: "stub-1" });
}

async function whenStreaming(): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = () => (driver.state().isStreaming ? resolve() : setTimeout(check, 10));
    check();
  });
}

describe("a mention's projection at the model call", () => {
  it("gives a prompt, a steer and a follow-up of identical words their own context", async () => {
    await open();
    const userEnds: Extract<SessionUpdate, { kind: "message_end" }>[] = [];
    driver.subscribe((event) => {
      if (event.type === "update" && event.update.kind === "message_end" && event.update.role === "user") {
        userEnds.push(event.update);
      }
    });
    const release = stub.holdNextResponse();
    const turn = driver.prompt([{ type: "text", text: SAME_WORDS }], {
      projectWork: [projection("TASK-44", "Rework the picker", "the picker excerpt")],
    });
    await whenStreaming();
    await driver.steer([{ type: "text", text: SAME_WORDS }], {
      projectWork: [projection("SPEC-7", "Composer rules", "the composer excerpt")],
    });
    await driver.followUp([{ type: "text", text: SAME_WORDS }], {
      projectWork: [projection("DES-3", "Landing screen", "the landing excerpt")],
    });
    release();
    await turn;

    // One provider request per message that entered the turn. Each user turn
    // is followed by its own context, and by nobody else's — which is the
    // whole claim, since all three messages are byte-identical.
    expect(stub.requests.length).toBeGreaterThanOrEqual(3);
    const last = userTurns(stub.requests.at(-1)!);
    expect(last).toHaveLength(3);
    expect(last[0]!.following).toContain("[from Acme TASK-44@3]");
    expect(last[0]!.following).toContain("the picker excerpt");
    expect(last[0]!.following).not.toContain("SPEC-7");
    expect(last[1]!.following).toContain("[from Acme SPEC-7@3]");
    expect(last[1]!.following).not.toContain("TASK-44");
    expect(last[2]!.following).toContain("[from Acme DES-3@3]");
    expect(last[2]!.following).not.toContain("SPEC-7");

    // The first request could only know about the first message.
    const first = JSON.stringify(stub.requests[0]);
    expect(first).toContain("TASK-44");
    expect(first).not.toContain("SPEC-7");
    expect(first).not.toContain("DES-3");

    // Captured by reference: the conversation keeps the person's words, and
    // no part of any projection.
    const stored = sessionFiles();
    expect(stored).toContain(SAME_WORDS);
    expect(stored).not.toContain("TASK-44");
    expect(stored).not.toContain("the picker excerpt");
    expect(stored).not.toContain("lasercode/project-work-mentions");
    // Routing identity stays inside the engine; the public settled frames still
    // identify the exact persisted entries and their addressable bodies.
    expect(userEnds).toHaveLength(3);
    expect.soft(JSON.stringify(userEnds)).not.toContain("correlationId");
    const persistedUsers = stored.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "message" && entry.message.role === "user");
    expect.soft(userEnds.map((update) => update.entry?.id)).toEqual(persistedUsers.map((entry) => entry.id));
    expect.soft(userEnds.every((update) => (update.entry?.bodies?.length ?? 0) > 0)).toBe(true);

    // The turn settled, so the next message starts with nothing owed to it.
    stub.requests.length = 0;
    await driver.prompt([{ type: "text", text: "something else entirely" }]);
    const after = JSON.stringify(stub.requests);
    expect(after).toContain("something else entirely");
    expect(after).not.toContain("TASK-44");
    expect(after).not.toContain("SPEC-7");
    expect(after).not.toContain("DES-3");
    expect(mentions.held()).toEqual([]);
  }, 60_000);

  it("reads a mention in a session that has no project work of its own", async () => {
    // No `projectWork` bridge is passed at all: this session registers no
    // lifecycle tool and has no project, and still receives what it mentioned.
    await open();
    await driver.prompt([{ type: "text", text: "what does this say" }], {
      projectWork: [projection("SPEC-7", "Composer rules", "the composer excerpt")],
    });

    const sent = JSON.stringify(stub.requests);
    expect(sent).toContain("[from Acme SPEC-7@3]");
    expect(sent).toContain("the composer excerpt");
    expect(sent).not.toContain("inspect_project_work\",\"description");
    expect(sessionFiles()).not.toContain("the composer excerpt");
  }, 60_000);

  it("does not lose a queued message's context when the turn it waited behind is cancelled", async () => {
    await open();
    const release = stub.holdNextResponse();
    const turn = driver.prompt([{ type: "text", text: "start working" }]);
    await whenStreaming();
    await driver.followUp([{ type: "text", text: "and then this" }], {
      projectWork: [projection("TASK-44", "Rework the picker", "the picker excerpt")],
    });
    // Waiting in the engine's queue, not read by anything yet.
    expect(mentions.held()).toEqual([
      expect.objectContaining({ lane: "followUp", state: "pending", mentions: 1 }),
    ]);

    // The person stops the running turn, exactly as pressing Stop mid-answer
    // does. Stopping is not clearing: the message they wrote is still theirs,
    // and the engine runs it next — with what it mentioned beside it.
    const stopped = driver.abort();
    release();
    await turn.catch(() => undefined);
    await stopped.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const delivered = stub.requests.map((request) => JSON.stringify(request)).filter((body) => body.includes("and then this"));
    expect(delivered.length, "the queued message reached the model after the stop").toBeGreaterThan(0);
    expect(delivered.at(-1)).toContain("[from Acme TASK-44@3]");
    expect(delivered.at(-1)).toContain("the picker excerpt");
  }, 60_000);

  it("drops exactly the queued messages the person cleared", async () => {
    await open();
    const release = stub.holdNextResponse();
    const turn = driver.prompt([{ type: "text", text: "start working" }]);
    await whenStreaming();
    await driver.followUp([{ type: "text", text: "and then this" }], {
      projectWork: [projection("TASK-44", "Rework the picker", "the picker excerpt")],
    });
    expect(mentions.held()).toHaveLength(1);

    await driver.clearQueue();
    expect(mentions.held(), "the message is gone, so what it mentioned goes with it").toEqual([]);

    release();
    await turn;
    const sent = JSON.stringify(stub.requests);
    expect(sent).not.toContain("TASK-44");
  }, 60_000);
});
