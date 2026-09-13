import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DATA_DIR_NAME, PRODUCT_NAME, type McpRuntimeSnapshot, type McpServerConfig } from "@lasercode/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJiti } from "jiti";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../../src/driver.js";
import { McpService } from "../../src/mcp/service.js";
import { McpPromptFreeze } from "../../src/mcp/prompt-freeze.js";
import { adapterRoot } from "../../src/mcp/engine.js";
import { startFixtureHttpServer } from "./fixtures/http-server.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubAnswer } from "../agents/stub-provider.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/stdio-server.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function run(preload: boolean, window?: number, transport?: NonNullable<McpServerConfig["transport"]>, cold?: "gateway" | "script" | "management", extra: McpServerConfig[] = []) {
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-prefix-`));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const agentDir = join(base, "agent");
  mkdirSync(cwd); mkdirSync(join(agentDir, DATA_DIR_NAME), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanups.push(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  // Legacy direct is intentionally present in both cases: it is not an override.
  writeFileSync(join(agentDir, DATA_DIR_NAME, "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "fixture", startup: cold ? "on-demand" : "at-start", transport: transport ?? { kind: "stdio", command: process.execPath, args: [fixture] }, ...(transport ? { auth: { kind: "none" } } : {}), tools: { exposure: "direct", ...(preload ? { alwaysLoad: true } : {}) } }, ...extra] }));
  const answers: StubAnswer[] = [
    cold === "script" ? { toolCall: { name: "mcpScript", args: { code: 'emit(await tools.search({query:"echo",server:"fixture"}));' } } }
      : { toolCall: { name: "mcp", args: cold ? { search: "echo", server: "fixture" } : { server: "fixture" } } },
    { toolCall: { name: "mcp", args: { search: "echo", server: "fixture" } } },
    { toolCall: { name: "mcp", args: { describe: "fixture_echo" } } },
    { toolCall: { name: "mcpScript", args: { code: 'const page = await tools.search({query:"echo",server:"fixture",detail:"names"}); emit(page);' } } },
    cold === "script" ? { toolCall: { name: "mcpScript", args: { code: 'emit(await tools.call("fixture_echo", {text:"discovered-call"}));' } } }
      : { toolCall: { name: "mcp", args: { tool: "fixture_echo", args: { text: "discovered-call" } } } },
    { text: "done" },
  ];
  if (cold === "management") {
    const forbidden = [{ connect: "fixture" }, { action: "install", url: "http://127.0.0.1:1/mcp" }, { action: "auth-start", server: "fixture" }, { action: "auth-complete", server: "fixture", args: { code: "synthetic" } }, { enable: "fixture" }, { disable: "fixture" }, { remove: "fixture" }];
    answers.splice(0, answers.length, ...forbidden.flatMap(args => [
      { toolCall: { name: "mcp", args } },
      { toolCall: { name: "mcpScript", args: { code: `emit(await tools.call("mcp", ${JSON.stringify(args)}));` } } },
    ]), { text: "done" });
  }
  let index = 0;
  const stub = await startStubProvider(() => answers[index++] ?? { text: "done" });
  cleanups.push(() => stub.close());
  writeStubModels(agentDir, stub.url);
  if (window !== undefined) {
    const path = join(agentDir, "models.json");
    const models = JSON.parse(readFileSync(path, "utf8"));
    models.providers.stub.models[0].contextWindow = window;
    writeFileSync(path, JSON.stringify(models));
  }
  const driver = new StableSdkDriver();
  cleanups.push(() => driver.dispose());
  const events: DriverEvent[] = [];
  driver.subscribe((event) => events.push(event));
  await driver.open({ cwd, agentDir, sessionDir: join(base, "sessions"), projectTrusted: true, features: ["mcp"], agent: {
    definition: { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } }, role: rootRole("default"), record: rootRecord("default"), policy: fallbackPolicy(),
  } });
  const settled = new Promise<void>((resolve) => driver.subscribe((event) => { if (event.type === "update" && event.update.kind === "agent_settled") resolve(); }));
  await driver.prompt([{ type: "text", text: "Discover then call echo" }]); await settled;
  return { stub, events, driver, answers, cwd, agentDir };
}

function snapshots(events: DriverEvent[]): McpRuntimeSnapshot[] {
  return events.flatMap((event) => event.type === "extension" && event.message.type === "lasercode/mcp/status" ? [event.message.snapshot] : []);
}

describe("MCP prompt contract through real provider requests", () => {
  it("refuses model management before a cold server has any transport or auth side effects", async () => {
    const remote = await startFixtureHttpServer("sse"); cleanups.push(() => remote.close());
    const { stub } = await run(false, undefined, { kind: "http", url: remote.url, stream: "sse" }, "management");
    expect(remote.clientInfos).toHaveLength(0);
    expect(remote.toolListRequests()).toBe(0);
    expect(remote.toolCalls).toHaveLength(0);
    const results = stub.requests.at(-1)!.messages.filter(message => message.role === "tool");
    expect(results).toHaveLength(14);
    for (const result of results) expect(JSON.stringify(result)).toContain("managed by the person in Settings");
    const frozen = JSON.stringify(stub.requests[0]!.tools);
    for (const request of stub.requests) expect(JSON.stringify(request.tools)).toBe(frozen);
  }, 60_000);

  it.each(["gateway", "script"] as const)("discovers a cold enabled server through %s without management or unrelated connections", async cold => {
    const remote = await startFixtureHttpServer("sse", 60_000);
    const unrelated = await startFixtureHttpServer("sse");
    cleanups.push(() => remote.close(), () => unrelated.close());
    const { stub } = await run(false, undefined, { kind: "http", url: remote.url, stream: "sse" }, cold, [
      { name: "unrelated", startup: "on-demand", transport: { kind: "http", url: unrelated.url, stream: "sse" } },
      { name: "off", disabled: true, transport: { kind: "http", url: unrelated.url, stream: "sse" } },
    ]);
    expect(remote.clientInfos).toHaveLength(1);
    expect(unrelated.clientInfos).toHaveLength(0);
    expect(unrelated.toolListRequests()).toBe(0);
    expect(remote.toolCalls).toEqual(["echo"]);
    const tools = JSON.stringify(stub.requests[0]!.tools);
    for (const request of stub.requests) expect(JSON.stringify(request.tools)).toBe(tools);
    const results = JSON.stringify(stub.requests.at(-1)!.messages.filter(message => message.role === "tool"));
    expect(results).toContain("fixture_echo"); expect(results).toContain("discovered-call");
    expect(results).not.toMatch(/connect:|auth-start|mcp enable/);
  }, 60_000);

  it.each([false, true])("re-indexes script discovery after one notification refresh while provider tools remain frozen (preload=%s)", async preload => {
    const remote = await startFixtureHttpServer("sse", 60_000);
    cleanups.push(() => remote.close());
    const { stub, driver, answers, events } = await run(preload, undefined, { kind: "http", url: remote.url, stream: "sse" });
    const frozen = JSON.stringify(stub.requests[0]!.tools);
    const checked = snapshots(events).at(-1)?.servers[0]?.toolCatalog?.checkedAt ?? 0;
    const lists = remote.toolListRequests();
    const calls = remote.toolCalls.length;
    remote.replaceTools(["replacement", "snapshot"]);
    await vi.waitFor(() => expect(snapshots(events).at(-1)?.servers[0]?.toolCatalog?.checkedAt).toBeGreaterThan(checked), { timeout: 5000 });
    answers.push({ toolCall: { name: "mcpScript", args: { code: 'emit(await tools.search({query:"replacement",detail:"names"})); emit(await tools.call("fixture_replacement",{text:"fresh-call"})); emit(await tools.call("fixture_echo",{text:"must-not-forward"}));' } } }, { text: "done" });
    const settled = new Promise<void>(resolve => driver.subscribe(event => { if (event.type === "update" && event.update.kind === "agent_settled") resolve(); }));
    await driver.prompt([{ type: "text", text: "Use the changed tool list" }]); await settled;
    expect(remote.toolCalls.slice(calls)).toEqual(["replacement"]);
    expect(remote.toolListRequests()).toBe(lists + 1);
    const result = stub.requests.at(-1)!.messages.filter(message => message.role === "tool").at(-1);
    expect(JSON.stringify(result)).toContain("fresh-call");
    expect(JSON.stringify(result)).toContain("fixture_replacement");
    for (const request of stub.requests) expect(JSON.stringify(request.tools)).toBe(frozen);
  }, 60_000);

  it("refuses server management through both gateway and script dispatch without changing the frozen surface", async () => {
    const { stub, driver, answers, cwd, agentDir } = await run(false);
    const tools = JSON.stringify(stub.requests[0]!.tools);
    const configPath = join(agentDir, DATA_DIR_NAME, "mcp.json");
    const saved = readFileSync(configPath, "utf8");
    const forbidden = [{ connect: "fixture" }, { action: "install", url: "http://127.0.0.1:1/mcp" },
      { action: "auth-start", server: "fixture" }, { action: "auth-complete", server: "fixture", args: { code: "synthetic" } },
      { enable: "fixture" }, { disable: "fixture" }, { remove: "fixture" }];
    for (const args of forbidden) {
      answers.push({ toolCall: { name: "mcp", args } },
        { toolCall: { name: "mcpScript", args: { code: `emit(await tools.call("mcp", ${JSON.stringify(args)}));` } } });
    }
    answers.push({ text: "done" });
    const settled = new Promise<void>(resolve => driver.subscribe(event => { if (event.type === "update" && event.update.kind === "agent_settled") resolve(); }));
    await driver.prompt([{ type: "text", text: `Do not change server configuration in ${cwd}` }]); await settled;
    for (const request of stub.requests) expect(JSON.stringify(request.tools)).toBe(tools);
    const results = stub.requests.at(-1)!.messages.filter(message => message.role === "tool").slice(-forbidden.length * 2);
    expect(results).toHaveLength(forbidden.length * 2);
    for (const result of results) expect(JSON.stringify(result.content)).toContain("managed by the person in Settings");
    expect(readFileSync(configPath, "utf8")).toBe(saved);
    const gateway = stub.requests[0]!.tools!.find(tool => tool.function.name === "mcp") as unknown as { function: { parameters: { properties: Record<string, unknown> } } };
    for (const name of ["connect", "action", "url", "target"]) expect(gateway.function.parameters.properties).not.toHaveProperty(name);
  }, 60_000);
  it.each([false, true])("refuses the next call after sign-out without changing any serialized provider tool (preload=%s)", async preload => {
    const previous = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    cleanups.push(() => { if (previous === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE; else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previous; });
    const { stub, driver, answers, cwd, agentDir } = await run(preload);
    const before = JSON.stringify(stub.requests[0]!.tools);
    const service = new McpService({ cwd, agentDir, projectTrusted: true, changed: () => {} });
    cleanups.push(() => service.dispose());
    await service.authLogout({ cwd, scope: "global", name: "fixture" });
    answers.push(
      { toolCall: preload ? { name: "fixture_echo", args: { text: "revoked-call" } }
        : { name: "mcp", args: { tool: "fixture_echo", args: { text: "revoked-call" } } } },
      { text: "stopped" },
    );
    const settled = new Promise<void>(resolve => driver.subscribe(event => { if (event.type === "update" && event.update.kind === "agent_settled") resolve(); }));
    await driver.prompt([{ type: "text", text: "Try the same tool again" }]); await settled;
    expect(stub.requests.length).toBe(8);
    for (const request of stub.requests) expect(JSON.stringify(request.tools)).toBe(before);
    expect(JSON.stringify(stub.requests.at(-1))).toContain("Access to fixture changed. Sign in again in Settings → MCP servers.");
  }, 60_000);

  it.each(["flat", "function", "google", "bedrock", "relay"])("reads the pinned %s provider payload without rewriting it", (format) => {
    const context = new McpPromptFreeze();
    const events = new EventEmitter();
    const wrapped = context.wrap({ on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback), events, registerTool() {} } as unknown as ExtensionAPI, "status");
    wrapped.registerTool({ name: "fixture_echo", label: "Echo", description: "Echo", parameters: {} as never, execute: async () => ({ content: [], details: {} }) });
    const entry = { name: "fixture_echo", description: "Echo", parameters: { type: "object" } };
    const other = { name: "other_extension" };
    let payload: unknown;
    let measured: unknown = entry;
    if (format === "function") { measured = { type: "function", function: entry }; payload = { tools: [measured, { function: other }] }; }
    else if (format === "google") { measured = { name: entry.name, description: entry.description, parametersJsonSchema: entry.parameters }; payload = { config: { tools: [{ functionDeclarations: [measured, other] }] } }; }
    else if (format === "bedrock") { measured = { toolSpec: { name: entry.name, description: entry.description, inputSchema: { json: entry.parameters } } }; payload = { toolConfig: { tools: [measured, { toolSpec: other }] } }; }
    else if (format === "relay") payload = { context: { tools: [entry, other] } };
    else payload = { tools: [entry, other] };
    const before = JSON.stringify(payload);
    events.emit("before_provider_request", { payload }, { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionName: () => undefined } });
    expect(JSON.stringify(payload)).toBe(before);
    expect(context.snapshot().preloaded).toEqual(["fixture_echo"]);
    expect(context.snapshot().preloadedTokens).toBe(Buffer.byteLength(JSON.stringify([measured])));
  });

  it("fences late registrations and activation changes until a new session boundary", () => {
    const context = new McpPromptFreeze();
    const events = new EventEmitter();
    const registered = new Map<string, unknown>();
    let active: string[] = [];
    const pi = { on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback), events,
      registerTool: (tool: { name: string }) => { registered.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
      unregisterTool: (name: string) => { registered.delete(name); active = active.filter(item => item !== name); },
      getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI;
    const wrapped = context.wrap(pi, "status");
    const definition = (name: string, description = "original") => ({ name, label: name, description, parameters: {} as never, execute: async () => ({ content: [], details: {} }) });
    wrapped.registerTool(definition("mcp")); wrapped.registerTool(definition("fixture_echo"));
    expect(active).toEqual(["mcp", "fixture_echo"]);
    const status: Record<string, unknown>[] = [];
    events.on("status", value => status.push(value));
    wrapped.events.emit("status", { servers: [] });
    expect(status.at(-1)).not.toHaveProperty("context");
    events.emit("before_provider_request", { payload: { tools: active.map(name => ({ name })) } }, { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionName: () => "original" } });
    const original = [...registered];
    wrapped.registerTool(definition("fixture_echo", "changed")); wrapped.registerTool(definition("fixture_new")); wrapped.setActiveTools([]); Reflect.get(wrapped, "unregisterTool")("fixture_echo");
    expect([...registered]).toEqual(original); expect(active).toEqual(["mcp", "fixture_echo"]);
    pi.registerTool(definition("other_extension"));
    expect(active).toContain("other_extension");
    events.emit("session_start", {}, { sessionManager: { getSessionId: () => "new", getSessionName: () => "new" } });
    wrapped.registerTool(definition("fixture_echo", "new conversation")); wrapped.setActiveTools(["mcp", "fixture_echo"]);
    expect(registered.get("fixture_echo")).toMatchObject({ description: "new conversation" });
    expect(context.snapshot()).toMatchObject({ title: "new", contextWindow: null, discoveries: [] });
  });

  it("records fallback deactivation intent without changing frozen registered or active tools", async () => {
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const { deactivateDirectTools } = await jiti.import<{
      deactivateDirectTools: (names: string[], api: { unregisterTool?: ((name: string) => boolean | void) | undefined; getActiveTools(): string[]; setActiveTools(names: string[]): void }, fallback: Set<string>) => string[];
    }>(join(adapterRoot(), "tool-registrar.ts"));
    const events = new EventEmitter();
    const registered = new Set<string>();
    let active: string[] = [];
    const pi = {
      events, on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback),
      registerTool: (tool: { name: string }) => { registered.add(tool.name); active.push(tool.name); },
      unregisterTool: (name: string) => { active = active.filter(item => item !== name); return registered.delete(name); },
      getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
    };
    const context = new McpPromptFreeze();
    const wrapped = context.wrap(pi as unknown as ExtensionAPI, "status");
    wrapped.registerTool({ name: "fixture_echo" } as never);
    const definition = { name: "fixture_echo", description: "original" };
    events.emit("before_provider_request", { payload: { tools: [definition] } }, { model: { contextWindow: 200_000 }, sessionManager: { getSessionName() {} } });
    const before = context.snapshot();
    const fallback = new Set<string>();
    const api = { unregisterTool: Reflect.get(wrapped, "unregisterTool"), getActiveTools: wrapped.getActiveTools, setActiveTools: wrapped.setActiveTools };
    expect(deactivateDirectTools(["fixture_echo"], api, fallback)).toEqual([]);
    // The adapter records intent, not success: future dynamic-server work must
    // not use this ledger as an inventory of callable or provider-visible tools.
    expect([...fallback]).toEqual(["fixture_echo"]);
    expect([...registered]).toEqual(["fixture_echo"]);
    expect(active).toEqual(["fixture_echo"]);
    events.emit("before_provider_request", { payload: { tools: [definition] } }, { model: { contextWindow: 200_000 }, sessionManager: { getSessionName() {} } });
    expect(context.snapshot()).toEqual(before);
    events.emit("session_start", {}, { sessionManager: { getSessionId: () => "next", getSessionName() {} } });
    expect(deactivateDirectTools(["fixture_echo"], api, new Set())).toEqual(["fixture_echo"]);
    expect([...registered]).toEqual([]);
    expect(active).toEqual([]);
  });

  it("does not send an override whose conservative tool bound exceeds the model window", async () => {
    const { stub, events } = await run(true, 1024);
    expect(stub.requests).toHaveLength(0);
    expect(JSON.stringify(events)).toContain("Preloaded MCP tools may exceed");
    expect(events.filter(event => event.type === "update" && event.update.kind === "extension_error")).toEqual([]);
  }, 120_000);
  it.each([false, true])("keeps the entire tools array stable across person-owned startup, discover, inspect, script search and execution (preload=%s)", async (preload) => {
    const { stub, events, driver } = await run(preload);
    expect(stub.requests).toHaveLength(6);
    const first = JSON.stringify((stub.requests[0] as { tools?: unknown }).tools);
    const prefix = (request: unknown) => JSON.stringify((request as { messages: Array<{ role: string }> }).messages.filter(message => message.role === "system" || message.role === "developer"));
    const firstPrefix = prefix(stub.requests[0]);
    for (const request of stub.requests.slice(1)) {
      expect(JSON.stringify((request as { tools?: unknown }).tools)).toBe(first);
      expect(prefix(request)).toBe(firstPrefix);
    }
    const names = toolNamesOf(stub.requests[0]!);
    expect(names).toContain("mcp"); expect(names).toContain("mcpScript");
    expect(names.some(name => name.startsWith("mcp__"))).toBe(false);
    expect(names.includes("fixture_echo")).toBe(preload);
    const searchText = (stub.requests[2] as { messages: Array<{ role: string; content: unknown }> }).messages.findLast(message => message.role === "tool")!.content;
    expect(typeof searchText).toBe("string");
    const searchPage = JSON.parse(searchText as string);
    expect(searchPage.detail).toBe("summary");
    expect(searchPage.items.length).toBeGreaterThan(0);
    expect(searchPage.items[0]).toHaveProperty("description");
    expect(searchPage.items[0]).not.toHaveProperty("inputSchema");
    const contexts = snapshots(events).flatMap((entry) => entry.context ? [entry.context] : []);
    expect(contexts.length).toBeGreaterThan(0);
    const context = contexts.at(-1)!;
    expect(context.contextWindow).toBeGreaterThan(0);
    expect(context.budget).toBe(Math.floor(context.contextWindow! * 0.02));
    expect(context.preloaded.includes("fixture_echo")).toBe(preload);
    expect(context.discoveries).toEqual(expect.arrayContaining([expect.objectContaining({ server: "fixture", name: "fixture_echo", detail: "full" })]));
    expect(JSON.stringify(stub.requests.at(-1))).toContain("discovered-call");
    const settled = new Promise<void>((resolve) => driver.subscribe((event) => { if (event.type === "update" && event.update.kind === "agent_settled") resolve(); }));
    await driver.prompt([{ type: "text", text: "Continue the same conversation" }]); await settled;
    expect(stub.requests).toHaveLength(7);
    expect(JSON.stringify((stub.requests.at(-1) as { tools?: unknown }).tools)).toBe(first);
    expect(prefix(stub.requests.at(-1))).toBe(firstPrefix);
  }, 120_000);
});

function policy(window?: number, preloadBytes = 0) {
  const context = new McpPromptFreeze();
  const events = new EventEmitter();
  const wrapped = context.wrap({ on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback), events: { emit() {} }, registerTool() {} } as unknown as ExtensionAPI, "status");
  const tool = { name: "preloaded", label: "preloaded", description: "x".repeat(preloadBytes), parameters: {} as never, execute: async () => ({ content: [], details: {} }) };
  if (preloadBytes) wrapped.registerTool(tool);
  events.emit("before_provider_request", { payload: { tools: preloadBytes ? [tool] : [] } }, { model: window ? { contextWindow: window } : undefined, sessionManager: { getSessionName: () => undefined } });
  return context;
}
const match = (i: number, description = "Read a document") => ({ server: i % 2 ? "second" : "first", score: 100 - i, tool: { name: `tool_${i}`, originalName: `read_${i}`, description, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "string" } } });

describe("MCP discovery admission", () => {
  it.each(["names", "summary", "full"])("preload does not consume another server's %s lookup allowance", detail => {
    const context = policy(1_000_000, 40_000);
    expect(context.snapshot().preloadedTokens).toBeGreaterThan(20_000);
    const matches = Array.from({ length: 30 }, (_, index) => match(index));
    const withPreload = context.search(matches, { query: "read", detail });
    const withoutPreload = policy(1_000_000).search(matches, { query: "read", detail });
    expect(withPreload).toEqual(withoutPreload);
    expect(withPreload.items).toHaveLength(detail === "full" ? 5 : 12);
  });

  it("keeps continuations independent per server and reports response bounds", () => {
    const context = policy(1_000_000);
    const first = [match(0), match(2)];
    const second = [match(1), match(3)];
    context.search(first, { query: "read", server: "first", limit: 1 });
    context.search(second, { query: "read", server: "second", limit: 1 });
    const page = context.search(first, { query: "read", server: "first", offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(context.snapshot().lastDiscoveryTokens).toBe(Buffer.byteLength(JSON.stringify(page)));
    const descriptor = context.describe("first", first[0]!.tool);
    expect(descriptor.definitionTokenUpperBound).toBeGreaterThan(0);
    expect(descriptor.measurement).toBe("utf8-upper-bound");
    expect(context.snapshot().lastDiscoveryTokens).toBe(Buffer.byteLength(JSON.stringify(descriptor)));
  });

  it("lets a ranking strategy reorder only the authorized catalog", async () => {
    const jiti = createJiti(import.meta.url, { fsCache: false });
    const { rankToolMatches } = await jiti.import<{ rankToolMatches: (state: unknown, query: string) => Array<{ server: string; tool: { name: string } }> }>(join(adapterRoot(), "search-ranking.ts"));
    let candidateNames: string[] = [];
    const result = rankToolMatches({
      config: { mcpServers: { first: {}, second: { disabled: true } } },
      toolMetadata: new Map([["first", [match(0).tool, match(2).tool]], ["second", [match(1).tool]]]),
      failureTracker: new Map(), manager: { getConnection: () => undefined },
      discovery: { rank: (catalog: Array<{ tool: { name: string } }>) => {
        candidateNames = catalog.map(item => item.tool.name);
        return [{ server: "second", name: "tool_1", score: 99 }, { server: "first", name: "invented", score: 98 }, { server: "first", name: "tool_2", score: 3 }, { server: "first", name: "tool_0", score: 1 }, { server: "first", name: "tool_2", score: 2 }];
      } },
    }, "read");
    expect(candidateNames).toEqual(["tool_0", "tool_2"]);
    expect(result.map(item => item.tool.name)).toEqual(["tool_2", "tool_0"]);
  });
  it("returns names, summaries and atomic input/output schemas with grouped pages and hard page caps", () => {
    const context = policy(1_000_000);
    const matches = Array.from({ length: 100 }, (_, i) => match(i));
    const names = context.search(matches, { query: "read", detail: "names", limit: 999 });
    expect(names.items).toHaveLength(50);
    expect(names.groups).toEqual(expect.arrayContaining([expect.objectContaining({ server: "first" }), expect.objectContaining({ server: "second" })]));
    expect(JSON.stringify(names)).not.toContain("description");
    const summary = context.search(matches, { query: "read", detail: "summary" });
    expect(summary.items).toHaveLength(12);
    expect(JSON.stringify(summary)).not.toContain("inputSchema");
    const full = context.search(matches, { query: "read", detail: "full", limit: 999 });
    expect(full.items).toHaveLength(5);
    expect((full.items as unknown[])[0]).toMatchObject({ inputSchema: matches[0]!.tool.inputSchema, outputSchema: matches[0]!.tool.outputSchema });
  });

  it("uses aggregate serialized size, never count, and never slices an oversized schema", () => {
    const context = policy(32_768);
    const matches = [match(0, "x".repeat(4000)), match(1)];
    const page = context.search(matches, { query: "read", detail: "full" });
    expect(page.items).toEqual([]); expect(page.nextOffset).toBe(0);
    const descriptor = context.describe(matches[0]!.server, matches[0]!.tool);
    expect(descriptor.description).toBe(matches[0]!.tool.description);
    expect(descriptor.inputSchema).toEqual(matches[0]!.tool.inputSchema);
    expect(policy(1_000).describe(matches[0]!.server, matches[0]!.tool)).toHaveProperty("error");
  });

  it("keeps the window unavailable instead of guessing and rejects continuations after catalog changes", () => {
    const context = policy();
    expect(context.snapshot().budget).toBeNull();
    expect(context.search([match(0)], { query: "read", detail: "full" })).toMatchObject({ detail: "summary", items: [expect.objectContaining({ description: expect.any(String) })] });
    expect(context.describe("first", match(0).tool)).toHaveProperty("inputSchema");
    context.search([match(0), match(1)], { query: "read", detail: "names", limit: 1 });
    expect(context.search([match(2)], { query: "read", detail: "names", offset: 1 })).toHaveProperty("message", "The tool catalog changed. Search again from the beginning.");
  });
});
