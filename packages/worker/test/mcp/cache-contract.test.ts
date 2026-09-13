import { createServer, type ServerResponse } from "node:http";
import { createJiti } from "jiti";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { adapterRoot, loadMcpEngine, type McpManager } from "../../src/mcp/engine.js";
import { McpAuthorizationRegistry, mcpAuthorizationIdentity } from "../../src/mcp/authorization.js";
import { McpInspector } from "../../src/mcp/inspector.js";
import { mcpClientIdentity } from "../../src/mcp/identity.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Cold adapter transpilation is setup, not the cache operation's five-second
// deadline. Load it under a disposable agent root before timing individual cases.
beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-cache-bootstrap-`));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  try { await loadMcpEngine(); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

it.each(["_listMaxPages", "_cache", "_cache._probe", "_cache._store.evict", "_onnotification", "listTools"])("refuses incompatible pinned SDK member %s before installing wrappers", async member => {
  const require = createRequire(join(adapterRoot(), "index.ts"));
  const { Client } = await import(pathToFileURL(join(dirname(require.resolve("@modelcontextprotocol/client")), "index.mjs")).href);
  const { installCacheContract } = await createJiti(import.meta.url, { fsCache: false }).import<{ installCacheContract: (client: unknown, invalidated: () => void) => unknown }>(join(adapterRoot(), "sdk-cache-contract.ts"));
  const client = new Client({ name: "fixture", version: "1" });
  const original = client._serveFromCache;
  const keys = member.split(".");
  let target = client;
  for (const key of keys.slice(0, -1)) target = target[key];
  target[keys.at(-1)!] = undefined;
  expect(() => installCacheContract(client, () => {})).toThrow(`Incompatible pi-mcp-adapter 2.33.0 / MCP client 3b205e7 cache contract: ${member}`);
  expect(client._serveFromCache).toBe(original);
});

it.each([0, -1, Infinity, NaN])("refuses an unsafe SDK pagination bound %s", async bound => {
  const require = createRequire(join(adapterRoot(), "index.ts"));
  const { Client } = await import(pathToFileURL(join(dirname(require.resolve("@modelcontextprotocol/client")), "index.mjs")).href);
  const { installCacheContract } = await createJiti(import.meta.url, { fsCache: false }).import<{ installCacheContract: (client: unknown, invalidated: () => void) => unknown }>(join(adapterRoot(), "sdk-cache-contract.ts"));
  const client = new Client({ name: "fixture", version: "1" });
  client._listMaxPages = bound;
  expect(() => installCacheContract(client, () => {})).toThrow("_listMaxPages must be a finite positive integer");
});

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
  const complete = (method: string, payload: Record<string, unknown>): Record<string, unknown> => {
    const result = payload.resultType === "input_required" ? payload : {
      ...(CACHE_METHODS.has(method) ? { ttlMs: 0, cacheScope: "private" } : {}),
      resultType: "complete", ...payload,
    };
    const decoded = codec.decodeResult(method, result);
    if (decoded.kind === "invalid") throw decoded.error;
    return result;
  };
  return Object.assign(complete, { notification(method: string, params: Record<string, unknown>) {
    const notification = { method, params };
    const decoded = codec.validateNotification(method, notification);
    if (decoded.kind === "invalid") throw decoded.error;
    return notification;
  } });
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
  const subscriptionIds = new WeakMap<ServerResponse, unknown>();
  const listening = Promise.withResolvers<void>();
  const responses: Array<{ method: string; envelope: unknown }> = [];
  let respond = (method: string, params?: Record<string, unknown>): unknown => {
    if (method === "tools/list") return { tools: [tool("old")], ttlMs: 0 };
    if (method === "resources/read") return { contents: [{ uri: params?.uri, text: "value" }], ttlMs: 1000, cacheScope: "private" };
    return undefined;
  };
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": listening\n\n"); streams.add(res); listening.resolve(); res.on("close", () => streams.delete(res)); return;
    }
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      requests.push({ method: message.method, ...(message.params ? { params: message.params } : {}) });
      if (modern && message.method === "subscriptions/listen") {
        // A subscription opens with an acknowledgement notification, not a
        // complete result (which would close it). Every delivery carries its ID.
        const acknowledgement = modernResponse!.notification("notifications/subscriptions/acknowledged", {
          _meta: { "io.modelcontextprotocol/subscriptionId": message.id }, notifications: message.params.notifications,
        });
        responses.push({ method: message.method, envelope: acknowledgement });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...acknowledgement })}\n\n`);
        streams.add(res); subscriptionIds.set(res, message.id); listening.resolve(); res.on("close", () => streams.delete(res));
        return;
      }
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
        const result = (await respond(message.method, message.params) ?? defaults[message.method] ?? {}) as Record<string, unknown>;
        envelope = { result: modernResponse ? modernResponse(message.method, result) : result };
      } catch (error) {
        envelope = { error: { code: (error as { code?: number }).code ?? -32603, message: (error as Error).message } };
        console.error("Synthetic MCP fixture rejected response", message.method, envelope);
      }
      responses.push({ method: message.method, envelope });
      const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...envelope as object });
      res.writeHead(200, { "content-type": "application/json" }); res.end(reply);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { for (const stream of streams) stream.end(); server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const engine = await loadMcpEngine();
  const manager = new engine.Manager(base, mcpClientIdentity());
  cleanups.push(() => manager.closeAll());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const connection = await manager.connect("fixture", { url, auth: false, protocolVersion: modern ? "2026-07-28" : "legacy" }).catch(error => {
    console.error("Synthetic MCP fixture setup transcript", responses);
    throw error;
  });
  const client = connection.client as any;
  let now = Date.now(); client._cache._now = () => now;
  return { client, manager, connection, requests, responses, base, url, streamCount: () => streams.size, listening: listening.promise,
    set: (handler: typeof respond) => { respond = handler; },
    advance: (ms: number) => { now += ms; },
    notify: () => { for (const stream of streams) {
      const method = "notifications/tools/list_changed";
      const notification = modernResponse ? modernResponse.notification(method, { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionIds.get(stream) } }) : { method };
      responses.push({ method, envelope: notification });
      stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...notification })}\n\n`);
    } },
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

  it("restarts an invalid cursor once and never publishes the abandoned prefix", async () => {
    const f = await fixture();
    let invalid = false;
    f.set((method, params) => {
      if (method !== "tools/list") return undefined;
      if (params?.cursor) { invalid = true; throw Object.assign(new Error("synthetic invalid cursor"), { code: -32602 }); }
      return { tools: [tool(invalid ? "replacement" : "abandoned")], ...(!invalid ? { nextCursor: "invalid" } : {}), ttlMs: 1000 };
    });
    const start = f.requests.length;
    expect((await f.client.listTools({}, { cacheMode: "refresh" })).tools.map((value: { name: string }) => value.name)).toEqual(["replacement"]);
    expect(f.requests.slice(start).map(request => request.params?.cursor)).toEqual([undefined, "invalid", undefined]);
    const end = f.requests.length;
    expect((await f.client.listTools()).tools.map((value: { name: string }) => value.name)).toEqual(["replacement"]);
    expect(f.requests.length).toBe(end);
  });

  it.each([false, true])("invalidates immediately and rejects an in-flight old walk before publishing added/removed tools (modern=%s)", async modern => {
    const f = await fixture(modern);
    await f.listening;
    f.set(method => method === "tools/list" ? { tools: [tool("old")], ttlMs: 1000 } : undefined);
    await f.client.listTools({}, { cacheMode: "refresh" });
    const started = Promise.withResolvers<void>();
    const oldReply = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<void>();
    let reads = 0;
    f.set(async method => {
      if (method !== "tools/list") return undefined;
      if (++reads === 1) { started.resolve(); await oldReply.promise; return { tools: [tool("old")], ttlMs: 1000 }; }
      await replacement.promise;
      return { tools: [tool("new")], ttlMs: 1000 };
    });
    const pending = f.client.listTools({}, { cacheMode: "refresh" });
    const outcome = pending.then(() => undefined, (error: Error) => error);
    await started.promise;
    f.notify();
    try {
      await vi.waitFor(() => expect(f.connection.tools).toEqual([]));
      expect(await f.client._cache.read("tools/list")).toBeUndefined();
      oldReply.resolve(); expect((await outcome)?.message).toContain("changed while it was being read");
      expect(f.connection.tools).toEqual([]);
      replacement.resolve();
      await vi.waitFor(() => expect(f.connection.tools.map(value => value.name)).toEqual(["new"]));
      const end = f.requests.length;
      expect((await f.client.listTools()).tools.map((value: { name: string }) => value.name)).toEqual(["new"]);
      expect(f.requests.length).toBe(end);
    } catch (error) {
      console.error("Synthetic notification transcript", JSON.stringify(f.responses)); throw error;
    } finally { oldReply.resolve(); replacement.resolve(); await outcome; }
  });

  it("keeps a failed notification refresh stale and recovers only from a successful replacement", async () => {
    const f = await fixture(); await f.listening;
    f.set(method => method === "tools/list" ? { tools: [tool("old")], ttlMs: 1000 } : undefined);
    await f.client.listTools({}, { cacheMode: "refresh" });
    f.set(method => { if (method === "tools/list") throw new Error("synthetic refresh failure"); return undefined; });
    f.notify();
    await vi.waitFor(() => expect(f.responses.some(value => value.method === "tools/list" && (value.envelope as { error?: unknown }).error)).toBe(true));
    expect(f.connection.tools).toEqual([]);
    expect(await f.client._cache.read("tools/list")).toBeUndefined();
    await expect(f.client.listTools()).rejects.toThrow("synthetic refresh failure");
    f.set(method => method === "tools/list" ? { tools: [tool("replacement")], ttlMs: 1000 } : undefined);
    f.notify();
    await vi.waitFor(() => expect(f.connection.tools.map(value => value.name)).toEqual(["replacement"]));
    expect((await f.client.listTools()).tools.map((value: { name: string }) => value.name)).toEqual(["replacement"]);
  });

  it("never reuses explicit input responses or a manually handled input-required resource result", async () => {
    const f = await fixture(true);
    f.set((method, params) => method === "resources/read" ? { contents: [{ uri: params?.uri, text: params?.inputResponses ? "conditioned" : "plain" }], ttlMs: 1000 } : undefined);
    expect((await f.client.readResource({ uri: "test://interactive", inputResponses: {} })).contents[0].text).toBe("conditioned");
    const afterRetry = f.requests.length;
    expect((await f.client.readResource({ uri: "test://interactive" })).contents[0].text).toBe("plain");
    expect(f.requests.length).toBe(afterRetry + 1);
    f.set(method => method === "resources/read" ? { resultType: "input_required", requestState: "continue", ttlMs: 1000 } : undefined);
    expect(await f.client.readResource({ uri: "test://interactive" }, { cacheMode: "refresh", allowInputRequired: true })).toMatchObject({ resultType: "input_required" });
    const start = f.requests.length;
    f.set((method, params) => method === "resources/read" ? { contents: [{ uri: params?.uri, text: "after-input" }], ttlMs: 1000 } : undefined);
    expect((await f.client.readResource({ uri: "test://interactive" })).contents[0].text).toBe("after-input");
    expect(f.requests.length).toBe(start + 1);
    // A later, independent complete reply is cacheable; neither the old plain
    // value nor the input-required envelope was reused to obtain it.
    expect((await f.client.readResource({ uri: "test://interactive" })).contents[0].text).toBe("after-input");
    expect(f.requests.length).toBe(start + 1);
  });

  it("discards a cold connection revoked while its initial tool list is in flight", async () => {
    const f = await fixture();
    const engine = await loadMcpEngine();
    const manager = new engine.Manager(f.base, mcpClientIdentity());
    cleanups.push(() => manager.closeAll());
    const registry = new McpAuthorizationRegistry(f.base);
    const snapshot = await registry.establish(await mcpAuthorizationIdentity("global", f.base, { name: "cold", transport: { kind: "http", url: f.url } }));
    manager.setAuthorizationGuard?.(async () => await registry.current(snapshot) ? undefined : "Access changed during connection");
    const published = vi.fn(); manager.setMetadataListChangedListener?.(published);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.set(async method => {
      if (method !== "tools/list") return undefined;
      entered.resolve(); await release.promise;
      return { tools: [tool("must_not_publish")], ttlMs: 60_000 };
    });
    const pending = manager.connect("cold", { url: f.url, auth: false });
    const refused = expect(pending).rejects.toThrow("Access changed");
    await entered.promise;
    await registry.bump(snapshot.identity);
    const discoveryRequests = f.requests.filter(request => request.method === "server/discover").length;
    release.resolve(); await refused;
    expect(f.requests.filter(request => request.method === "server/discover")).toHaveLength(discoveryRequests);
    expect(manager.getConnection("cold")).toBeUndefined();
    expect(published).not.toHaveBeenCalled();
    expect(f.requests.filter(request => request.method === "tools/call")).toHaveLength(0);
  });

  it("rereads one notification race without dropping the inspector connection", async () => {
    const f = await fixture();
    const inspector = new McpInspector(f.base, f.base); cleanups.push(() => inspector.dispose());
    const config = { name: "inspected", transport: { kind: "http" as const, url: f.url }, auth: { kind: "none" as const } };
    const target = { scope: "global" as const, config, secrets: new Map<string, string>() };
    expect((await inspector.inspect(target)).status).toBe("connected");
    await vi.waitFor(() => expect(f.streamCount()).toBe(2));
    const before = f.requests.filter(request => request.method === "initialize").length;
    const connection = (inspector as unknown as { manager: McpManager }).manager.getConnection(config.name)!;
    const list = vi.spyOn(connection.client, "listTools");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), refreshed = Promise.withResolvers<void>();
    let reads = 0;
    f.set(async method => {
      if (method !== "tools/list") return undefined;
      if (++reads === 1) { entered.resolve(); await release.promise; return { tools: [tool("old")], ttlMs: 0 }; }
      refreshed.resolve(); return { tools: [tool("replacement")], ttlMs: 60_000 };
    });
    const pending = inspector.inspect(target);
    await entered.promise; f.notify(); await refreshed.promise; release.resolve();
    const result = await pending;
    // Invalidation and successful notification publication are two revisions.
    // If both race the bounded reread, report retryable unknown, not failure.
    expect(["connected", "unknown"], JSON.stringify(result)).toContain(result.status);
    // The SDK also makes its own refresh-mode notification read; only the
    // inspector's signal-less reads count against its one-reread allowance.
    expect(list.mock.calls.filter(([, options]) => options === undefined)).toHaveLength(2);
    expect(list.mock.calls.filter(([, options]) => options !== undefined)).toHaveLength(1);
    expect(inspector.inspecting("global", config.name)).toBe(true);
    await vi.waitFor(() => expect(connection.tools.map(tool => tool.name)).toEqual(["replacement"]));
    const settled = await inspector.inspect(target);
    expect(settled.status, JSON.stringify(settled)).toBe("connected");
    expect(settled.tools.map(tool => tool.originalName)).toEqual(["replacement"]);
    expect(f.requests.filter(request => request.method === "initialize")).toHaveLength(before);
  });

  it("keeps useful unexpected failure details without exposing configured secrets", async () => {
    const f = await fixture();
    const inspector = new McpInspector(f.base, f.base); cleanups.push(() => inspector.dispose());
    const token = `private-fixture-token-${"x".repeat(700)}`;
    f.set(method => { if (method === "tools/list") throw new Error(`synthetic list failure with ${token}`); return undefined; });
    const result = await inspector.inspect({ scope: "global", config: {
      name: "inspected", transport: { kind: "http", url: f.url }, auth: { kind: "bearer", token: { secret: true } },
    }, secrets: new Map([["auth.token", token]]) });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("synthetic list failure");
    expect(result.detail).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
  });

  it("reports a revoked inspector as needing attention, not a transport failure", async () => {
    const f = await fixture();
    const inspector = new McpInspector(f.base, f.base); cleanups.push(() => inspector.dispose());
    const config = { name: "inspected", transport: { kind: "http" as const, url: f.url }, auth: { kind: "none" as const } };
    const target = { scope: "global" as const, config, secrets: new Map<string, string>() };
    expect((await inspector.inspect(target)).status).toBe("connected");
    await new McpAuthorizationRegistry(f.base).bump(await mcpAuthorizationIdentity("global", f.base, config));
    const result = await inspector.inspect(target);
    expect(result.status).toBe("needs-auth");
    expect(result.detail).toContain("Access to this server changed");
    expect(inspector.inspecting("global", config.name)).toBe(false);
  });

  it("revalidates inspector tools at expiry and refuses a removed tool without forwarding it", async () => {
    const f = await fixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    cleanups.push(() => clock.mockRestore());
    const inspector = new McpInspector(f.base, f.base);
    cleanups.push(() => inspector.dispose());
    const config = { name: "inspected", transport: { kind: "http" as const, url: f.url }, auth: { kind: "none" as const } };
    f.set(method => method === "tools/list" ? { tools: [tool("first")], ttlMs: 1000 } : undefined);
    const first = await inspector.inspect({ scope: "project", config, secrets: new Map() });
    expect(first.status).toBe("connected");
    expect(first.toolCatalog!.expiresAt).toBeGreaterThan(first.toolCatalog!.checkedAt);
    now += 1001;
    f.set(method => method === "tools/list" ? { tools: [tool("replacement")], ttlMs: 1000 } : undefined);
    const sent = f.requests.filter(request => request.method === "tools/call").length;
    expect(await inspector.call("project", config, new Map(), "first", {})).toMatchObject({ ok: false, error: expect.stringContaining("no longer available") });
    expect(f.requests.filter(request => request.method === "tools/call")).toHaveLength(sent);
    expect((await inspector.inspect({ scope: "project", config, secrets: new Map() })).tools.map(value => value.originalName)).toEqual(["replacement"]);
    now += 1001;
    f.set(method => { if (method === "tools/list") throw new Error("synthetic failed inspector refresh"); return undefined; });
    const failed = await inspector.inspect({ scope: "project", config, secrets: new Map() });
    expect(failed).toMatchObject({ status: "failed", tools: [] });
    expect(failed.toolCatalog).toBeUndefined();
  });

  it("marks held inspector counts stale before a notification refresh can finish", async () => {
    const f = await fixture();
    const changed = vi.fn();
    const inspector = new McpInspector(f.base, f.base, changed);
    cleanups.push(() => inspector.dispose());
    const config = { name: "inspected", transport: { kind: "http" as const, url: f.url }, auth: { kind: "none" as const } };
    f.set(method => method === "tools/list" ? { tools: [tool("first")], ttlMs: 10_000 } : undefined);
    await inspector.inspect({ scope: "project", config, secrets: new Map() });
    await vi.waitFor(() => expect(f.streamCount()).toBe(2));
    const release = Promise.withResolvers<void>();
    f.set(async method => { if (method !== "tools/list") return undefined; await release.promise; return { tools: [tool("replacement")], ttlMs: 10_000 }; });
    f.notify();
    try {
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      const counts = inspector.liveCounts("project", "inspected")!;
      expect(counts.toolCount).toBe(1);
      expect(counts.toolCatalog?.expiresAt).toBe(counts.toolCatalog?.checkedAt);
    } finally { release.resolve(); }
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
