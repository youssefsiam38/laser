import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GLOBAL_AGENTS_DIR_NAME,
  PRODUCT_NAME,
  PROJECT_AGENTS_DIR,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentsSnapshot,
} from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeAgentFile } from "../../src/agents/agent-file.js";
import { AgentStore } from "../../src/agents/store.js";

let dir: string;
let stores: AgentStore[];
const workspaces = { beam: "/workspaces/beam", chat: "/workspaces/chat" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-agent-files-`));
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function createStore(patch: Partial<ConstructorParameters<typeof AgentStore>[0]> = {}): AgentStore {
  const stateDir = join(dir, "state");
  const store = new AgentStore({
    storePath: join(stateDir, "agents.json"),
    stateDir,
    agentDir: join(dir, "engine"),
    workspaces,
    watchDebounceMs: 25,
    watchPollMs: 25,
    ...patch,
  });
  stores.push(store);
  return store;
}

function input(name: string, patch: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    name,
    scope: "global",
    description: `${name} description`,
    instructions: `Act as ${name}.\n`,
    engineInstructions: false,
    excludeCoreInstructions: false,
    model: null,
    thinkingLevel: null,
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    ...patch,
  };
}

function fileDefinition(name: string, patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...input(name),
    kind: "custom",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw last;
}

describe("AgentStore Markdown files", () => {
  it("writes a UI save atomically and its watcher does not echo the revision", async () => {
    const changes: AgentsSnapshot[] = [];
    const store = createStore({ onChange: (snapshot) => changes.push(snapshot) });
    const saved = store.save(input("reviewer"));
    const revision = store.currentRevision;
    const path = join(dir, "state", GLOBAL_AGENTS_DIR_NAME, "reviewer.md");
    expect(saved.path).toBe(path);
    expect(readFileSync(path, "utf8")).toContain("description: reviewer description");
    expect(readFileSync(path, "utf8").endsWith("Act as reviewer.\n")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.currentRevision).toBe(revision);
    expect(changes).toHaveLength(1);
  });

  it("applies a hand edit within one second and keeps the last good definition behind a file warning", async () => {
    const store = createStore();
    const saved = store.save(input("reviewer"));
    writeFileSync(saved.path!, readFileSync(saved.path!, "utf8").replace("reviewer description", "hand edited"));
    await eventually(() => expect(store.get("reviewer")?.description).toBe("hand edited"));

    const goodRevision = store.currentRevision;
    writeFileSync(saved.path!, "---\nmodel: [broken\n---\nNope\n");
    await eventually(() => expect(store.warnings()).toEqual([
      expect.objectContaining({ agentName: "reviewer", field: "file", path: saved.path, target: saved.path, message: expect.stringContaining("Fix the YAML frontmatter") }),
    ]));
    expect(store.get("reviewer")?.description).toBe("hand edited");
    expect(store.currentRevision).toBeGreaterThan(goodRevision);

    writeFileSync(saved.path!, serializeAgentFile({ ...store.get("reviewer")!, description: "fixed" }));
    await eventually(() => {
      expect(store.get("reviewer")?.description).toBe("fixed");
      expect(store.warnings()).toEqual([]);
    });
  });

  it("removes a file-deleted agent and prunes references without an echo loop", async () => {
    const store = createStore();
    const reviewer = store.save(input("reviewer"));
    store.save(input("lead", { supportsSubagents: true, allowedAgents: ["reviewer"] }));
    unlinkSync(reviewer.path!);
    await eventually(() => {
      expect(store.get("reviewer")).toBeUndefined();
      expect(store.get("lead")?.allowedAgents).toEqual([]);
    });
    expect(readFileSync(store.get("lead")!.path!, "utf8")).toContain("allowedAgents: []");
  });

  it("falls back to another global default when the current default file is deleted by hand", async () => {
    const store = createStore();
    store.save(input("reviewer"));
    store.setDefault("reviewer");
    unlinkSync(store.get("reviewer")!.path!);
    await eventually(() => expect(store.snapshot().defaultAgent).toBe("default"));
    expect(store.get("reviewer")).toBeUndefined();
  });

  it("migrates version 1 once, preserving an exact backup and metadata without definitions", () => {
    const stateDir = join(dir, "state");
    const path = join(stateDir, "agents.json");
    mkdirSync(dirname(path), { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      revision: 7,
      agents: [fileDefinition("default", { instructions: "", engineInstructions: true }), fileDefinition("reviewer")],
      defaultAgent: "reviewer",
      policy: { maxDepth: 2, foregroundCommandSeconds: 90 },
      namer: { status: "unqualified", model: null, candidates: [] },
      beam: { model: null, suggested: null, needsChoice: false },
      chat: { model: null },
      builtinInstructions: { beam: null, chat: null, namer: null },
      renamedAgents: {},
    }, null, 2);
    writeFileSync(path, legacy);
    const existingPath = join(stateDir, GLOBAL_AGENTS_DIR_NAME, "reviewer.md");
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(existingPath, serializeAgentFile(fileDefinition("reviewer", { description: "existing file wins" })));
    const store = createStore();
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe(legacy);
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { version: number; agents?: unknown; defaultAgent: string };
    expect(metadata).toMatchObject({ version: 2, defaultAgent: "reviewer" });
    expect(metadata.agents).toBeUndefined();
    expect(store.snapshot()).toMatchObject({ revision: 7, defaultAgent: "reviewer" });
    expect(store.get("reviewer")).toMatchObject({ path: existingPath, description: "existing file wins" });
    store.close();
    stores.pop();
    const reopened = createStore();
    expect(reopened.snapshot()).toMatchObject({ revision: 7, defaultAgent: "reviewer" });
  });

  it("does not overwrite an existing migration backup", () => {
    const stateDir = join(dir, "state");
    const path = join(stateDir, "agents.json");
    mkdirSync(stateDir, { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      revision: 1,
      agents: [fileDefinition("default", { instructions: "", engineInstructions: true })],
      defaultAgent: "default",
    });
    writeFileSync(path, legacy);
    writeFileSync(`${path}.v1.bak`, "older backup");
    createStore();
    expect(readFileSync(`${path}.v1.bak`, "utf8")).toBe("older backup");
    expect(readFileSync(`${path}.v1.bak.1`, "utf8")).toBe(legacy);
  });

  it("leaves version 1 metadata untouched and never reconciles global files when migration is blocked", async () => {
    const stateDir = join(dir, "state");
    const path = join(stateDir, "agents.json");
    mkdirSync(stateDir, { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      revision: 3,
      agents: [fileDefinition("default", { instructions: "", engineInstructions: true })],
      defaultAgent: "default",
    });
    writeFileSync(path, legacy);
    writeFileSync(join(stateDir, GLOBAL_AGENTS_DIR_NAME), "not a directory");
    const logs: string[] = [];
    const store = createStore({ log: (line) => logs.push(line) });
    expect(readFileSync(path, "utf8")).toBe(legacy);
    expect(logs).toEqual([expect.stringContaining("migration left agents.json unchanged")]);
    expect(store.get("default")).toMatchObject({ kind: "custom", scope: "global" });

    rmSync(join(stateDir, GLOBAL_AGENTS_DIR_NAME), { force: true });
    mkdirSync(join(stateDir, GLOBAL_AGENTS_DIR_NAME), { recursive: true });
    writeFileSync(join(stateDir, GLOBAL_AGENTS_DIR_NAME, "other.md"), serializeAgentFile(fileDefinition("other")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.get("default")).toMatchObject({ kind: "custom", scope: "global" });
    expect(store.get("other")).toBeUndefined();
  });

  it("does not watch a project root while its configuration directory is absent and rescans on the next trust tick", async () => {
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    const store = createStore();
    store.setTrustedProjects([project]);
    const projectPath = join(project, PROJECT_AGENTS_DIR, "reviewer.md");
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, serializeAgentFile(fileDefinition("reviewer", { scope: "project", projectCwd: project })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.get("reviewer", project)).toBeUndefined();
    store.setTrustedProjects([project]);
    expect(store.get("reviewer", project)).toMatchObject({ scope: "project", projectCwd: project, path: projectPath });
    expect(store.get("reviewer")).toBeUndefined();

    store.setTrustedProjects([]);
    expect(store.get("reviewer", project)).toBeUndefined();
    expect(store.snapshot().agents.some((agent) => agent.path === projectPath)).toBe(false);
    store.setTrustedProjects([project]);
    expect(store.get("reviewer", project)).toMatchObject({ scope: "project", projectCwd: project });
  });

  it("allows scoped name shadowing and enforces reference and default boundaries", () => {
    const one = join(dir, "one");
    const two = join(dir, "two");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    const store = createStore({ trustedProjects: () => [one, two] });
    const global = store.save(input("reviewer", { description: "global" }));
    const projectOne = store.save(input("reviewer", { scope: "project", projectCwd: one, description: "one" }));
    const projectTwo = store.save(input("reviewer", { scope: "project", projectCwd: two, description: "two" }));
    expect(global.path).toBe(join(dir, "state", GLOBAL_AGENTS_DIR_NAME, "reviewer.md"));
    expect(store.get("reviewer")?.description).toBe("global");
    expect(store.get("reviewer", one)?.description).toBe("one");
    expect(store.get("reviewer", two)?.description).toBe("two");
    expect(projectOne.path).not.toBe(projectTwo.path);

    expect(store.validate(input("global-lead", { supportsSubagents: true, allowedAgents: ["local-only"] }))).toEqual([
      { field: "allowedAgents[0]", message: 'There is no agent named "local-only".' },
    ]);
    store.save(input("local-only", { scope: "project", projectCwd: one }));
    expect(store.validate(input("project-lead", { scope: "project", projectCwd: one, supportsSubagents: true, allowedAgents: ["reviewer", "local-only", "default"] }))).toEqual([]);
    expect(store.validate(input("wrong-project", { scope: "project", projectCwd: two, supportsSubagents: true, allowedAgents: ["local-only"] }))).toEqual([
      { field: "allowedAgents[0]", message: 'There is no agent named "local-only".' },
    ]);
    expect(() => store.setDefault("local-only")).toThrow("A project agent cannot be the default. Choose a global agent instead.");
  });

  it("keeps project definitions and files untouched when the directory listing is not authoritative", () => {
    const project = join(dir, "project");
    const agentsDir = join(project, PROJECT_AGENTS_DIR);
    mkdirSync(agentsDir, { recursive: true });
    const reviewerPath = join(agentsDir, "reviewer.md");
    const leadPath = join(agentsDir, "lead.md");
    writeFileSync(reviewerPath, serializeAgentFile(fileDefinition("reviewer", { scope: "project", projectCwd: project })));
    writeFileSync(leadPath, serializeAgentFile(fileDefinition("lead", {
      scope: "project",
      projectCwd: project,
      supportsSubagents: true,
      allowedAgents: ["reviewer"],
    })));
    const reviewerBefore = readFileSync(reviewerPath, "utf8");
    const leadBefore = readFileSync(leadPath, "utf8");
    const logs: string[] = [];
    const store = createStore({ trustedProjects: () => [project], log: (line) => logs.push(line), watchPollMs: 25 });

    chmodSync(agentsDir, 0o000);
    try {
      expect(() => store.setTrustedProjects([project])).not.toThrow();
      expect(store.get("reviewer", project)).toBeDefined();
      expect(store.get("lead", project)?.allowedAgents).toEqual(["reviewer"]);
    } finally {
      chmodSync(agentsDir, 0o700);
    }
    expect(readFileSync(reviewerPath, "utf8")).toBe(reviewerBefore);
    expect(readFileSync(leadPath, "utf8")).toBe(leadBefore);
    if (process.getuid?.() !== 0) expect(logs).toEqual([expect.stringContaining("keeping the last known definitions")]);
  });

  it("stages every file in a rename before changing memory and re-reads touched paths after a write failure", async () => {
    let writes = 0;
    let failAt = Number.POSITIVE_INFINITY;
    const store = createStore({
      writeFile: (path, text) => {
        writes += 1;
        if (writes === failAt) throw new Error("injected second write failure");
        writeFileSync(path, text);
      },
    });
    const reviewer = store.save(input("reviewer"));
    const lead = store.save(input("lead", { supportsSubagents: true, allowedAgents: ["reviewer"] }));
    failAt = writes + 2;

    expect(() => store.save(input("critic"), "reviewer")).toThrow("injected second write failure");
    expect(store.get("reviewer")).toBeDefined();
    expect(store.get("critic")).toBeUndefined();
    expect(store.get("lead")?.allowedAgents).toEqual(["reviewer"]);
    expect(existsSync(reviewer.path!)).toBe(true);
    expect(existsSync(join(dirname(reviewer.path!), "critic.md"))).toBe(false);
    expect(readFileSync(lead.path!, "utf8")).toContain("- reviewer");

    failAt = Number.POSITIVE_INFINITY;
    writeFileSync(lead.path!, readFileSync(lead.path!, "utf8").replace("lead description", "read after failure"));
    await eventually(() => expect(store.get("lead")?.description).toBe("read after failure"));
  });

  it("requires a canonical trusted root exactly for project definitions", () => {
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    const store = createStore({ trustedProjects: () => [project] });
    expect(store.save(input("local", { scope: "project", projectCwd: join(project, ".", "nested", "..") }))).toMatchObject({ projectCwd: project });
    expect(store.validate(input("bad", { scope: "project", projectCwd: join(dir, "other") }))).toEqual([
      { field: "projectCwd", message: "Choose Trust in Settings before saving an agent in this project." },
    ]);
    expect(store.validate(input("bad", { scope: "global", projectCwd: project }))).toEqual([
      { field: "projectCwd", message: "A global agent does not belong to a project. Remove its project folder." },
    ]);
  });
});
