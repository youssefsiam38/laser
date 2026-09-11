/**
 * M13-T46 — Edit, Fork and Jump while a turn is running.
 *
 * Against the real engine (pinned in package.json), with a stub provider
 * that streams one word and then holds the connection open, so every call
 * below happens mid-turn. What was established here, and what the driver's
 * `stopFirst` is built on:
 *
 *   - `navigateTree` mid-turn throws ("Wait for the current response to
 *     finish"); it neither waits nor answers `cancelled`.
 *   - `abort()` settles the turn: the partial reply ends with
 *     `stopReason: "aborted"`, then `agent_end`, `agent_settled`, exactly the
 *     row the Stop button leaves. After it the leaf moves.
 *   - The engine's own `fork` mid-turn aborts the original inside its
 *     teardown, *after* validating. A no-agent resource-preview driver remains
 *     lazy, so its first reply still has no file and is refused unchanged.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import type { SessionUpdate } from "@lasercode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

interface Stub {
  server: Server;
  url: string;
  requests: unknown[];
  /** Request numbers (1-based) whose stream was closed by the client. */
  closed: number[];
  /** Requests numbered from here on stream "partial " and then hold. */
  holdFrom: number;
}

/** Streams "done" and finishes, or "partial " and waits until the client hangs up. */
function startStubProvider(holdFrom: number): Promise<Stub> {
  const stub: Partial<Stub> = { requests: [], closed: [], holdFrom };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const n = stub.requests!.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      if (n < stub.holdFrom!) {
        res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }));
        res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "partial " }, finish_reason: null }] }));
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 200);
      res.on("close", () => {
        clearInterval(keepAlive);
        stub.closed!.push(n);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ ...(stub as Stub), server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

let base: string;
let driver: StableSdkDriver;
let stub: Stub;
let updates: SessionUpdate[];

const boot = async (holdFrom: number) => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-midturn-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  stub = await startStubProvider(holdFrom);
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
  updates = [];
  driver.subscribe((e) => {
    if (e.type === "update") updates.push(e.update);
  });
  await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
  await driver.setModel({ provider: "stub", id: "stub-1" });
};

afterEach(async () => {
  await driver.dispose().catch(() => {});
  stub.server.closeAllConnections();
  await new Promise<void>((r) => stub.server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

const until = (kind: SessionUpdate["kind"]) =>
  new Promise<void>((resolve) => {
    const off = driver.subscribe((e) => {
      if (e.type === "update" && e.update.kind === kind) {
        off();
        resolve();
      }
    });
  });

/** A turn that has produced its first word and is still streaming. */
const streamingTurn = async (text: string) => {
  const delta = until("text_delta");
  const turn = driver.prompt([{ type: "text", text }]);
  await delta;
  expect(driver.state().isStreaming).toBe(true);
  // Wrapped: returning the promise itself from an async function would await the whole turn.
  return { turn };
};

/** A turn that finishes on its own (the stub answers "done"). */
const finishedTurn = async (text: string) => {
  const settled = until("agent_settled");
  await driver.prompt([{ type: "text", text }]);
  await settled;
};

type Entry = { type: string; id: string; parentId: string | null; message?: { role: string; content?: unknown; stopReason?: string } };
const userEntries = async () => {
  const { entries } = await driver.entries();
  return (entries as Entry[]).filter((e) => e.type === "message" && e.message?.role === "user");
};
const onDisk = (path: string): Entry[] => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Entry);
const kinds = (from: number) => updates.slice(from).map((u) => (u.kind === "message_end" ? `${u.kind}:${u.role}:${u.stopReason ?? ""}` : u.kind));
const abortedReply = (from: number) => updates.slice(from).find((u) => u.kind === "message_end" && u.role === "assistant");
/** The provider sees the hang-up a tick after the engine aborts. */
const closedRequests = async (): Promise<number[]> => {
  for (let i = 0; i < 50 && stub.closed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  return [...stub.closed];
};

describe("moving the leaf while a turn runs (real engine)", () => {
  describe("navigate", () => {
    it("is refused by the engine mid-turn, and the turn keeps running", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const [user] = await userEntries();
      await expect(driver.navigateTree(user!.id)).rejects.toThrow(/Wait for the current response/);
      expect(driver.state().isStreaming).toBe(true);
      expect(stub.closed).toEqual([]);
      await driver.abort();
      await turn;
    }, 30_000);

    it("with stopFirst: stops the turn — recorded as `aborted`, like the Stop button — then moves", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const [user] = await userEntries();
      const from = updates.length;
      const moved = await driver.navigateTree(user!.id, { stopFirst: true });
      await turn;
      expect(moved).toEqual({ cancelled: false, editorText: "one" });
      expect(driver.state().isStreaming).toBe(false);
      // The provider request was actually cut, not left streaming somewhere.
      expect(await closedRequests()).toEqual([1]);
      // The transcript's record of the stop, in the order a Stop press leaves.
      expect(abortedReply(from)).toMatchObject({ stopReason: "aborted" });
      expect(kinds(from)).toEqual(expect.arrayContaining(["message_end:assistant:aborted", "agent_end", "agent_settled"]));
      expect(kinds(from).indexOf("message_end:assistant:aborted")).toBeLessThan(kinds(from).indexOf("agent_settled"));
      // The leaf is before the prompt; the abandoned branch stays in the file.
      const { entries, leafId } = await driver.entries();
      expect(leafId).toBe(user!.parentId);
      const partial = (entries as Entry[]).find((e) => e.message?.role === "assistant");
      expect(partial).toMatchObject({ parentId: user!.id, message: { stopReason: "aborted" } });
      expect(onDisk(driver.state().path).some((e) => e.message?.role === "assistant" && e.message.stopReason === "aborted")).toBe(true);
    }, 30_000);

    it("with stopFirst: a move that fails leaves the session stopped and unmoved", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const before = await driver.entries();
      const from = updates.length;
      await expect(driver.navigateTree("no-such-entry", { stopFirst: true })).rejects.toThrow(/not found/);
      await turn;
      expect(driver.state().isStreaming).toBe(false);
      expect(abortedReply(from)).toMatchObject({ stopReason: "aborted" });
      const after = await driver.entries();
      // Stopped: the aborted reply is the only new entry. Unmoved: the leaf is that reply.
      expect(after.entries.length).toBe(before.entries.length + 1);
      expect(after.leafId).toBe((after.entries.at(-1) as Entry).id);
      expect((after.entries.at(-1) as Entry).message?.stopReason).toBe("aborted");
    }, 30_000);

    it("with stopFirst on an idle session: nothing to stop, the move happens", async () => {
      await boot(2);
      await finishedTurn("one");
      const [user] = await userEntries();
      const from = updates.length;
      const moved = await driver.navigateTree(user!.id, { stopFirst: true });
      expect(moved).toEqual({ cancelled: false, editorText: "one" });
      expect(kinds(from)).not.toContain("message_end:assistant:aborted");
    }, 30_000);
  });

  describe("fork", () => {
    it("the engine's own fork mid-turn (second turn) aborts the original inside its teardown", async () => {
      await boot(2);
      await finishedTurn("one");
      const { turn } = await streamingTurn("two");
      const original = driver.state().path;
      const [, second] = await userEntries();
      const from = updates.length;
      const result = await driver.fork(second!.id);
      await turn;
      expect(result.state.path).not.toBe(original);
      expect(driver.state().isStreaming).toBe(false);
      expect(await closedRequests()).toEqual([2]);
      // The original's transcript records the stop before the runtime is
      // replaced — the same sequence a Stop press leaves, then the fork's state.
      expect(kinds(from)).toEqual(["message_end:assistant:aborted", "turn_end", "agent_end", "state", "agent_settled", "state"]);
      expect(onDisk(original).some((e) => e.message?.role === "assistant" && e.message.stopReason === "aborted")).toBe(true);
      expect(onDisk(result.state.path).some((e) => e.message?.stopReason === "aborted")).toBe(false);
    }, 30_000);

    it("a no-agent preview driver remains lazy, so its first-turn fork is refused and keeps running", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const [user] = await userEntries();
      expect(existsSync(driver.state().path)).toBe(false);
      await expect(driver.fork(user!.id)).rejects.toThrow(/not been saved yet/);
      expect(driver.state().isStreaming).toBe(true);
      expect(stub.closed).toEqual([]);
      await driver.abort();
      await turn;
    }, 30_000);

    it("with stopFirst: stops (recorded), and forks — even during the first turn", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const original = driver.state().path;
      const [user] = await userEntries();
      const from = updates.length;
      const result = await driver.fork(user!.id, { stopFirst: true });
      await turn;
      expect(result.state.path).not.toBe(original);
      expect(result.editorText).toBe("one");
      expect(driver.state().path).toBe(result.state.path);
      expect(driver.state().isStreaming).toBe(false);
      expect(await closedRequests()).toEqual([1]);
      // The stop is recorded on the original, before any state for the fork.
      const seen = kinds(from);
      expect(abortedReply(from)).toMatchObject({ stopReason: "aborted" });
      expect(seen.indexOf("message_end:assistant:aborted")).toBeLessThan(seen.indexOf("agent_settled"));
      const originalFile = onDisk(original);
      expect(originalFile.some((e) => e.message?.role === "assistant" && e.message.stopReason === "aborted")).toBe(true);
      // The fork holds the history before the prompt: no reply, so (the
      // engine writes a file on its first reply) nothing on disk yet.
      expect(existsSync(result.state.path)).toBe(false);
      // The fork is live: a new prompt streams into it, not into the original.
      const { turn: next } = await streamingTurn("three");
      await driver.abort();
      await next;
      expect(onDisk(original).filter((e) => e.message?.role === "user").map((e) => e.id)).toEqual([user!.id]);
      const fork = onDisk(result.state.path);
      expect(fork.some((e) => e.id === user!.id)).toBe(false);
      expect(fork.filter((e) => e.message?.role === "user").map((e) => (e.message?.content as Array<{ text: string }>)[0]?.text)).toEqual(["three"]);
    }, 30_000);

    it("with stopFirst: a fork that fails leaves the original stopped, served and unmodified", async () => {
      await boot(1);
      const { turn } = await streamingTurn("one");
      const original = driver.state().path;
      const from = updates.length;
      await expect(driver.fork("no-such-entry", { stopFirst: true })).rejects.toThrow(/Invalid entry/);
      await turn;
      expect(driver.state().path).toBe(original);
      expect(driver.state().isStreaming).toBe(false);
      expect(abortedReply(from)).toMatchObject({ stopReason: "aborted" });
      const { entries, leafId } = await driver.entries();
      expect(leafId).toBe((entries.at(-1) as Entry).id);
      expect((entries.at(-1) as Entry).message?.stopReason).toBe("aborted");
      // Still served: the next prompt goes into this session.
      const { turn: next } = await streamingTurn("two");
      await driver.abort();
      await next;
      expect(driver.state().path).toBe(original);
      expect(onDisk(original).filter((e) => e.message?.role === "user")).toHaveLength(2);
    }, 30_000);
  });
});
