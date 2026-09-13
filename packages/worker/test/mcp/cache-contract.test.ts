import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { adapterRoot, loadMcpEngine } from "../../src/mcp/engine.js";
import { mcpClientIdentity } from "../../src/mcp/identity.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CACHE_METHODS = new Set(["tools/list", "resources/list", "resources/templates/list", "prompts/list", "resources/read", "server/discover"]);

/** Pinned SDK wire codec, not the public era-neutral schemas with optional fields. */
async function modernResponseConstructor() {
  const require = createRequire(join(adapterRoot(), "index.ts"));
  // require.resolve selects the CJS conditional export. The same pinned
  // package ships its ESM entry beside it, which is what the engine imports.
  const clientEntry = join(dirname(require.resolve("@modelcontextprotocol/client")), "index.mjs");
  const chunk = readFileSync(clientEntry, "utf8").match(/from "(\.\/src-[^"]+\.mjs)"/u)?.[1];
  if (!chunk) throw new Error("Pinned SDK codec chunk was not found; inspect this dependency revision before changing the fixture.");
  // G is codecForVersion in the exact 3b205e7 SDK artifact. This is a test-only
  // pin; runtime negotiation and production validation are never changed.
  const { G: codecForVersion } = await import(pathToFileURL(join(dirname(clientEntry), chunk)).href);
  const codec = codecForVersion("2026-07-28");
  return (method: string, payload: Record<string, unknown>): Record<string, unknown> => {
    const result = payload.resultType === "input_required" ? payload : {
      ...(CACHE_METHODS.has(method) ? { ttlMs: 0, cacheScope: "private" } : {}),
      resultType: "complete", ...payload,
    };
    const decoded = codec.decodeResult(method, result);
    if (decoded.kind === "invalid") throw decoded.error;
    return result;
  };
}

async function fixture(modern = false) {
  const modernResponse = modern ? await modernResponseConstructor() : undefined;
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-cache-`));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  cleanups.push(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const streams = new Set<ServerResponse>();
  const responses: Array<{ method: string; envelope: unknown }> = [];
  let respond = (method: string, params?: Record<string, unknown>): unknown => {
    if (method === "tools/list") return { tools: [tool("old")], ttlMs: 0 };
    if (method === "resources/read") return { contents: [{ uri: params?.uri, text: "value" }], ttlMs: 1000, cacheScope: "private" };
    return undefined;
  };
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": listening\n\n"); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      requests.push({ method: message.method, ...(message.params ? { params: message.params } : {}) });
      const capabilities = { tools: { listChanged: true }, resources: {}, prompts: {} };
      const legacyDefaults: Record<string, unknown> = {
        initialize: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "cache-fixture", version: "1" } },
        "server/discover": { supportedVersions: ["2025-11-25"], capabilities, ttlMs: 1000, cacheScope: "private" },
        "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] }, "prompts/list": { prompts: [] }, ping: {},
      };
      const modernDefaults: Record<string, unknown> = {
        "server/discover": { supportedVersions: ["2026-07-28"], capabilities, ttlMs: 1000, cacheScope: "private" },
        "tools/list": { tools: [] }, "resources/list": { resources: [] },
        "resources/templates/list": { resourceTemplates: [] }, "prompts/list": { prompts: [] },
        "resources/read": { contents: [{ uri: message.params?.uri, text: "value" }] },
      };
      const defaults = modern ? modernDefaults : legacyDefaults;
      let envelope: unknown;
      try {
        const result = (respond(message.method, message.params) ?? defaults[message.method] ?? {}) as Record<string, unknown>;
        envelope = { result: modernResponse ? modernResponse(message.method, result) : result };
      } catch (error) {
        envelope = { error: { code: (error as { code?: number }).code ?? -32603, message: (error as Error).message } };
        console.error("Synthetic MCP fixture rejected response", message.method, envelope);
      }
      responses.push({ method: message.method, envelope });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...envelope as object }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { for (const stream of streams) stream.end(); server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const engine = await loadMcpEngine();
  const manager = new engine.Manager(base, mcpClientIdentity());
  cleanups.push(() => manager.closeAll());
  const connection = await manager.connect("fixture", { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, auth: false, protocolVersion: modern ? "2026-07-28" : "legacy" }).catch(error => {
    console.error("Synthetic MCP fixture setup transcript", responses);
    throw error;
  });
  const client = connection.client as any;
  let now = Date.now(); client._cache._now = () => now;
  return { client, manager, connection, requests, responses,
    set: (handler: typeof respond) => { respond = handler; },
    advance: (ms: number) => { now += ms; },
    notify: () => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`); },
  };
}

