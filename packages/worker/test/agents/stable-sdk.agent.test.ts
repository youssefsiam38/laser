/**
 * M13-T3 · per-agent session configuration against the real engine: custom
 * versus Laser instructions, built-in tool filtering, user skill scoping,
 * the model refusal, and the agent record written
 * on a new session and recovered on load.
 */
import { type InlineExtension, type SessionManager } from "@earendil-works/pi-coding-agent";
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE, type AgentDefinition, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackBeamAgent, fallbackDefaultAgent, fallbackPolicy, fallbackSnapshot } from "../../src/agents/definitions.js";
import { ENGINE_BUILTIN_TOOLS, readSessionAgentRecord, rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { WorkerServer } from "../../src/server.js";
import type { DriverAgentOptions, DriverEvent } from "../../src/driver.js";
import { startStubProvider, systemTextOf, toolNamesOf, writeStubModels, type StubProvider } from "./stub-provider.js";

let base: string;
let stub: StubProvider;
const drivers: StableSdkDriver[] = [];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-agent-config-`));
  mkdirSync(join(base, "project"), { recursive: true });
  stub = await startStubProvider(() => ({ text: "ok" }));
  writeStubModels(join(base, "agent"), stub.url);
});

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.dispose().catch(() => {});
  await stub.close();
  rmSync(base, { recursive: true, force: true });
});

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill\n---\n\nUse ${name}.\n`);
}

function agentOptions(definition: AgentDefinition, name = definition.name): DriverAgentOptions {
  return { definition, role: rootRole(name), record: rootRecord(name), policy: fallbackPolicy() };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openAndPrompt(definition: AgentDefinition, text = "hello"): Promise<{ driver: StableSdkDriver; path: string }> {
  const driver = new StableSdkDriver();
  drivers.push(driver);
  const settled = new Promise<void>((resolve) => driver.subscribe((e: DriverEvent) => { if (e.type === "update" && e.update.kind === "agent_settled") resolve(); }));
  const state = await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(definition) });
  await driver.prompt([{ type: "text", text }]);
  await settled;
  return { driver, path: state.path };
}

