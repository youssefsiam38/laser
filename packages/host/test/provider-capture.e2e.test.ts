/**
 * RP-7 end to end: a real worker, the real companion extension, the real fd-3
 * link and the real store.
 *
 * Everything else about captures is tested at a seam — the producer on its
 * own, the accumulator on its own. This is the one that proves the path a
 * person actually gets: Pi builds a provider request, the companion redacts
 * and chunks it, the chunks cross the pipe the host decodes, the host
 * reassembles and stores them, and the row reads back byte for byte. No
 * capture message reaches a client on the way.
 *
 * The provider is the repository's credential-free stub. Requires
 * `pnpm -r build`; skipped otherwise, like the other end-to-end tests here.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage, LogPage, SessionState } from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";
import { LOCAL_ACCESS } from "./actors.js";

/** One streamed reply, whatever is asked; the request is what this test reads. */
function stubProvider(): Promise<{ server: Server; url: string; bodies: number[] }> {
  const bodies: number[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      bodies.push(Buffer.byteLength(body, "utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, bodies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })),
  );
}

let base: string;
let host: HostServer;
let stub: Awaited<ReturnType<typeof stubProvider>>;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-capture-e2e-`));
  for (const dir of ["project", "agent"]) mkdirSync(join(base, dir), { recursive: true });
  stub = await stubProvider();
  writeFileSync(
    join(base, "agent", "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          // Large enough that a multi-megabyte prompt is not compacted or
          // refused before it becomes a provider request.
          models: [{ id: "stub-1", contextWindow: 100_000_000, maxTokens: 500 }],
          apiKey: "k",
        },
      },
    }),
  );
  writeFileSync(
    join(base, "agent", "settings.json"),
    JSON.stringify({ enabledModels: ["stub/stub-1"], compaction: { enabled: false } }),
  );
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    log: () => {},
  });
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!existsSync(defaultWorkerMain()))("a large provider capture, end to end", () => {
  it("crosses a real worker's link in chunks and is stored byte for byte", async () => {
    const { url } = await host.listen();
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const inbound: JsonRpcMessage[] = [];
    socket.on("message", (data) => inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const send = (() => {
      let id = 1;
      return <R>(method: string, params: unknown): Promise<R> =>
        new Promise<R>((resolve, reject) => {
          const mine = id++;
          const onMessage = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as { id?: number; result?: R; error?: { message: string } };
            if (message.id !== mine) return;
            socket.off("message", onMessage);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result as R);
          };
          socket.on("message", onMessage);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }));
        });
    })();

    const cwd = join(base, "project");
    await send("pi/project/add", { cwd });
    await send("pi/project/trust", { cwd, trusted: true });
    const { state } = await send<{ state: SessionState }>("session/new", { cwd });

    // A prompt large enough that the request Pi builds is past the chunking
    // threshold: it travels as `begin`/`chunk`/`end` over the real fd-3 link.
    const marker = `${PRODUCT_NAME}-e2e-capture-marker`;
    const prompt = `${marker} ${"The quick brown fox jumps over the lazy dog. ".repeat(60_000)}`;
    await send("session/prompt", { path: state.path, content: [{ type: "text", text: prompt }] });
    await expect
      .poll(async () => (await send<{ state: SessionState }>("session/load", { path: state.path })).state.isStreaming === false, {
        timeout: 120_000,
      })
      .toBe(true);

    // The provider really received a multi-megabyte request.
    expect(Math.max(...stub.bodies)).toBeGreaterThan(1024 * 1024);

    // And the store has it, reassembled from the chunks the worker sent.
    const query = await host.router.handle(
      { jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: state.path, limit: 20 } },
      LOCAL_ACCESS,
    );
    const rows = (query.result as LogPage).entries;
    const stored = rows.filter((entry) => (entry.detailRef?.bytes ?? 0) > 1024 * 1024).pop();
    expect(stored, `no chunked capture was recorded: ${JSON.stringify(rows.map((row) => row.detailRef?.bytes ?? 0))}`).toBeDefined();

    const content = await host.router.handle(
      { jsonrpc: "2.0", id: 2, method: "pi/logs/content", params: { ref: stored!.detailRef!.ref, maxBytes: 8 * 1024 * 1024 } },
      LOCAL_ACCESS,
    );
    expect(content.error, `content read failed: ${JSON.stringify(content.error)}`).toBeUndefined();
    const body = (content.result as { text: string; released?: unknown }).text;
    expect((content.result as { released?: unknown }).released).toBeUndefined();
    expect(Buffer.byteLength(body, "utf8")).toBe(stored!.detailRef!.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(stored!.detailRef!.ref);
    expect(body).toContain(marker);

    // A bounded read of the same body is a prefix of it, and says so.
    const partial = await host.router.handle(
      { jsonrpc: "2.0", id: 3, method: "pi/logs/content", params: { ref: stored!.detailRef!.ref, maxBytes: 256 * 1024 } },
      LOCAL_ACCESS,
    );
    const short = partial.result as { text: string; truncated: boolean; truncatedAt?: number; bytes: number };
    expect(short.truncated).toBe(true);
    expect(short.truncatedAt).toBeLessThanOrEqual(256 * 1024);
    expect(short.bytes).toBe(stored!.detailRef!.bytes);
    expect(body.startsWith(short.text)).toBe(true);

    // A near-ceiling capture, completed for real. Prompts grow the
    // conversation until one request is within a couple of megabytes of the
    // 16 MiB ceiling; the producer sends it cooperatively, the host reassembles
    // it, and the store keeps all of it. The public content RPC caps one read
    // at 8 MiB, so the prefix is verified through it and the whole body is
    // verified through the store itself — never assembled through a client.
    const store = host.logs!;
    let nearCeiling: { ref: string; bytes: number } | undefined;
    let ceiling: { reason: string; bytes?: number; sha256?: string } | undefined;
    for (let turn = 0; turn < 10 && !ceiling; turn++) {
      await send("session/prompt", { path: state.path, content: [{ type: "text", text: `${marker} ${turn}: ${"y".repeat(2 * 1024 * 1024)}` }] });
      await expect
        .poll(async () => (await send<{ state: SessionState }>("session/load", { path: state.path })).state.isStreaming === false, {
          timeout: 120_000,
        })
        .toBe(true);
      const page = await host.router.handle(
        { jsonrpc: "2.0", id: 100 + turn, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: state.path, limit: 50 } },
        LOCAL_ACCESS,
      );
      const newest = (page.result as LogPage).entries.at(-1);
      if (!newest?.detailRef) continue;
      const read = await host.router.handle(
        { jsonrpc: "2.0", id: 200 + turn, method: "pi/logs/content", params: { ref: newest.detailRef.ref, maxBytes: 8 * 1024 * 1024 } },
        LOCAL_ACCESS,
      );
      const released = (read.result as { released?: { reason: string; bytes?: number; sha256?: string } }).released;
      if (released?.reason === "over-ceiling") ceiling = released;
      else if (newest.detailRef.bytes > 12 * 1024 * 1024) nearCeiling = { ref: newest.detailRef.ref, bytes: newest.detailRef.bytes };
    }

    expect(nearCeiling, "no capture between 12 MiB and the ceiling completed").toBeDefined();
    // Through the store's own seam: every byte, its digest, and the chunk
    // integrity the read validates on the way.
    const whole = store.content(nearCeiling!.ref, 64 * 1024 * 1024);
    expect(whole.released).toBeUndefined();
    expect(whole.truncated).toBe(false);
    expect(Buffer.byteLength(whole.text, "utf8")).toBe(nearCeiling!.bytes);
    expect(createHash("sha256").update(whole.text).digest("hex")).toBe(nearCeiling!.ref);
    // And through the public RPC, which reads a bounded prefix of the same body.
    const prefix = await host.router.handle(
      { jsonrpc: "2.0", id: 300, method: "pi/logs/content", params: { ref: nearCeiling!.ref, maxBytes: 8 * 1024 * 1024 } },
      LOCAL_ACCESS,
    );
    const prefixRead = prefix.result as { text: string; truncated: boolean; truncatedAt?: number; bytes: number };
    expect(prefixRead.truncated).toBe(true);
    expect(prefixRead.bytes).toBe(nearCeiling!.bytes);
    expect(whole.text.startsWith(prefixRead.text)).toBe(true);

    // The ceiling case is still recorded, without a body, with what it knows.
    expect(ceiling, "no request past the 16 MiB ceiling was recorded").toBeDefined();
    expect(ceiling!.bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(ceiling!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // (The prompt's own text reaches the client as the transcript: that is the
    // conversation. A log row's digest reaches it through `pi/logs/append`,
    // which is the row, not the body. What must never cross is a capture
    // message.)
    const captureMessages = inbound.filter((message) => JSON.stringify(message).includes("provider/request/"));
    expect(captureMessages).toEqual([]);
    expect(captureMessages.length).toBe(0);
    socket.close();
  }, 180_000);
});
