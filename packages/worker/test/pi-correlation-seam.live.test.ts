/**
 * The engine seam that makes an admitted message identifiable (M21-T9/T17).
 *
 * Laser must put the host's bounded project-work projection in front of the
 * model *for the message that mentioned it*, including a message the person
 * queued behind a running turn. The pinned engine gives an extension no way to
 * tell one admitted message from another: `UserMessage` is
 * `{ role, content, timestamp }`, the context transform receives a
 * `structuredClone` (so object identity is gone), and the engine's own queue
 * bookkeeping matches by **text** (`agent-session.js` splices
 * `_steeringMessages.indexOf(messageText)`), which is exactly what cannot tell
 * two identical messages apart.
 *
 * So the pinned package carries one patch: an opaque `correlationId` the
 * embedder may attach to `prompt()`, `steer()` and `followUp()`, which rides on
 * the user message the engine creates. This test pins that contract against the
 * **real engine** and a stub provider, because a patch nobody tests is a patch
 * that silently disappears at the next pin bump:
 *
 *   1. three sends with byte-identical text — a direct prompt, a steer and a
 *      follow-up — arrive at the model as three messages that are told apart by
 *      their id alone, in the order the person sent them;
 *   2. the id never reaches the provider;
 *   3. the id never reaches the session file;
 *   4. the engine's *live* message keeps its id after the entry was written,
 *      because persistence strips a copy (the context hook below runs after the
 *      user `message_end` that persists it).
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

/** What the engine hands the context transform for one model call. */
interface ContextObservation {
  users: Array<{ text: string; correlationId?: string }>;
}

/** The engine's session, reached the way the driver's own tests reach it. */
interface EngineSession {
  isStreaming: boolean;
  prompt(text: string, options?: { correlationId?: string }): Promise<void>;
  steer(text: string, images?: undefined, options?: { correlationId?: string }): Promise<void>;
  followUp(text: string, images?: undefined, options?: { correlationId?: string }): Promise<void>;
}

const SAME_WORDS = "look at this again";

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

let base: string;
let driver: StableSdkDriver;
let stub: Awaited<ReturnType<typeof startStubProvider>>;
let observations: ContextObservation[];

/** Watches exactly what the model is about to read, at every model call. */
const watchContext: InlineExtension = (pi) => {
  pi.on("context", (event: { messages: unknown[] }) => {
    const users: ContextObservation["users"] = [];
    for (const message of event.messages as Array<{ role?: string; content?: unknown; correlationId?: string }>) {
      if (message.role !== "user") continue;
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
        .map((block) => block.text)
        .join("");
      users.push({ text, ...(message.correlationId !== undefined ? { correlationId: message.correlationId } : {}) });
    }
    observations.push({ users });
    return undefined;
  });
};

function sessionOf(target: StableSdkDriver): EngineSession {
  return (target as unknown as { session(): EngineSession }).session();
}

/** Every session file this test wrote, as text. */
function sessionFiles(): string {
  const dir = join(base, "sessions");
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(at, entry.name)) : [join(at, entry.name)],
    );
  return walk(dir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-correlation-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  observations = [];
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
  driver = new StableSdkDriver([watchContext]);
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

describe("the engine's correlation-id seam", () => {
  it("tells three identical messages apart at the model call, and leaks the id nowhere", async () => {
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    await driver.setModel({ provider: "stub", id: "stub-1" });
    const session = sessionOf(driver);

    // The first turn is held open at the provider, so the other two sends are
    // queued in the engine — the case no text or count can resolve, because
    // all three messages are byte-identical.
    const release = stub.holdNextResponse();
    const turn = session.prompt(SAME_WORDS, { correlationId: "c-direct" });
    await new Promise<void>((resolve) => {
      const check = () => (session.isStreaming ? resolve() : setTimeout(check, 10));
      check();
    });
    await session.steer(SAME_WORDS, undefined, { correlationId: "c-steer" });
    await session.followUp(SAME_WORDS, undefined, { correlationId: "c-follow" });
    release();
    await turn;

    // One model call per message, each reading exactly the messages admitted
    // before it, each told apart by its id alone.
    const seen = observations.map((observation) => observation.users.map((user) => user.correlationId));
    expect(seen).toEqual([["c-direct"], ["c-direct", "c-steer"], ["c-direct", "c-steer", "c-follow"]]);
    for (const observation of observations) {
      for (const user of observation.users) expect(user.text).toBe(SAME_WORDS);
    }

    // The direct message was persisted at its `message_end`, before the first
    // model call above — and it still carried its id there, so persistence
    // stripped a copy and left the engine's live message alone.
    expect(observations[0]?.users[0]?.correlationId).toBe("c-direct");

    // Nothing the provider received, and nothing on disk, knows about any of it.
    const payloads = JSON.stringify(stub.requests);
    expect(payloads).not.toContain("correlationId");
    expect(payloads).not.toContain("c-direct");
    expect(payloads).not.toContain("c-steer");
    expect(payloads).not.toContain("c-follow");
    const stored = sessionFiles();
    expect(stored).toContain(SAME_WORDS);
    expect(stored).not.toContain("correlationId");
    expect(stored).not.toContain("c-direct");
    expect(stored).not.toContain("c-steer");
    expect(stored).not.toContain("c-follow");
  }, 60_000);

  it("leaves a send with no id exactly as it was, and never invents one", async () => {
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    await driver.setModel({ provider: "stub", id: "stub-1" });

    await sessionOf(driver).prompt("no identity here");

    expect(observations.at(-1)?.users).toEqual([{ text: "no identity here" }]);
    expect(JSON.stringify(stub.requests)).not.toContain("correlationId");
    expect(sessionFiles()).not.toContain("correlationId");
  }, 60_000);
});