describe("StableSdkDriver with an agent definition", () => {
  it("applies custom instructions and sets the definition's model, and still hands over every tool", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), name: "reader", engineInstructions: false, instructions: "You are a careful reader who only inspects.\n\nCurrent working directory: {{workingDirectory}}", model: { provider: "stub", id: "stub-1" } };
    const { driver } = await openAndPrompt(definition);
    expect(driver.state().model).toMatchObject({ provider: "stub", id: "stub-1" });
    const request = stub.requests[0]!;
    expect(systemTextOf(request).startsWith("You are a careful reader who only inspects.")).toBe(true);
    expect(systemTextOf(request)).not.toContain("expert coding assistant");
    expect(systemTextOf(request)).toContain(`Current working directory: ${join(base, "project")}`);
    // Every agent has every tool (D-144); what it is for is said in its instructions.
    expect(toolNamesOf(request)).toEqual(expect.arrayContaining([...ENGINE_BUILTIN_TOOLS]));
  }, 60_000);

  it("uses the product's default instructions and every tool for the shipped default agent", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } };
    await openAndPrompt(definition);
    const request = stub.requests[0]!;
    const productOwnedPrompt = systemTextOf(request).split("\n\nThe following skills")[0]!;
    expect(productOwnedPrompt).toContain(`expert coding assistant operating inside ${PRODUCT_DISPLAY_NAME}`);
    expect(productOwnedPrompt).not.toMatch(/\bpi\b/i);
    expect(productOwnedPrompt).not.toContain("documentation");
    expect(productOwnedPrompt).not.toContain("node_modules");
    expect(productOwnedPrompt).not.toContain("{{");
    for (const tool of ENGINE_BUILTIN_TOOLS) expect(productOwnedPrompt).toMatch(new RegExp(`^- ${tool}(?::|$)`, "m"));
    expect(toolNamesOf(request)).toEqual(expect.arrayContaining([...ENGINE_BUILTIN_TOOLS]));
    // Web search is an extension tool and follows its feature, which this session does not enable.
    expect(toolNamesOf(request)).not.toContain("web_search");
  }, 60_000);

  it("lists only the models of a connected provider, so a picker cannot offer one that would be refused", async () => {
    const driver = new StableSdkDriver();
    drivers.push(driver);
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(fallbackDefaultAgent()) });
    const models = await driver.listModels();
    // The stub is the credential this sandbox writes, so it is offered.
    expect(models).toContainEqual({ provider: "stub", id: "stub-1", name: "Stub One", contextWindow: 8000, reasoning: false, vision: false });
    // And the offer is a small part of the catalogue, not all of it: the
    // pinned engine knows over a thousand models across forty-odd providers,
    // and a picker may only show the ones that can answer (D-145). Which
    // others qualify depends on the credentials on this machine, so what is
    // asserted is the narrowing, not a fixed list.
    expect(models.length).toBeLessThan(200);
  }, 60_000);

  it("discovers user skills for every unscoped agent and honours scoped skills", async () => {
    writeSkill(join(base, "agent", "skills"), "alpha-skill");
    writeSkill(join(base, "agent", "skills"), "beta-skill");
    const model = { provider: "stub", id: "stub-1" };
    const everyone: AgentDefinition = { ...fallbackDefaultAgent(), name: "open", model };
    await openAndPrompt(everyone);
    let system = systemTextOf(stub.requests[0]!);
    expect(system).toContain("alpha-skill");
    expect(system).toContain("beta-skill");

    const scoped: AgentDefinition = { ...fallbackDefaultAgent(), name: "narrow", model, scopedSkills: true, skills: [{ name: "beta-skill", path: join(base, "agent", "skills", "beta-skill", "SKILL.md"), scope: "global" }] };
    await openAndPrompt(scoped);
    system = systemTextOf(stub.requests[1]!);
    expect(system).toContain("beta-skill");
    expect(system).not.toContain("alpha-skill");

    const beam = fallbackBeamAgent({ model });
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const settled = new Promise<void>((resolve) => driver.subscribe((e: DriverEvent) => { if (e.type === "update" && e.update.kind === "agent_settled") resolve(); }));
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(beam, "beam") });
    await driver.prompt([{ type: "text", text: "where are my sessions?" }]);
    await settled;
    system = systemTextOf(stub.requests[2]!);
    expect(system).toContain("alpha-skill");
    expect(system).toContain("beta-skill");
    expect(system.startsWith("You are Beam")).toBe(true);
  }, 90_000);

  it("refuses a definition whose model has no connected provider, naming the model", async () => {
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
    await expect(driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), agent: agentOptions(definition) })).rejects.toThrow(/anthropic\/claude-sonnet-4-5 is not available: connect anthropic in Settings → Providers and models/);
  }, 60_000);

  it("reopens a Beam session whose workspace folder vanished by recreating the folder", async () => {
    const beam = fallbackBeamAgent({ model: null });
    const workspace = join(base, "state", "workspaces", "beam");
    mkdirSync(workspace, { recursive: true });
    const driver = new StableSdkDriver();
    const state = await driver.open({ cwd: workspace, agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(beam, "beam") });
    await driver.prompt([{ type: "text", text: "hello" }]);
    await driver.dispose();
    expect(existsSync(state.path)).toBe(true);

    // The layout moved (or the folder was removed): the stored cwd is gone.
    rmSync(workspace, { recursive: true, force: true });
    expect(existsSync(workspace)).toBe(false);
    const again = new StableSdkDriver();
    const reopened = await again.open({ cwd: workspace, agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), sessionPath: state.path, projectTrusted: true, agent: agentOptions(beam, "beam") });
    expect(reopened.path).toBe(state.path);
    expect(reopened.cwd).toBe(workspace);
    // `state.agent` is the worker's decoration, not the driver's; what matters
    // here is that the session opened at all and its folder is back.
    expect(existsSync(workspace)).toBe(true);
    await again.dispose();

    // A project session gets the engine's refusal, not a recreated directory.
    const project = join(base, "vanishing-project");
    mkdirSync(project, { recursive: true });
    const plain = new StableSdkDriver();
    const projectState = await plain.open({ cwd: project, agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(fallbackDefaultAgent()) });
    await plain.prompt([{ type: "text", text: "hello" }]);
    await plain.dispose();
    rmSync(project, { recursive: true, force: true });
    const back = new StableSdkDriver();
    await expect(back.open({ cwd: project, agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), sessionPath: projectState.path, projectTrusted: true, agent: agentOptions(fallbackDefaultAgent()) })).rejects.toThrow(/does not exist/);
    expect(existsSync(project)).toBe(false);
    // Four real sessions against the engine; the default 5 s is not enough on a loaded machine.
  }, 60_000);

  it("rebinds the same pristine identity and runs the selected agent on its one first prompt", async () => {
    const original: AgentDefinition = {
      ...fallbackDefaultAgent(),
      name: "default",
      engineInstructions: false,
      instructions: "ORIGINAL FIRST TURN",
      model: { provider: "stub", id: "stub-1" },
    };
    const selected: AgentDefinition = {
      ...fallbackDefaultAgent(),
      name: "reviewer",
      engineInstructions: false,
      instructions: "SELECTED FIRST TURN",
      model: { provider: "stub", id: "stub-1" },
    };
    const creator = new StableSdkDriver();
    drivers.push(creator);
    const created = await creator.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(original) });
    await creator.rename("Saved empty");
    await creator.setThinkingLevel("off");
    await creator.dispose();
    const durableEmpty = readFileSync(created.path);
    expect(durableEmpty.toString()).not.toContain('"type":"message"');

    const driver = new StableSdkDriver();
    drivers.push(driver);
    const before = await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), sessionPath: created.path, projectTrusted: true, agent: agentOptions(original) });
    expect(await readSessionAgentRecord(before.path)).toEqual({ agentName: "default", kind: "root" });
    const baseline = readFileSync(before.path);
    await driver.prepareFirstTurn({ agent: agentOptions(selected), thinkingLevel: "off" });
    expect(driver.state()).toMatchObject({ path: before.path, id: before.id, name: "Saved empty" });
    // Runtime preparation is still tentative on disk.
    expect(readFileSync(before.path)).toEqual(baseline);
    expect(await readSessionAgentRecord(before.path)).toEqual({ agentName: "default", kind: "root" });

    let accepted = 0;
    await expect(driver.prompt([{ type: "text", text: "review it" }], { onAccepted: () => { accepted += 1; } }))
      .resolves.toEqual({ accepted: true, queued: false });
    expect(accepted).toBe(1);
    expect(stub.requests).toHaveLength(1);
    expect(systemTextOf(stub.requests[0]!)).toContain("SELECTED FIRST TURN");
    expect(systemTextOf(stub.requests[0]!)).not.toContain("ORIGINAL FIRST TURN");
    expect(await readSessionAgentRecord(before.path)).toEqual({ agentName: "reviewer", kind: "root" });
    const acceptedBytes = readFileSync(before.path);
    expect(acceptedBytes.subarray(0, baseline.length)).toEqual(baseline);
    const lines = acceptedBytes.toString().trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; message?: { role?: string } });
    expect(lines.filter((line) => line.type === "message" && line.message?.role === "user")).toHaveLength(1);
    expect(lines.filter((line) => line.customType === SESSION_AGENT_ENTRY_TYPE)).toHaveLength(2);
  }, 60_000);

  it("binds first-turn model intent through WorkerServer with exact precedence", async () => {
    writeSkill(join(base, "agent", "skills"), "selected-skill");
    writeFileSync(join(base, "agent", "models.json"), JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [
            { id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000, reasoning: true },
            { id: "stub-2", name: "Stub Two", contextWindow: 8000, maxTokens: 1000, reasoning: true },
          ],
        },
      },
    }));
    writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({
      defaultProvider: "stub",
      defaultModel: "stub-1",
      defaultThinkingLevel: "medium",
    }));
    const selected: AgentDefinition = {
      ...fallbackDefaultAgent(),
      name: "reviewer",
      engineInstructions: true,
      instructions: "SERVER SELECTED AGENT",
      scopedSkills: true,
      skills: [{ name: "selected-skill", path: join(base, "agent", "skills", "selected-skill", "SKILL.md"), scope: "global" }],
      model: { provider: "stub", id: "stub-2" },
      thinkingLevel: "high",
    };
    const followsDefault: AgentDefinition = { ...selected, name: "follower", model: null, thinkingLevel: null };
    const messages: JsonRpcMessage[] = [];
    const server = new WorkerServer({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => {
        const driver = new StableSdkDriver();
        drivers.push(driver);
        return driver;
      },
      send: (message) => messages.push(message),
    });
    let id = 0;
    const call = async (method: string, params: unknown) => {
      const requestId = ++id;
      await server.handle({ jsonrpc: "2.0", id: requestId, method, params });
      return messages.find((message) => "id" in message && message.id === requestId) as { result?: unknown; error?: unknown };
    };
    const snapshot = fallbackSnapshot();
    await call("agents/sync", { snapshot: { ...snapshot, agents: [...snapshot.agents, selected, followsDefault] } });
    const created = await call("session/new", { cwd: join(base, "project") });
    const before = (created.result as { state: SessionState }).state;
    await call("pi/model/set", { path: before.path, model: { provider: "stub", id: "stub-1" } });
    const prompted = await call("session/prompt", {
      path: before.path,
      content: [{ type: "text", text: "one exact first message" }],
      firstTurn: { agentName: "reviewer", thinkingLevel: "high" },
    });

    expect(prompted.result).toEqual({ accepted: true, queued: false });
    const loaded = await call("session/load", { path: before.path });
    const after = (loaded.result as { state: SessionState }).state;
    expect(after).toMatchObject({ path: before.path, id: before.id, thinkingLevel: "high", model: { provider: "stub", id: "stub-1" }, agent: { agentName: "reviewer", kind: "root" } });
    expect(server.openSessions()).toEqual([before.path]);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ model: "stub-1", reasoning_effort: "high" });
    expect(systemTextOf(stub.requests[0]!)).toContain("selected-skill");
    const lines = readFileSync(before.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } });
    expect(lines.filter((line) => line.type === "message" && line.message?.role === "user")).toHaveLength(1);
    expect(JSON.stringify(lines.find((line) => line.type === "message" && line.message?.role === "user")?.message?.content)).toContain("one exact first message");

    // The field was absent above, so legacy pristine-session precedence kept
    // the explicit stub-1 override. Null is the new agent-selection intent:
    // it bypasses and durably clears that stale override.
    const followsAgent = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    await call("pi/model/set", { path: followsAgent.path, model: { provider: "stub", id: "stub-1" } });
    await call("pi/thinking/set", { path: followsAgent.path, level: "low" });
    await call("session/prompt", {
      path: followsAgent.path,
      content: [{ type: "text", text: "newest agent choice" }],
      firstTurn: { agentName: "reviewer", model: null },
    });
    expect(stub.requests[1]).toMatchObject({ model: "stub-2", reasoning_effort: "high" });
    await call("pi/session/close", { path: followsAgent.path });
    expect((await call("session/load", { path: followsAgent.path }).then((reply) => reply.result as { state: SessionState })).state)
      .toMatchObject({ path: followsAgent.path, id: followsAgent.id, model: { provider: "stub", id: "stub-2" }, thinkingLevel: "high" });
    const acceptedOverrides = readFileSync(followsAgent.path, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
      .filter((line) => line.customType === SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE);
    expect(acceptedOverrides.at(-1)?.data).toEqual({});

    // A manual model chosen after the agent is explicit and wins.
    const explicit = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    await call("session/prompt", {
      path: explicit.path,
      content: [{ type: "text", text: "later explicit choice" }],
      firstTurn: { agentName: "reviewer", model: { provider: "stub", id: "stub-1" } },
    });
    expect(stub.requests[2]).toMatchObject({ model: "stub-1", reasoning_effort: "high" });

    // Null on both the intent and definition delegates to the project default.
    const fallback = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    await call("pi/thinking/set", { path: fallback.path, level: "low" });
    await call("session/prompt", {
      path: fallback.path,
      content: [{ type: "text", text: "project default" }],
      firstTurn: { agentName: "follower", model: null },
    });
    expect(stub.requests[3]).toMatchObject({ model: "stub-1", reasoning_effort: "medium" });
    await call("pi/session/close", { path: fallback.path });
    expect((await call("session/load", { path: fallback.path }).then((reply) => reply.result as { state: SessionState })).state)
      .toMatchObject({ path: fallback.path, id: fallback.id, model: { provider: "stub", id: "stub-1" }, thinkingLevel: "medium" });

    // Pi's automatic initial entries are defaults, not person overrides: an
    // untouched session with absent model intent takes the selected agent.
    const untouched = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    await call("session/prompt", {
      path: untouched.path,
      content: [{ type: "text", text: "selected defaults" }],
      firstTurn: { agentName: "reviewer" },
    });
    expect(stub.requests[4]).toMatchObject({ model: "stub-2", reasoning_effort: "high" });
    expect((await call("session/load", { path: untouched.path }).then((reply) => reply.result as { state: SessionState })).state)
      .toMatchObject({ path: untouched.path, id: untouched.id, model: { provider: "stub", id: "stub-2" }, thinkingLevel: "high" });

    const unavailable = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    const refused = await call("session/prompt", {
      path: unavailable.path,
      content: [{ type: "text", text: "must not run" }],
      firstTurn: { agentName: "reviewer", model: { provider: "missing", id: "not-connected" } },
    });
    expect(refused.error).toBeDefined();
    expect(stub.requests).toHaveLength(5);
    await server.dispose();
  }, 60_000);

  it("validates the prepared effective model rather than the selected definition", async () => {
    writeFileSync(join(base, "agent", "models.json"), JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-1", name: "Available", contextWindow: 8000, maxTokens: 1000 }],
        },
      },
    }));
    writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1" }));
    writeFileSync(join(base, "agent", "auth.json"), JSON.stringify({
      anthropic: { type: "api_key", key: "revoked-test-key" },
    }));

    const available = { ...fallbackDefaultAgent(), name: "available", model: { provider: "stub", id: "stub-1" } } satisfies AgentDefinition;
    const unavailable = { ...fallbackDefaultAgent(), name: "unavailable", model: { provider: "missing", id: "missing-1" } } satisfies AgentDefinition;
    const messages: JsonRpcMessage[] = [];
    const server = new WorkerServer({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => {
        const driver = new StableSdkDriver();
        drivers.push(driver);
        return driver;
      },
      send: (message) => messages.push(message),
    });
    let id = 0;
    const call = async (method: string, params: unknown) => {
      const requestId = ++id;
      await server.handle({ jsonrpc: "2.0", id: requestId, method, params });
      return messages.find((message) => "id" in message && message.id === requestId) as { result?: unknown; error?: unknown };
    };
    const snapshot = fallbackSnapshot();
    await call("agents/sync", { snapshot: { ...snapshot, agents: [...snapshot.agents, available, unavailable] } });

    // Definition B is unavailable, but absent model intent preserves the
    // pristine session's available explicit A. The prepared A is what runs.
    const keepsA = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    await call("pi/model/set", { path: keepsA.path, model: { provider: "stub", id: "stub-1" } });
    expect((await call("session/prompt", {
      path: keepsA.path,
      content: [{ type: "text", text: "use available A" }],
      firstTurn: { agentName: "unavailable" },
    })).result).toEqual({ accepted: true, queued: false });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ model: "stub-1" });

    // Definition B is available, but absent intent preserves catalogued A
    // whose provider has no credential. Preparation succeeds, canonical
    // post-prepare validation refuses before provider work, then rolls back.
    const refusesA = (await call("session/new", { cwd: join(base, "project") }).then((reply) => reply.result as { state: SessionState })).state;
    const setAnthropic = await call("pi/model/set", {
      path: refusesA.path,
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    expect(setAnthropic.error).toBeUndefined();
    expect(existsSync(refusesA.path)).toBe(true);
    const refusalBaseline = readFileSync(refusesA.path);
    await call("pi/providers/logout", { cwd: join(base, "project"), provider: "anthropic" });
    const refused = await call("session/prompt", {
      path: refusesA.path,
      content: [{ type: "text", text: "must stop before provider" }],
      firstTurn: { agentName: "available" },
    });
    expect(refused.error).toBeDefined();
    expect(stub.requests).toHaveLength(1);
    expect((await call("session/load", { path: refusesA.path }).then((reply) => reply.result as { state: SessionState })).state)
      .toMatchObject({ model: { provider: "anthropic", id: "claude-sonnet-4-5" }, agent: { agentName: "default", kind: "root" } });
    expect(readFileSync(refusesA.path)).toEqual(refusalBaseline);
    await server.dispose();
  }, 60_000);

  it("normalizes incompatible first-turn thinking and restores the prior level on refusal", async () => {
    writeFileSync(join(base, "agent", "models.json"), JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [
            { id: "stub-1", name: "Plain", contextWindow: 8000, maxTokens: 1000, reasoning: false },
            { id: "stub-2", name: "Reasoner", contextWindow: 8000, maxTokens: 1000, reasoning: true },
          ],
        },
      },
    }));
    const original = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-2" } } satisfies AgentDefinition;
    const selected = { ...original, name: "reviewer", model: { provider: "stub", id: "stub-1" }, thinkingLevel: "high" as const } satisfies AgentDefinition;
    const driver = new StableSdkDriver();
    drivers.push(driver);
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      projectTrusted: true,
      agent: agentOptions(original),
    });
    await driver.setThinkingLevel("high");
    const rejectionBaseline = readFileSync(driver.state().path);

    await driver.prepareFirstTurn({ agent: agentOptions(selected), model: null, thinkingLevel: "high" });
    expect(driver.state().thinkingLevel).toBe("off");
    expect(readFileSync(driver.state().path)).toEqual(rejectionBaseline);
    await driver.rollbackFirstTurn();
    expect(driver.state().thinkingLevel).toBe("high");
    expect(readFileSync(driver.state().path)).toEqual(rejectionBaseline);

    // Acceptance persists the normalized effective level, not the incompatible
    // request or the stale pristine override, and a recreated engine agrees.
    const path = driver.state().path;
    await driver.prepareFirstTurn({ agent: agentOptions(selected), model: null, thinkingLevel: "high" });
    await driver.prompt([{ type: "text", text: "accept normalized thinking" }]);
    expect(stub.requests[0]).toMatchObject({ model: "stub-1" });
    expect(stub.requests[0]).not.toHaveProperty("reasoning_effort");
    const acceptedEntries = readFileSync(path, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { type?: string; provider?: string; modelId?: string; thinkingLevel?: string; customType?: string; data?: { thinkingLevel?: string }; message?: { role?: string } });
    const baselineEntries = rejectionBaseline.toString().trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
    expect(acceptedEntries.filter((entry) => entry.type === "model_change" && entry.provider === "stub" && entry.modelId === "stub-1")).toHaveLength(1);
    expect(acceptedEntries.filter((entry) => entry.type === "thinking_level_change")).toHaveLength(baselineEntries.filter((entry) => entry.type === "thinking_level_change").length + 1);
    expect(acceptedEntries.filter((entry) => entry.type === "message" && entry.message?.role === "user")).toHaveLength(1);
    const overrides = acceptedEntries.filter((entry) => entry.customType === SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE);
    expect(overrides.at(-1)?.data?.thinkingLevel).toBe("off");
    await driver.dispose();
    const again = new StableSdkDriver();
    drivers.push(again);
    const reloaded = await again.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      sessionPath: path,
      projectTrusted: true,
      agent: agentOptions(selected),
    });
    expect(reloaded.thinkingLevel).toBe("off");
  }, 60_000);

  it("retains accepted provenance and retries it in order after an atomic commit failure", async () => {
    const original = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" }, thinkingLevel: "low" as const } satisfies AgentDefinition;
    const selected = { ...original, name: "reviewer", thinkingLevel: "high" as const } satisfies AgentDefinition;
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const opened = await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(original) });
    const baseline = readFileSync(opened.path);
    await driver.prepareFirstTurn({ agent: agentOptions(selected), model: null, thinkingLevel: "high" });
    chmodSync(join(base, "sessions"), 0o500);
    const errors: unknown[][] = [];
    const diagnostic = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
      // The next manager append gets the one allowed atomic retry.
      chmodSync(join(base, "sessions"), 0o700);
    });
    try {
      await expect(driver.prompt([{ type: "text", text: "accepted once" }])).resolves.toEqual({ accepted: true, queued: false });
    } finally {
      chmodSync(join(base, "sessions"), 0o700);
      diagnostic.mockRestore();
    }
    expect(errors.some((args) => args.join(" ").includes("could not persist the accepted agent choice"))).toBe(true);
    expect(stub.requests).toHaveLength(1);
    const bytes = readFileSync(opened.path);
    expect(bytes.subarray(0, baseline.length)).toEqual(baseline);
    const entries = bytes.toString().trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: { agentName?: string }; message?: { role?: string } });
    expect(entries.filter((entry) => entry.customType === SESSION_AGENT_ENTRY_TYPE && entry.data?.agentName === "reviewer")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "message" && entry.message?.role === "user")).toHaveLength(1);
  }, 60_000);

  it("keeps a no-signal candidate question answerable before acceptance and retires it on cancellation", async () => {
    const original = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" }, thinkingLevel: "low" as const } satisfies AgentDefinition;
    const selected = { ...original, name: "reviewer", thinkingLevel: "high" as const } satisfies AgentDefinition;
    const entered = [deferred(), deferred()];
    let promptOrdinal = 0;
    let diagnosticOrdinal = 0;
    const question: InlineExtension = (pi) => {
      pi.on("before_agent_start", (_event, context) => {
        context.ui.notify(`candidate diagnostic ${diagnosticOrdinal++}`, "warning");
        throw new Error("candidate diagnostic");
      });
      pi.on("before_agent_start", async (_event, context) => {
        const ordinal = promptOrdinal++;
        pi.appendEntry("test/candidate-projection", { ordinal });
        context.ui.setStatus("candidate", `waiting-${ordinal}`);
        const answer = context.ui.confirm("Candidate question", `Accept candidate ${ordinal}?`);
        entered[ordinal]?.resolve();
        await answer;
      });
    };
    const messages: JsonRpcMessage[] = [];
    const driverEvents: DriverEvent[] = [];
    const server = new WorkerServer({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => {
        const driver = new StableSdkDriver([question]);
        driver.subscribe((event) => driverEvents.push(event));
        drivers.push(driver);
        return driver;
      },
      send: (message) => messages.push(message),
    });
    let id = 0;
    const call = async (method: string, params: unknown) => {
      const requestId = ++id;
      await server.handle({ jsonrpc: "2.0", id: requestId, method, params });
      return messages.find((message) => "id" in message && message.id === requestId) as { result?: unknown; error?: unknown };
    };
    const notificationsSince = (start: number, method: string) => messages.slice(start)
      .filter((message): message is Extract<JsonRpcMessage, { method: string }> => "method" in message && !("id" in message) && message.method === method);
    const snapshot = fallbackSnapshot();
    await call("agents/sync", { snapshot: { ...snapshot, agents: [...snapshot.agents, selected] } });

    const accepted = (await call("session/new", { cwd: join(base, "project"), agentName: original.name }).then((reply) => reply.result as { state: SessionState })).state;
    const acceptedStart = messages.length;
    const acceptedRequestId = id + 1;
    const accepting = call("session/prompt", {
      path: accepted.path,
      content: [{ type: "text", text: "answer before acceptance" }],
      firstTurn: { agentName: "reviewer", model: null, thinkingLevel: "high" },
    });
    await entered[0]!.promise;
    const acceptedQuestion = notificationsSince(acceptedStart, "pi/ui/request")[0];
    expect(acceptedQuestion?.params).toMatchObject({ path: accepted.path, method: "confirm", title: "Candidate question" });
    expect(messages.some((message) => "id" in message && !("method" in message) && message.id === acceptedRequestId)).toBe(false);
    expect(notificationsSince(acceptedStart, "session/update").map((message) => (message.params as { update: { kind: string } }).update.kind)).toEqual(["extension_error"]);
    expect(notificationsSince(acceptedStart, "pi/ui/event").map((message) => (message.params as { method: string }).method)).toEqual(["notify"]);
    const acceptedQuestionId = (acceptedQuestion!.params as { id: string }).id;
    const acceptedQuestionEvent = driverEvents.find((event) => event.type === "ui_request" && event.request.id === acceptedQuestionId);
    expect(acceptedQuestionEvent).toMatchObject({ type: "ui_request", invocation: { id: expect.any(String) } });
    expect((await call("pi/ui/response", { id: acceptedQuestionId, confirmed: true })).result).toEqual({ delivered: true });
    expect(await accepting).toMatchObject({ result: { accepted: true, queued: false } });
    expect(stub.requests).toHaveLength(1);

    const cancelled = (await call("session/new", { cwd: join(base, "project"), agentName: original.name }).then((reply) => reply.result as { state: SessionState })).state;
    const baseline = readFileSync(cancelled.path);
    const cancelledStart = messages.length;
    const cancelling = call("session/prompt", {
      path: cancelled.path,
      content: [{ type: "text", text: "must remain unsent" }],
      firstTurn: { agentName: "reviewer", model: null, thinkingLevel: "high" },
    });
    await entered[1]!.promise;
    const cancelledQuestion = notificationsSince(cancelledStart, "pi/ui/request")[0];
    expect(cancelledQuestion?.params).toMatchObject({ path: cancelled.path, method: "confirm", title: "Candidate question" });
    const cancelledQuestionId = (cancelledQuestion!.params as { id: string }).id;
    expect(notificationsSince(cancelledStart, "session/update").map((message) => (message.params as { update: { kind: string } }).update.kind)).toEqual(["extension_error"]);
    expect(notificationsSince(cancelledStart, "pi/ui/event").map((message) => (message.params as { method: string }).method)).toEqual(["notify"]);
    expect((await call("session/cancel", { path: cancelled.path })).error).toBeUndefined();
    expect((await cancelling).error).toBeDefined();
    expect(stub.requests).toHaveLength(1);
    expect(readFileSync(cancelled.path)).toEqual(baseline);
    expect(notificationsSince(cancelledStart, "session/update").filter((message) => (message.params as { update?: { kind?: string } }).update?.kind !== "extension_error")).toEqual([]);
    expect(notificationsSince(cancelledStart, "pi/ui/event").map((message) => message.params)).toContainEqual(expect.objectContaining({ path: cancelled.path, method: "dialogResolved", id: cancelledQuestionId }));
    const cancelledQuestionEvent = driverEvents.find((event) => event.type === "ui_request" && event.request.id === cancelledQuestionId);
    const retiredQuestionEvent = driverEvents.find((event) => event.type === "ui_event" && event.event.method === "dialogResolved" && event.event.id === cancelledQuestionId);
    expect(cancelledQuestionEvent).toMatchObject({ type: "ui_request", invocation: { id: expect.any(String) } });
    expect(retiredQuestionEvent).toMatchObject({ type: "ui_event", invocation: (cancelledQuestionEvent as Extract<DriverEvent, { type: "ui_request" }>).invocation });
    expect((await call("pi/ui/response", { id: cancelledQuestionId, confirmed: true })).result).toEqual({ delivered: false });
    expect((await call("session/load", { path: cancelled.path }).then((reply) => reply.result as { state: SessionState })).state)
      .toMatchObject({ id: cancelled.id, path: cancelled.path, model: cancelled.model, thinkingLevel: cancelled.thinkingLevel, agent: cancelled.agent });
    await server.dispose();
  }, 60_000);

  it("keeps a speculative extension setup append invisible and discards it on rollback", async () => {
    const original = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" }, thinkingLevel: "low" as const } satisfies AgentDefinition;
    const selected = { ...original, name: "reviewer", thinkingLevel: "high" as const } satisfies AgentDefinition;
    let failSetup = false;
    const injectedSetup: InlineExtension = (pi) => {
      pi.on("session_start", async (_event, context) => {
        if (!failSetup) return;
        (context.sessionManager as unknown as SessionManager).appendCustomEntry("test/speculative-setup", { candidate: true });
        // Pi isolates extension handler failures, so the manager append is the
        // observable setup side effect this transaction must still contain.
      });
    };
    const driver = new StableSdkDriver([injectedSetup]);
    drivers.push(driver);
    const opened = await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(original) });
    const baseline = readFileSync(opened.path);
    const speculativeEvents: DriverEvent[] = [];
    driver.subscribe((event) => speculativeEvents.push(event));
    failSetup = true;

    await driver.prepareFirstTurn({ agent: agentOptions(selected), model: null, thinkingLevel: "high" });
    expect(readFileSync(opened.path)).toEqual(baseline);
    expect(speculativeEvents).toEqual([]);
    expect((await driver.entries()).entries.some((entry) => JSON.stringify(entry).includes("test/speculative-setup"))).toBe(true);
    await driver.rollbackFirstTurn();
    expect(readFileSync(opened.path)).toEqual(baseline);
    expect(driver.state()).toMatchObject({ id: opened.id, path: opened.path, model: opened.model, thinkingLevel: opened.thinkingLevel });
    expect((await driver.entries()).entries.some((entry) => JSON.stringify(entry).includes("test/speculative-setup"))).toBe(false);
    expect(speculativeEvents).toEqual([]);
    expect(await readSessionAgentRecord(opened.path)).toEqual({ agentName: "default", kind: "root" });
  }, 60_000);

  it.each([false, true])("restores exact effective state after preparation failure/rollback (manual override: %s)", async (manual) => {
    writeFileSync(join(base, "agent", "models.json"), JSON.stringify({
      providers: {
        stub: {
          baseUrl: stub.url,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [
            { id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000, reasoning: true },
            { id: "stub-2", name: "Stub Two", contextWindow: 8000, maxTokens: 1000, reasoning: true },
          ],
        },
      },
    }));
    const original: AgentDefinition = {
      ...fallbackDefaultAgent(), name: "default", engineInstructions: false,
      instructions: "ORIGINAL AFTER ROLLBACK", model: { provider: "stub", id: "stub-1" }, thinkingLevel: "low",
    };
    const selected: AgentDefinition = {
      ...fallbackDefaultAgent(), name: "reviewer", engineInstructions: false,
      instructions: "SHOULD NOT RUN", model: { provider: "stub", id: "stub-1" },
    };
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const before = await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(original) });
    if (manual) {
      await driver.setModel({ provider: "stub", id: "stub-2" });
      await driver.setThinkingLevel("high");
    } else {
      // Factory failure happens after the old runtime has been disposed, but
      // must leave the original effective session served and retryable.
      await expect(driver.prepareFirstTurn({ agent: agentOptions({ ...selected, model: { provider: "missing", id: "unavailable" } }) }))
        .rejects.toThrow(/not available/);
      expect(driver.state()).toMatchObject({ path: before.path, id: before.id, model: before.model, thinkingLevel: before.thinkingLevel });
      expect(stub.requests).toHaveLength(0);
    }
    const effective = driver.state();
    const baseline = readFileSync(effective.path);
    await driver.prepareFirstTurn({ agent: agentOptions(selected), model: null, thinkingLevel: "off" });
    expect(readFileSync(effective.path)).toEqual(baseline);
    await driver.rollbackFirstTurn();
    expect(driver.state()).toMatchObject({ path: effective.path, id: effective.id, model: effective.model, thinkingLevel: effective.thinkingLevel });
    expect(readFileSync(effective.path)).toEqual(baseline);
    await driver.prompt([{ type: "text", text: "continue" }]);

    expect(stub.requests[0]).toMatchObject({ model: manual ? "stub-2" : "stub-1", reasoning_effort: manual ? "high" : "low" });
    expect(systemTextOf(stub.requests[0]!)).toContain("ORIGINAL AFTER ROLLBACK");
    expect(systemTextOf(stub.requests[0]!)).not.toContain("SHOULD NOT RUN");
    expect(await readSessionAgentRecord(before.path)).toEqual({ agentName: "default", kind: "root" });
  }, 60_000);

  it("writes the agent record as the first custom entry of a new session and recovers it on load", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), name: "recorder", model: { provider: "stub", id: "stub-1" } };
    // The genuine empty state and its first agent record are durable at open.
    const { driver, path } = await openAndPrompt(definition);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; data?: unknown });
    const custom = lines.filter((line) => line.type === "custom");
    expect(custom[0]).toMatchObject({ customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "recorder", kind: "root" } });
    expect(lines.findIndex((line) => line.customType === SESSION_AGENT_ENTRY_TYPE)).toBeLessThan(lines.findIndex((line) => line.type === "message"));
    expect(await readSessionAgentRecord(path)).toEqual({ agentName: "recorder", kind: "root" });
    await driver.dispose();
    const state = { path };

    // Loading appends no second record.
    const again = new StableSdkDriver();
    drivers.push(again);
    await again.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), sessionPath: state.path, agent: agentOptions(definition) });
    const afterLoad = readFileSync(state.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string });
    expect(afterLoad.filter((line) => line.customType === SESSION_AGENT_ENTRY_TYPE)).toHaveLength(1);
    // A no-agent resource-preview open is never exposed and writes nothing.
    const plain = new StableSdkDriver();
    drivers.push(plain);
    const ephemeral = await plain.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    expect(existsSync(ephemeral.path)).toBe(false);
  }, 60_000);
});