describe("pinned MCP cache contract over HTTP", () => {
  it("validates modern complete results with the pinned codec and preserves input-required envelopes", async () => {
    const complete = await modernResponseConstructor();
    const payloads: Record<string, Record<string, unknown>> = {
      "tools/list": { tools: [tool("sample")] }, "resources/list": { resources: [] },
      "resources/templates/list": { resourceTemplates: [] }, "prompts/list": { prompts: [] },
      "resources/read": { contents: [{ uri: "test://sample", text: "sample" }] },
      "server/discover": { supportedVersions: ["2026-07-28"], capabilities: {} },
    };
    for (const [method, payload] of Object.entries(payloads)) {
      expect(complete(method, payload)).toEqual({ resultType: "complete", ttlMs: 0, cacheScope: "private", ...payload });
      const input = { resultType: "input_required", requestState: "synthetic-interaction" };
      expect(complete(method, input)).toBe(input);
    }
    expect(() => complete("resources/read", { contents: [{ text: "missing URI" }] })).toThrow();
    expect(() => complete("tools/list", { resultType: "input_required" })).toThrow();
  });

  it("bounds an aggregate by the earliest page expiry and decays hints on cache hits", async () => {
    const f = await fixture();
    f.set((method, params) => {
      if (method !== "tools/list") return undefined;
      if (!params?.cursor) return { tools: [tool("first")], nextCursor: "next", ttlMs: 10_000, cacheScope: "private" };
      f.advance(200);
      return { tools: [tool("second")], ttlMs: 100, cacheScope: "private" };
    });
    const first = await f.client.listTools();
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["first", "second"]);
    expect(first.ttlMs).toBe(100);
    const calls = f.requests.length;
    f.advance(40); expect((await f.client.listTools()).ttlMs).toBe(60);
    expect(f.requests.length).toBe(calls);
    f.advance(61); await f.client.listTools();
    expect(f.requests.length).toBe(calls + 2);
  });

  it.each([undefined, 0, -1])("does not reuse tools without a positive TTL (%s)", async ttlMs => {
    const f = await fixture();
    f.set(method => method === "tools/list" ? { tools: [tool("value")], ...(ttlMs === undefined ? {} : { ttlMs }) } : undefined);
    await f.client.listTools(); const count = f.requests.length;
    await f.client.listTools(); expect(f.requests.length).toBe(count + 1);
  });

  it("rejects repeated cursors and mixed-scope pages without caching a partial result", async () => {
    const f = await fixture();
    f.set(method => method === "tools/list" ? { tools: [tool("partial")], nextCursor: "repeat", ttlMs: 10_000 } : undefined);
    await expect(f.client.listTools()).rejects.toThrow("repeated a page cursor");
    f.set((method, params) => method === "tools/list" ? params?.cursor
      ? { tools: [tool("private")], ttlMs: 10_000, cacheScope: "private" }
      : { tools: [tool("public")], nextCursor: "next", ttlMs: 10_000, cacheScope: "public" } : undefined);
    await expect(f.client.listTools()).rejects.toThrow("scopes disagree");
    f.set(method => method === "tools/list" ? { tools: [tool("complete")], ttlMs: 10_000 } : undefined);
    expect((await f.client.listTools()).tools.map((t: { name: string }) => t.name)).toEqual(["complete"]);
  });

  it("caches discovery and resource reads but never reuses an interactive resource request", async () => {
    const f = await fixture(true);
    await f.client.discover({ cacheMode: "refresh" }); const start = f.requests.length;
    await f.client.discover(); expect(f.requests.length).toBe(start);
    await f.client.readResource({ uri: "test://one" }).catch((error: unknown) => {
      console.error("Synthetic MCP fixture responses before resource-read failure", JSON.stringify(f.responses));
      throw error;
    }); const read = f.requests.length;
    await f.client.readResource({ uri: "test://one" }); expect(f.requests.length).toBe(read);
    await f.client.readResource({ uri: "test://one", requestState: "conditioned" }); expect(f.requests.length).toBe(read + 1);
    await f.client.readResource({ uri: "test://two" }); expect(f.requests.length).toBe(read + 2);
    f.advance(1001); await f.client.discover(); expect(f.requests.length).toBe(read + 3);
  });
});
