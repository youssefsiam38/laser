/**
 * M13-T3 · per-agent session configuration against the real engine: custom
 * versus engine instructions, built-in tool filtering, skill scoping (the
 * Beam skill only for Beam), the model refusal, and the agent record written
 * on a new session and recovered on load.
 */
import { AGENT_DEFAULT_TOOLS, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentDefinition } from "@lasercode/protocol";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEAM_SKILL_NAME, ensureBeamSkill } from "../../src/agents/beam-skill.js";
import { fallbackBeamAgent, fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { readSessionAgentRecord, rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
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
  return { definition, role: rootRole(name), record: rootRecord(name), policy: fallbackPolicy(), beamSkillName: BEAM_SKILL_NAME };
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
  it("applies custom instructions, filters built-in tools and sets the definition's model", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), name: "reader", engineInstructions: false, instructions: "You are a careful reader who only inspects.", tools: ["read", "grep"], model: { provider: "stub", id: "stub-1" } };
    const { driver } = await openAndPrompt(definition);
    expect(driver.state().model).toMatchObject({ provider: "stub", id: "stub-1" });
    const request = stub.requests[0]!;
    expect(systemTextOf(request).startsWith("You are a careful reader who only inspects.")).toBe(true);
    expect(systemTextOf(request)).not.toContain("expert coding assistant");
    const tools = toolNamesOf(request);
    expect(tools).toEqual(expect.arrayContaining(["read", "grep"]));
    for (const name of ["bash", "edit", "write", "find", "ls"]) expect(tools).not.toContain(name);
  }, 60_000);

  it("keeps the engine's built-in instructions and every default tool for the shipped default agent", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } };
    await openAndPrompt(definition);
    const request = stub.requests[0]!;
    expect(systemTextOf(request)).toContain("expert coding assistant");
    // Every engine tool of the default set; `web_search` needs the Web search feature, which this session does not enable.
    expect(toolNamesOf(request)).toEqual(expect.arrayContaining(AGENT_DEFAULT_TOOLS.filter((tool) => tool !== "web_search")));
    expect(toolNamesOf(request)).not.toContain("web_search");
  }, 60_000);

  it("offers the Beam skill only to Beam and honours scoped skills", async () => {
    ensureBeamSkill({ agentDir: join(base, "agent"), stateDir: join(base, "state") });
    writeSkill(join(base, "agent", "skills"), "alpha-skill");
    writeSkill(join(base, "agent", "skills"), "beta-skill");
    const model = { provider: "stub", id: "stub-1" };
    const everyone: AgentDefinition = { ...fallbackDefaultAgent(), name: "open", model };
    await openAndPrompt(everyone);
    let system = systemTextOf(stub.requests[0]!);
    expect(system).toContain("alpha-skill");
    expect(system).toContain("beta-skill");
    expect(system).not.toContain(BEAM_SKILL_NAME);

    const scoped: AgentDefinition = { ...fallbackDefaultAgent(), name: "narrow", model, scopedSkills: true, skills: [{ name: "beta-skill", path: join(base, "agent", "skills", "beta-skill", "SKILL.md"), scope: "global" }] };
    await openAndPrompt(scoped);
    system = systemTextOf(stub.requests[1]!);
    expect(system).toContain("beta-skill");
    expect(system).not.toContain("alpha-skill");
    expect(system).not.toContain(BEAM_SKILL_NAME);

    const beam = { ...fallbackBeamAgent({ model, beamSkill: { name: BEAM_SKILL_NAME, path: join(base, "agent", "skills", BEAM_SKILL_NAME, "SKILL.md"), scope: "global" } }) };
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const settled = new Promise<void>((resolve) => driver.subscribe((e: DriverEvent) => { if (e.type === "update" && e.update.kind === "agent_settled") resolve(); }));
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent: agentOptions(beam, "beam") });
    await driver.prompt([{ type: "text", text: "where are my sessions?" }]);
    await settled;
    system = systemTextOf(stub.requests[2]!);
    expect(system).toContain(BEAM_SKILL_NAME);
    expect(system).not.toContain("alpha-skill");
    expect(system.startsWith("You are Beam")).toBe(true);
  }, 90_000);

  it("refuses a definition whose model has no connected provider, naming the model", async () => {
    const driver = new StableSdkDriver();
    drivers.push(driver);
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
    await expect(driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), agent: agentOptions(definition) })).rejects.toThrow(/anthropic\/claude-sonnet-4-5 is not available: connect anthropic in Settings → Providers and models/);
  }, 60_000);

  it("reopens a Beam session whose workspace folder vanished by recreating the folder", async () => {
    ensureBeamSkill({ agentDir: join(base, "agent"), stateDir: join(base, "state") });
    const beam = fallbackBeamAgent({ model: null, beamSkill: { name: BEAM_SKILL_NAME, path: join(base, "agent", "skills", BEAM_SKILL_NAME, "SKILL.md"), scope: "bundled" } });
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
  });

  it("writes the agent record as the first custom entry of a new session and recovers it on load", async () => {
    const definition: AgentDefinition = { ...fallbackDefaultAgent(), name: "recorder", model: { provider: "stub", id: "stub-1" } };
    // The engine flushes a new session's file on its first assistant message;
    // the record, appended at open, is the first custom entry in it.
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
    // An ephemeral open without an agent writes nothing.
    const plain = new StableSdkDriver();
    drivers.push(plain);
    const ephemeral = await plain.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions") });
    expect(existsSync(ephemeral.path)).toBe(false);
  }, 60_000);
});
