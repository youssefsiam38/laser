/**
 * M14-T2 · the MCP engine inside a real session (docs/mcp.md "Verification").
 *
 * Drives `StableSdkDriver` against the pinned engine, the real MCP adapter and
 * the deterministic fixture server, through the stub provider: the direct
 * tools the model is offered, a call whose result carries an image, the status
 * the companion reports, and the three things that must not happen — no MCP
 * tools in a project with no server, no engine toasts in the transcript, and
 * no engine commands in the command list.
 *
 * The engine holds the first prompt until it has initialised (up to 30 s on a
 * cold cache), so these tests are slow by construction, not flaky.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { DATA_DIR_NAME, PRODUCT_NAME, type FeatureId, type McpRuntimeSnapshot, type McpServerConfig } from "@lasercode/protocol";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import type { DriverAgentOptions, DriverEvent } from "../../src/driver.js";
import { startStubProvider, toolNamesOf, type StubAnswer, type StubProvider } from "../agents/stub-provider.js";
import { writeStubModels } from "../agents/stub-provider.js";
import { expectedClientInfo, IDENTITY_TRANSPORTS, identityFixture } from "./fixtures/client-identity.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");

let base: string;
let stub: StubProvider;
const drivers: StableSdkDriver[] = [];
const events: DriverEvent[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-session-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent", DATA_DIR_NAME), { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = join(base, "agent");
  events.length = 0;
});

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.dispose().catch(() => {});
  await stub?.close();
  rmSync(base, { recursive: true, force: true });
});

function writeServers(servers: McpServerConfig[]): void {
  writeFileSync(join(base, "agent", DATA_DIR_NAME, "mcp.json"), JSON.stringify({ version: 1, servers }, null, 2));
}

const fixtureServer = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "fixture",
  transport: { kind: "stdio", command: process.execPath, args: [FIXTURE] },
  tools: { exposure: "direct" },
  startup: "on-demand",
  ...extra,
});

function agentOptions(): DriverAgentOptions {
  return { definition: { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } }, role: rootRole("default"), record: rootRecord("default"), policy: fallbackPolicy() };
}

async function openSession(answers: StubAnswer[], options: { features?: FeatureId[]; extra?: InlineExtension[] } = {}): Promise<StableSdkDriver> {
  let index = 0;
  stub = await startStubProvider(() => answers[Math.min(index++, answers.length - 1)] ?? { text: "ok" });
  writeStubModels(join(base, "agent"), stub.url);
  const driver = new StableSdkDriver(options.extra ?? []);
  drivers.push(driver);
  driver.subscribe((event) => events.push(event));
  await driver.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: options.features ?? ["mcp", "subagents", "goals"],
    agent: agentOptions(),
  });
  return driver;
}

async function promptAndSettle(driver: StableSdkDriver, text = "go"): Promise<void> {
  const settled = new Promise<void>((resolve) => {
    driver.subscribe((event) => {
      if (event.type === "update" && event.update.kind === "agent_settled") resolve();
    });
  });
  await driver.prompt([{ type: "text", text }]);
  await settled;
}

function snapshots(): McpRuntimeSnapshot[] {
  return events
    .filter((event): event is Extract<DriverEvent, { type: "extension" }> => event.type === "extension")
    .filter((event) => event.message.type === "lasercode/mcp/status")
    .map((event) => (event.message as { snapshot: McpRuntimeSnapshot }).snapshot);
}

describe("a session with an MCP server", () => {
  it.each(IDENTITY_TRANSPORTS)("sends product identity for two server names over %s", async (transport) => {
    const fixture = await identityFixture(transport, base);
    let driver: StableSdkDriver | undefined;
    try {
      const names = ["browser-one", "docs-two"];
      writeServers(names.map((name) => fixture.config(name)));
      driver = await openSession([{ text: "done" }], { features: ["mcp"] });
      await promptAndSettle(driver);
      const received = fixture.received();
      // Load-time and session-start runtimes may both connect, in either
      // order. Check every handshake, including replacement connections.
      const expected = names.map(expectedClientInfo);
      expect(received).toEqual(expect.arrayContaining(expected));
      // Replacing a load-time HTTP connection can trigger its diagnostic
      // probe; probes use the base identity by contract, never a server suffix.
      const allowed = transport === "stdio" ? expected : [...expected, expectedClientInfo()];
      for (const info of received) expect(allowed).toContainEqual(info);
      console.log(`received session ${transport}: ${JSON.stringify(received)}`);
    } finally {
      await driver?.dispose();
      if (driver) drivers.splice(drivers.indexOf(driver), 1);
      await fixture.close();
    }
  }, 120_000);

  it("offers the server's tools to the model under its own prefix and returns an image from a call", async () => {
    writeServers([fixtureServer()]);
    const driver = await openSession([
      { toolCall: { name: "fixture_snapshot", args: {} } },
      { text: "done" },
    ]);
    await promptAndSettle(driver);

    const request = stub.requests[0]!;
    expect(toolNamesOf(request)).toContain("fixture_echo");
    expect(toolNamesOf(request)).toContain("fixture_snapshot");

    const results = events
      .filter((event): event is Extract<DriverEvent, { type: "update" }> => event.type === "update")
      .map((event) => event.update)
      .filter((update) => update.kind === "tool_execution_end");
    const call = results.find((update) => (update as { toolName?: string }).toolName?.includes("snapshot")) ?? results[0];
    const content = (call as { result?: { content?: Array<{ type: string; mimeType?: string }> } } | undefined)?.result?.content ?? [];
    expect(content.map((block) => block.type)).toContain("image");
    expect(content.find((block) => block.type === "image")?.mimeType).toBe("image/png");

    // The engine's caches belong to the agent directory it was given, never
    // to the person's own engine home.
    expect(existsSync(join(base, "agent", "mcp-cache.json"))).toBe(true);
  }, 120_000);

  it("reports each server's status to the worker, in the product's words", async () => {
    writeServers([fixtureServer()]);
    const driver = await openSession([{ text: "done" }]);
    await promptAndSettle(driver);
    const seen = snapshots();
    expect(seen.length).toBeGreaterThan(0);
    const connected = seen.find((snapshot) => snapshot.servers.some((server) => server.name === "fixture" && server.status === "connected"));
    expect(connected).toBeDefined();
    const server = connected!.servers.find((entry) => entry.name === "fixture")!;
    expect(server.toolCount).toBeGreaterThan(0);
    expect(server.directToolCount).toBeGreaterThan(0);
    expect(connected!.connectedCount).toBe(1);
  }, 120_000);

  it("says nothing to the person through the engine's own status line or toasts", async () => {
    writeServers([fixtureServer()]);
    const driver = await openSession([{ text: "done" }]);
    await promptAndSettle(driver);
    const ui = events.filter((event): event is Extract<DriverEvent, { type: "ui_event" }> => event.type === "ui_event").map((event) => event.event);
    // Other features still speak (the goal's own status line); the MCP engine
    // does not, in either of the two ways it otherwise would.
    expect(ui.filter((event) => event.method === "setStatus" && (event.key === "mcp" || event.key === "mcp-auth"))).toEqual([]);
    expect(ui.filter((event) => event.method === "notify")).toEqual([]);
  }, 120_000);

  it("does not offer the engine's terminal commands, and still offers the product's own", async () => {
    writeServers([fixtureServer()]);
    const driver = await openSession([{ text: "done" }]);
    const commands = (await driver.commands()).map((command) => command.name);
    expect(commands).not.toContain("mcp");
    expect(commands).not.toContain("pi-mcp");
    expect(commands).not.toContain("mcp-auth");
    expect(commands).toContain("goal");
  }, 120_000);

  it("attributes a server's prompt command to that server, not to another feature", async () => {
    writeServers([fixtureServer({ label: "Fixture server" })]);
    const driver = await openSession([{ text: "done" }]);
    await promptAndSettle(driver);
    const commands = await driver.commands();
    // The fixture publishes one prompt, `greet`; the engine registers it as a
    // slash command, and it belongs to the server a person configured.
    const prompt = commands.find((command) => command.name.includes("greet"));
    expect(prompt, JSON.stringify(commands.map((command) => command.name))).toBeDefined();
    expect(prompt?.origin).toBe("MCP · Fixture server");
    expect(commands.find((command) => command.name === "goal")?.origin).toBe("Goals");
  }, 120_000);

  it("loads nothing when the feature is off, however many servers are configured", async () => {
    writeServers([fixtureServer()]);
    const driver = await openSession([{ text: "done" }], { features: ["subagents", "goals"] });
    await promptAndSettle(driver);
    const names = toolNamesOf(stub.requests[0]!);
    expect(names.some((name) => name.startsWith("fixture_"))).toBe(false);
    expect(names).not.toContain("mcp");
    expect(snapshots()).toEqual([]);
  }, 120_000);

  it("opens the session even when another extension's factory throws", async () => {
    // The engine isolates one extension's failure; the MCP engine sits beside
    // that extension in the same list, so its tools must still arrive.
    writeServers([fixtureServer()]);
    const exploding: InlineExtension = { name: "exploding", factory: () => { throw new Error("this extension is broken"); } };
    const driver = await openSession([{ text: "done" }], { extra: [exploding] });
    await promptAndSettle(driver);
    expect(toolNamesOf(stub.requests[0]!)).toContain("fixture_echo");
  }, 120_000);

  it("loads nothing at all when the project has no server", async () => {
    const driver = await openSession([{ text: "done" }]);
    await promptAndSettle(driver);
    const names = toolNamesOf(stub.requests[0]!);
    expect(names).not.toContain("mcp");
    expect(names).not.toContain("mcpScript");
    expect(names.some((name) => name.startsWith("fixture_"))).toBe(false);
    expect(snapshots()).toEqual([]);
    expect((await driver.commands()).map((command) => command.name)).not.toContain("mcp");
  }, 120_000);

  it("leaves a turned-off server out of the session", async () => {
    writeServers([fixtureServer({ disabled: true })]);
    const driver = await openSession([{ text: "done" }]);
    await promptAndSettle(driver);
    const names = toolNamesOf(stub.requests[0]!);
    expect(names.some((name) => name.startsWith("fixture_"))).toBe(false);
    expect(names).not.toContain("mcp");
  }, 120_000);
});
