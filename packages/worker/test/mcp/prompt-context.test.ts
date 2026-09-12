import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DATA_DIR_NAME, PRODUCT_NAME, type McpRuntimeSnapshot } from "@lasercode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createJiti } from "jiti";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import type { DriverEvent } from "../../src/driver.js";
import { McpPromptContext } from "../../src/mcp/prompt-context.js";
import { adapterRoot } from "../../src/mcp/engine.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubAnswer } from "../agents/stub-provider.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/stdio-server.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function run(preload: boolean, window?: number) {
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-prefix-`));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const agentDir = join(base, "agent");
  mkdirSync(cwd); mkdirSync(join(agentDir, DATA_DIR_NAME), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanups.push(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  // Legacy direct is intentionally present in both cases: it is not an override.
  writeFileSync(join(agentDir, DATA_DIR_NAME, "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "fixture", transport: { kind: "stdio", command: process.execPath, args: [fixture] }, tools: { exposure: "direct", ...(preload ? { alwaysLoad: true } : {}) } }] }));
  const answers: StubAnswer[] = [
    { toolCall: { name: "mcp", args: { connect: "fixture" } } },
    { toolCall: { name: "mcp", args: { search: "echo" } } },
    { toolCall: { name: "mcp", args: { describe: "fixture_echo" } } },
    { toolCall: { name: "mcpScript", args: { code: 'const page = await tools.search({query:"echo",detail:"names"}); emit(page);' } } },
    { toolCall: { name: "mcp", args: { tool: "fixture_echo", args: { text: "discovered-call" } } } },
    { text: "done" },
  ];
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
  return { stub, events, driver };
}

function snapshots(events: DriverEvent[]): McpRuntimeSnapshot[] {
  return events.flatMap((event) => event.type === "extension" && event.message.type === "lasercode/mcp/status" ? [event.message.snapshot] : []);
}

describe("MCP prompt contract through real provider requests", () => {
  it.each(["flat", "function", "google", "bedrock", "relay"])("reads the pinned %s provider payload without rewriting it", (format) => {
    const context = new McpPromptContext();
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
    const context = new McpPromptContext();
    const events = new EventEmitter();
    const registered = new Map<string, unknown>();
    let active: string[] = [];
    const pi = { on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback), events,
      registerTool: (tool: { name: string }) => { registered.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
      getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    } as unknown as ExtensionAPI;
    const wrapped = context.wrap(pi, "status");
    const definition = (name: string, description = "original") => ({ name, label: name, description, parameters: {} as never, execute: async () => ({ content: [], details: {} }) });
    wrapped.registerTool(definition("mcp")); wrapped.registerTool(definition("fixture_echo")); wrapped.registerTool(definition("mcp__fixture"));
    expect(active).toEqual(["mcp", "fixture_echo"]);
    const status: Record<string, unknown>[] = [];
    events.on("status", value => status.push(value));
    wrapped.events.emit("status", { servers: [] });
    expect(status.at(-1)).not.toHaveProperty("context");
    events.emit("before_provider_request", { payload: { tools: active.map(name => ({ name })) } }, { model: { contextWindow: 1_000_000 }, sessionManager: { getSessionName: () => "original" } });
    const original = [...registered];
    wrapped.registerTool(definition("fixture_echo", "changed")); wrapped.registerTool(definition("fixture_new")); wrapped.setActiveTools([]);
    expect([...registered]).toEqual(original); expect(active).toEqual(["mcp", "fixture_echo"]);
    pi.registerTool(definition("other_extension"));
    expect(active).toContain("other_extension");
    events.emit("session_start", {}, { sessionManager: { getSessionId: () => "new", getSessionName: () => "new" } });
    wrapped.registerTool(definition("fixture_echo", "new conversation")); wrapped.setActiveTools(["mcp", "fixture_echo"]);
    expect(registered.get("fixture_echo")).toMatchObject({ description: "new conversation" });
    expect(context.snapshot()).toMatchObject({ title: "new", contextWindow: null, discoveries: [] });
  });

  it("does not send an override whose conservative tool bound exceeds the model window", async () => {
    const { stub, events } = await run(true, 1024);
    expect(stub.requests).toHaveLength(0);
    expect(JSON.stringify(events)).toContain("Preloaded MCP tools may exceed");
    expect(events.filter(event => event.type === "update" && event.update.kind === "extension_error")).toEqual([]);
  }, 120_000);
  it.each([false, true])("keeps the entire tools array stable across connect, discover, inspect, script search and execution (preload=%s)", async (preload) => {
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

function policy(window?: number) {
  const context = new McpPromptContext();
  const events = new EventEmitter();
  context.wrap({ on: (name: string, callback: (...args: unknown[]) => unknown) => events.on(name, callback), events: { emit() {} }, registerTool() {} } as unknown as ExtensionAPI, "status");
  events.emit("before_provider_request", { payload: { tools: [] } }, { model: window ? { contextWindow: window } : undefined, sessionManager: { getSessionName: () => undefined } });
  return context;
}
const match = (i: number, description = "Read a document") => ({ server: i % 2 ? "second" : "first", score: 100 - i, tool: { name: `tool_${i}`, originalName: `read_${i}`, description, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "string" } } });

describe("MCP discovery admission", () => {
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
    expect(context.search([match(0)], { query: "read", detail: "full" }).items).toEqual([]);
    expect(context.describe("first", match(0).tool)).toHaveProperty("inputSchema");
    context.search([match(0), match(1)], { query: "read", detail: "names", limit: 1 });
    expect(context.search([match(2)], { query: "read", detail: "names", offset: 1 })).toHaveProperty("message", "The tool catalog changed. Search again from the beginning.");
  });
});
