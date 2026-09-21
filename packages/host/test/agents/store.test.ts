/**
 * AgentStore (docs/agents-leap). The rules a person feels directly: what is
 * seeded, what may be saved, what may be deleted and why not, and that the
 * file survives a restart without the built-ins ever being frozen into it.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, type AgentDefinitionInput, type AgentsSnapshot } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../src/agents/store.js";

const WORKSPACES = { chat: "/data/chat" };
let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-agents-`))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(options: Partial<ConstructorParameters<typeof AgentStore>[0]> = {}): AgentStore {
  return new AgentStore({ agentDir: join(dir, "agent"), workspaces: WORKSPACES, ...options });
}

function custom(name: string, patch: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    name,
    scope: "global",
    description: `${name} does one thing`,
    instructions: `You are ${name}.`,
    engineInstructions: false,
    excludeCoreInstructions: false,
    profileId: null,
    thinkingLevel: null,
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    ...patch,
  };
}

const issuesOf = (fn: () => unknown): Array<{ field: string; message: string }> => {
  try {
    fn();
  } catch (error) {
    return (error as { data?: { issues?: Array<{ field: string; message: string }> } }).data?.issues ?? [];
  }
  throw new Error("expected a refusal");
};

describe("AgentStore · seeding", () => {
  it("seeds the editable default and nothing else: there are no built-in agents", () => {
    const s = store();
    const snapshot = s.snapshot();
    expect(snapshot.agents.map((a) => `${a.name}:${a.kind}`)).toEqual(["default:custom"]);
    expect(snapshot.defaultAgent).toBe("default");
    const def = snapshot.agents[0]!;
    expect(def).toMatchObject({ scope: "global", engineInstructions: true, excludeCoreInstructions: false, instructions: "", supportsSubagents: true, allowedAgents: ["default"] });
    // Nothing synthesises the three names that were built-in agents (D-347).
    for (const name of ["beam", "chat", "namer"]) expect(s.get(name)).toBeUndefined();
    expect(snapshot.policy).toEqual({ maxDepth: 3, foregroundCommandSeconds: 120 });
    expect(snapshot).not.toHaveProperty("builtinProfiles");
    expect(snapshot).not.toHaveProperty("builtinInstructions");
    expect(snapshot.workspaces).toEqual(WORKSPACES);
    expect(snapshot.warnings).toEqual([]);
  });
});

describe("AgentStore · save and validate", () => {
  it("creates, then updates keeping createdAt and bumping updatedAt and the revision", () => {
    let tick = 0;
    const changes: AgentsSnapshot[] = [];
    const s = store({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)), onChange: (snapshot) => changes.push(snapshot) });
    const created = s.save(custom("reviewer"));
    expect(created).toMatchObject({ name: "reviewer", kind: "custom" });
    expect(s.currentRevision).toBe(1);
    const updated = s.save(custom("reviewer", { description: "reviews harder" }), "reviewer");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(s.currentRevision).toBe(2);
    expect(changes).toHaveLength(2);
    expect(changes[1]!.agents.find((a) => a.name === "reviewer")?.description).toBe("reviews harder");
  });

  it("renames atomically, updates references, and reserves the historical name", () => {
    const s = store();
    s.save(custom("worker", { supportsSubagents: true, allowedAgents: ["worker"] }));
    s.save(custom("lead", { supportsSubagents: true, allowedAgents: ["worker"] }));
    s.setDefault("worker");
    const renamed = s.save(custom("implementer", { supportsSubagents: true, allowedAgents: ["worker"] }), "worker");
    expect(renamed).toMatchObject({ name: "implementer", allowedAgents: ["implementer"] });
    expect(s.snapshot()).toMatchObject({
      defaultAgent: "implementer",
      renamedAgents: { worker: "implementer" },
      agents: expect.arrayContaining([expect.objectContaining({ name: "lead", allowedAgents: ["implementer"] })]),
    });
    expect(issuesOf(() => s.save(custom("lead"), "implementer"))).toEqual([
      { field: "name", message: 'An agent named "lead" already exists.' },
    ]);
    expect(issuesOf(() => s.save(custom("worker")))).toEqual([
      { field: "name", message: 'An agent named "worker" already exists.' },
    ]);
  });

  it("keeps the retired names reserved, and drops one listed as a child instead of refusing", () => {
    const s = store();
    for (const name of ["beam", "chat", "namer"]) {
      expect(issuesOf(() => s.save(custom(name)))).toEqual([{ field: "name", message: `"${name}" is a reserved name. Choose another name.` }]);
    }
    // A definition a person wrote before M23 keeps working: the name is
    // dropped, never refused (`docs/plain-chat.md`, "Migration").
    const lead = s.save(custom("lead", { supportsSubagents: true, allowedAgents: ["beam", "lead"] }));
    expect(lead.allowedAgents).toEqual(["lead"]);
  });

  it("validates every field and names it", () => {
    const s = store();
    expect(s.validate(custom("Bad Name"))).toEqual([
      { field: "name", message: "Names are lower case, start with a letter and use only letters, digits and hyphens (at most 40 characters)." },
    ]);
    expect(s.validate(custom("a", { description: "x".repeat(301) }))).toEqual([
      { field: "description", message: "Keep the description to 300 characters; other agents read it to decide when to start this one." },
    ]);
    expect(s.validate(custom("a", { instructions: "  " }))).toEqual([
      { field: "instructions", message: `Write instructions, or use ${PRODUCT_DISPLAY_NAME}'s default instructions.` },
    ]);
    expect(s.validate(custom("a", { instructions: "", engineInstructions: true }))).toEqual([]);
    expect(s.validate(custom("a", { instructions: "Use {{madeUp}}." }))).toEqual([
      { field: "instructions", message: "“madeUp” is not available here. Remove it and choose a field from Insert field." },
    ]);
    expect(s.validate(custom("a", { instructions: "Use {{workingDirectory}}." }))).toEqual([]);
    expect(s.validate(custom("a", { allowedAgents: ["default"] }))).toEqual([
      { field: "allowedAgents", message: "This agent does not start other agents, so it cannot list any." },
    ]);
    expect(s.validate(custom("a", { supportsSubagents: true, allowedAgents: ["ghost", "default", "default", "a"] }))).toEqual([
      { field: "allowedAgents[0]", message: 'There is no agent named "ghost".' },
      { field: "allowedAgents[2]", message: '"default" is listed twice.' },
    ]);
    expect(s.validate(custom("a", { scopedSkills: true }))).toEqual([
      { field: "skills", message: "Choose at least one skill, or turn off scoped skills to offer every discovered skill." },
    ]);
    const skill = { name: "review", path: "/skills/review/SKILL.md", scope: "global" as const };
    expect(s.validate(custom("a", { scopedSkills: true, skills: [skill, skill] }))).toEqual([{ field: "skills[1]", message: '"review" is listed twice.' }]);
    expect(s.validate(custom("a", { profileId: "Balanced" }))).toEqual([{ field: "profile", message: "Choose one of your model profiles, or leave it empty to follow the default." }]);
  });

  it("lets the seeded default be edited but never a second one be created", () => {
    const s = store();
    const edited = s.save(custom("default", { engineInstructions: false, instructions: "Be terse.", supportsSubagents: true, allowedAgents: ["default"] }), "default");
    expect(edited.instructions).toBe("Be terse.");
    expect(s.snapshot().agents.filter((a) => a.name === "default")).toHaveLength(1);
  });
});

describe("AgentStore · delete and default", () => {
  it("refuses to delete the default with the exact message, and the built-ins", () => {
    const s = store();
    expect(() => s.delete("default", { scope: "global" })).toThrow("This agent starts new sessions. Choose another default first.");
    expect(() => s.delete("beam", { scope: "global" })).toThrow('There is no agent named "beam".');
    expect(() => s.delete("nobody", { scope: "global" })).toThrow('There is no agent named "nobody" in this scope.');
    expect(s.snapshot().agents).toHaveLength(1);
  });

  it("deletes the former default once another is chosen, pruning it from every child list", () => {
    const s = store();
    s.save(custom("lead", { supportsSubagents: true, allowedAgents: ["default", "lead"] }));
    s.setDefault("lead");
    expect(s.snapshot().defaultAgent).toBe("lead");
    s.delete("default", { scope: "global" });
    const lead = s.get("lead")!;
    expect(lead.allowedAgents).toEqual(["lead"]);
    expect(s.snapshot().agents.map((a) => a.name)).toEqual(["lead"]);
    expect(() => s.delete("lead", { scope: "global" })).toThrow("This agent starts new sessions. Choose another default first.");
  });

  it("deletes only the exact source when Global and Project names collide", () => {
    const projectCwd = join(dir, "project");
    mkdirSync(projectCwd, { recursive: true });
    const s = store({ trustedProjects: () => [projectCwd] });
    s.save(custom("reviewer"));
    s.save(custom("reviewer", { scope: "project", projectCwd, description: "project reviewer" }));

    s.delete("reviewer", { scope: "global" });
    expect(s.snapshot().agents.filter((agent) => agent.name === "reviewer")).toEqual([
      expect.objectContaining({ scope: "project", projectCwd, description: "project reviewer" }),
    ]);
    expect(() => s.delete("reviewer", { scope: "global" })).toThrow('There is no agent named "reviewer" in this scope.');

    s.delete("reviewer", { scope: "project", projectCwd });
    expect(s.snapshot().agents.some((agent) => agent.name === "reviewer")).toBe(false);
  });

  it("prunes references only when the deleted exact source has no remaining effective target", () => {
    const projectCwd = join(dir, "project");
    mkdirSync(projectCwd, { recursive: true });
    let writes = 0;
    const s = store({
      storePath: join(dir, "state", "agents.json"),
      trustedProjects: () => [projectCwd],
      writeFile: (path, text) => {
        writes += 1;
        writeFileSync(path, text, "utf8");
      },
    });
    s.save(custom("reviewer"));
    s.save(custom("reviewer", { scope: "project", projectCwd, description: "Project shadow" }));
    s.save(custom("global-lead", { supportsSubagents: true, allowedAgents: ["reviewer"] }));
    s.save(custom("project-lead", {
      scope: "project",
      projectCwd,
      supportsSubagents: true,
      allowedAgents: ["reviewer"],
    }));

    writes = 0;
    s.delete("reviewer", { scope: "project", projectCwd });
    expect(s.get("global-lead")?.allowedAgents).toEqual(["reviewer"]);
    expect(s.get("project-lead", projectCwd)?.allowedAgents).toEqual(["reviewer"]);
    expect(writes).toBe(0);

    s.save(custom("reviewer", { scope: "project", projectCwd, description: "Project shadow" }));
    writes = 0;
    s.delete("reviewer", { scope: "global" });
    expect(s.get("global-lead")?.allowedAgents).toEqual([]);
    expect(s.get("project-lead", projectCwd)?.allowedAgents).toEqual(["reviewer"]);
    expect(writes).toBe(1);
  });

  it("only an agent that exists can be the default", () => {
    const s = store();
    expect(() => s.setDefault("beam")).toThrow('There is no agent named "beam".');
    expect(() => s.setDefault("ghost")).toThrow('There is no agent named "ghost".');
    const before = s.currentRevision;
    s.setDefault("default");
    expect(s.currentRevision).toBe(before); // unchanged is not a change
  });
});

describe("AgentStore · policy", () => {
  it("bounds the policy and reports the field", () => {
    const s = store();
    expect(s.setPolicy({ maxDepth: 2 })).toEqual({ maxDepth: 2, foregroundCommandSeconds: 120 });
    expect(issuesOf(() => s.setPolicy({ maxDepth: 9 }))).toEqual([{ field: "maxDepth", message: "Nesting depth is a whole number between 1 and 6." }]);
    expect(issuesOf(() => s.setPolicy({ foregroundCommandSeconds: 5 }))[0]?.field).toBe("foregroundCommandSeconds");
  });

  it("warnings count as a change only when they differ", () => {
    const s = store();
    const before = s.currentRevision;
    s.setWarnings([{ agentName: "default", field: "skills", target: "x", message: "gone", since: "2026-01-01T00:00:00.000Z" }]);
    expect(s.currentRevision).toBe(before + 1);
    s.setWarnings([{ agentName: "default", field: "skills", target: "x", message: "gone", since: "2026-01-01T00:00:00.000Z" }]);
    expect(s.currentRevision).toBe(before + 1);
    s.setWarnings([]);
    expect(s.currentRevision).toBe(before + 2);
    expect(s.warnings()).toEqual([]);
  });
});

describe("AgentStore · persistence", () => {
  it("round-trips through the file, and nothing built-in is ever in it", () => {
    const file = join(dir, "state", "agents.json");
    const first = store({ storePath: file });
    first.save(custom("reviewer"));
    first.save(custom("lead", { supportsSubagents: true, allowedAgents: ["reviewer"] }));
    first.setDefault("lead");
    first.setPolicy({ maxDepth: 2 });
    first.close();

    const stored = JSON.parse(readFileSync(file, "utf8")) as { version: number; revision: number; defaultAgent: string; agents?: unknown };
    expect(stored.version).toBe(2);
    expect(stored.agents).toBeUndefined();
    expect(stored.defaultAgent).toBe("lead");
    expect(readdirSync(join(dir, "state", "agents")).sort()).toEqual(["default.md", "lead.md", "reviewer.md"]);
    expect(readFileSync(join(dir, "state", "agents", "reviewer.md"), "utf8")).toContain("You are reviewer.");
    expect(JSON.stringify(stored)).not.toContain('"name": "beam"');

    const second = store({ storePath: file });
    const snapshot = second.snapshot();
    expect(snapshot.revision).toBe(stored.revision);
    expect(snapshot.agents.map((a) => a.name)).toEqual(["default", "lead", "reviewer"]);
    expect(snapshot.defaultAgent).toBe("lead");
    expect(snapshot.policy.maxDepth).toBe(2);
  });

  it("keeps the retired built-ins' stored choices byte-for-byte for one release", () => {
    // Nothing runs on them any more, but rolling the app back must find them
    // exactly as it left them (D-346, D-347).
    const file = join(dir, "state", "agents.json");
    writeFile(file, {
      version: 2,
      revision: 3,
      defaultAgent: "default",
      policy: { maxDepth: 3, foregroundCommandSeconds: 120 },
      builtinProfiles: { beam: "mp_testbeam0000000000000", chat: "mp_testchat0000000000000", namer: "mp_testnamer000000000000" },
      builtinInstructions: { beam: "Read first, then answer.", chat: "Write with warmth.", namer: "Name {{toolName}} from {{namingTask}}." },
      renamedAgents: {},
    });
    const s = store({ storePath: file });
    // The person's naming choice is the one thing that is read back out.
    expect(s.retiredNamingProfileId).toBe("mp_testnamer000000000000");
    expect(s.snapshot().agents.map((a) => a.name)).toEqual(["default"]);
    s.save(custom("reviewer"));
    s.close();
    const written = JSON.parse(readFileSync(file, "utf8")) as { builtinProfiles: Record<string, string | null>; builtinInstructions: Record<string, string | null> };
    expect(written.builtinProfiles).toEqual({ beam: "mp_testbeam0000000000000", chat: "mp_testchat0000000000000", namer: "mp_testnamer000000000000" });
    // Even an override naming fields this version removed is kept verbatim.
    expect(written.builtinInstructions.namer).toBe("Name {{toolName}} from {{namingTask}}.");
  });

  it("persists rename aliases for sessions written under the old name", () => {
    const file = join(dir, "state", "agents.json");
    const first = store({ storePath: file });
    first.save(custom("worker"));
    first.save(custom("implementer"), "worker");
    first.close();
    expect(store({ storePath: file }).snapshot().renamedAgents).toEqual({ worker: "implementer" });
  });

  it("does not re-seed a deleted default, and repairs a default that names nobody", () => {
    const file = join(dir, "agents.json");
    const first = store({ storePath: file });
    first.save(custom("lead"));
    first.setDefault("lead");
    first.delete("default", { scope: "global" });
    first.close();
    const second = store({ storePath: file });
    expect(second.snapshot().agents.map((a) => a.name)).toEqual(["lead"]);

    const broken = JSON.parse(readFileSync(file, "utf8")) as { defaultAgent: string };
    broken.defaultAgent = "vanished";
    writeFile(file, broken);
    const third = store({ storePath: file });
    expect(third.snapshot().defaultAgent).toBe("lead");
  });

  it("reads a file written before profiles existed, and drops a value it cannot read", () => {
    const file = join(dir, "old-agents.json");
    // Exactly what an earlier release wrote: model choices, no profiles.
    writeFile(file, { version: 1, revision: 4, agents: [], defaultAgent: "default", beam: { model: { provider: "openai", id: "gpt-5-mini" }, suggested: null, needsChoice: false } });
    const old = store({ storePath: file });
    // A raw model is never adopted as a profile; the migration maps it.
    expect(old.retiredNamingProfileId).toBeNull();
    expect(old.snapshot().agents.map((a) => a.name)).toEqual(["default"]);

    // Hand-edited nonsense is dropped, never thrown on: the store must still boot.
    for (const builtinProfiles of [{ namer: { provider: "openai" } }, { namer: "Balanced" }, {}]) {
      const junk = join(dir, `junk-${JSON.stringify(builtinProfiles).length}-agents.json`);
      writeFile(junk, { version: 1, revision: 1, agents: [], defaultAgent: "default", builtinProfiles });
      expect(store({ storePath: junk }).retiredNamingProfileId).toBeNull();
    }
    const wrongType = join(dir, "wrong-agents.json");
    writeFile(wrongType, { version: 1, revision: 1, agents: [], defaultAgent: "default", builtinProfiles: "Balanced" });
    expect(store({ storePath: wrongType }).retiredNamingProfileId).toBeNull();
  });

  it("starts from the seed on a corrupt file and recovers on the next write", () => {
    const file = join(dir, "agents.json");
    writeFile(file, "{ not json");
    const s = store({ storePath: file });
    expect(s.snapshot().agents.map((a) => a.name)).toEqual(["default"]);
    s.save(custom("reviewer"));
    s.close();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 2 });
    expect(readdirSync(join(dir, "agents")).sort()).toEqual(["default.md", "reviewer.md"]);
  });
});

function writeFile(file: string, content: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
