/**
 * AgentStore (docs/agents-leap). The rules a person feels directly: what is
 * seeded, what may be saved, what may be deleted and why not, and that the
 * file survives a restart without the built-ins ever being frozen into it.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, type AgentDefinitionInput, type AgentsSnapshot } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../src/agents/store.js";

const WORKSPACES = { beam: "/data/beam", chat: "/data/chat" };
let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-agents-`))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(options: Partial<ConstructorParameters<typeof AgentStore>[0]> = {}): AgentStore {
  return new AgentStore({ agentDir: join(dir, "agent"), workspaces: WORKSPACES, ...options });
}

function custom(name: string, patch: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    name,
    description: `${name} does one thing`,
    instructions: `You are ${name}.`,
    engineInstructions: false,
    model: null,
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
  it("seeds the editable default and the three built-ins, default first", () => {
    const s = store();
    const snapshot = s.snapshot();
    expect(snapshot.agents.map((a) => `${a.name}:${a.kind}`)).toEqual(["default:custom", "beam:builtin", "chat:builtin", "namer:builtin"]);
    expect(snapshot.defaultAgent).toBe("default");
    const def = snapshot.agents[0]!;
    expect(def).toMatchObject({ engineInstructions: true, instructions: "", supportsSubagents: true, allowedAgents: ["default"] });
    const beam = snapshot.agents.find((a) => a.name === "beam")!;
    expect(beam.scopedSkills).toBe(false);
    expect(beam.skills).toEqual([]);
    expect(beam.instructions).toContain(join(dir, "agent", "sessions"));
    expect(beam.instructions).not.toContain("skill");
    expect(snapshot.agents.find((a) => a.name === "chat")).toMatchObject({ supportsSubagents: false });
    expect(snapshot.agents.find((a) => a.name === "namer")?.instructions).toContain("name sessions");
    expect(snapshot.policy).toEqual({ maxDepth: 3, foregroundCommandSeconds: 120 });
    expect(snapshot.beam).toEqual({ model: null, suggested: null, needsChoice: true });
    expect(snapshot.namer).toEqual({ status: "unqualified", model: null, candidates: [] });
    expect(snapshot.builtinInstructions).toEqual({ beam: null, chat: null, namer: null });
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

  it("refuses the built-in names, on save and as another agent's child", () => {
    const s = store();
    for (const name of ["beam", "chat", "namer"]) {
      expect(issuesOf(() => s.save(custom(name)))).toEqual([{ field: "name", message: `"${name}" is a built-in agent and cannot be changed.` }]);
    }
    expect(issuesOf(() => s.save(custom("lead", { supportsSubagents: true, allowedAgents: ["beam"] })))).toEqual([
      { field: "allowedAgents[0]", message: '"beam" is a built-in agent and cannot be started by another agent.' },
    ]);
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
    expect(s.validate(custom("a", { model: { provider: "", id: "x" } }))).toEqual([{ field: "model", message: "Choose a model, or leave it empty to follow the default model." }]);
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
    expect(() => s.delete("default")).toThrow("This agent starts new sessions. Choose another default first.");
    expect(() => s.delete("beam")).toThrow('"beam" is a built-in agent and cannot be deleted.');
    expect(() => s.delete("nobody")).toThrow('There is no agent named "nobody".');
    expect(s.snapshot().agents).toHaveLength(4);
  });

  it("deletes the former default once another is chosen, pruning it from every child list", () => {
    const s = store();
    s.save(custom("lead", { supportsSubagents: true, allowedAgents: ["default", "lead"] }));
    s.setDefault("lead");
    expect(s.snapshot().defaultAgent).toBe("lead");
    s.delete("default");
    const lead = s.get("lead")!;
    expect(lead.allowedAgents).toEqual(["lead"]);
    expect(s.snapshot().agents.map((a) => a.name)).toEqual(["lead", "beam", "chat", "namer"]);
    expect(() => s.delete("lead")).toThrow("This agent starts new sessions. Choose another default first.");
  });

  it("only a custom agent can be the default", () => {
    const s = store();
    expect(() => s.setDefault("beam")).toThrow('"beam" is a built-in agent and cannot start project sessions.');
    expect(() => s.setDefault("ghost")).toThrow('There is no agent named "ghost".');
    const before = s.currentRevision;
    s.setDefault("default");
    expect(s.currentRevision).toBe(before); // unchanged is not a change
  });
});

describe("AgentStore · policy, Beam and Namer", () => {
  it("bounds the policy and reports the field", () => {
    const s = store();
    expect(s.setPolicy({ maxDepth: 2 })).toEqual({ maxDepth: 2, foregroundCommandSeconds: 120 });
    expect(issuesOf(() => s.setPolicy({ maxDepth: 9 }))).toEqual([{ field: "maxDepth", message: "Nesting depth is a whole number between 1 and 6." }]);
    expect(issuesOf(() => s.setPolicy({ foregroundCommandSeconds: 5 }))[0]?.field).toBe("foregroundCommandSeconds");
  });

  it("a Beam choice or dismissal closes the dialog; Namer follows the person or the benchmark", () => {
    const s = store();
    s.setBeamSuggestion({ provider: "openai", id: "gpt-5-mini" });
    expect(s.snapshot().beam).toEqual({ model: null, suggested: { provider: "openai", id: "gpt-5-mini" }, needsChoice: true });
    s.setBeamModel(null);
    expect(s.snapshot().beam.needsChoice).toBe(false);
    s.setBeamModel({ provider: "openai", id: "gpt-5-mini" });
    expect(s.get("beam")?.model).toEqual({ provider: "openai", id: "gpt-5-mini" });

    s.setBuiltinModel("beam", { provider: "openai", id: "gpt-5-mini" });
    expect(s.get("beam")?.model).toEqual({ provider: "openai", id: "gpt-5-mini" });

    s.setNamerModel({ provider: "google", id: "gemini-flash-lite" });
    expect(s.snapshot().namer).toMatchObject({ status: "ready", model: { provider: "google", id: "gemini-flash-lite" } });
    expect(s.get("namer")?.model).toEqual({ provider: "google", id: "gemini-flash-lite" });
    s.setNamerModel(null);
    expect(s.snapshot().namer).toMatchObject({ status: "unqualified", model: null });
    s.setNamerState({ status: "ready", model: { provider: "openai", id: "gpt-5-nano" }, candidates: [{ model: { provider: "openai", id: "gpt-5-nano" }, latencyMs: 300, valid: true }] });
    expect(s.snapshot().namer.candidates).toHaveLength(1);
  });

  it("edits and restores each built-in's effective instructions", () => {
    const s = store();
    for (const name of ["beam", "chat", "namer"] as const) {
      const shipped = s.get(name)!.instructions;
      s.setBuiltinInstructions(name, `Custom instructions for ${name}.`);
      expect(s.get(name)?.instructions).toBe(`Custom instructions for ${name}.`);
      expect(s.snapshot().builtinInstructions[name]).toBe(`Custom instructions for ${name}.`);
      s.setBuiltinInstructions(name, null);
      expect(s.get(name)?.instructions).toBe(shipped);
      expect(s.snapshot().builtinInstructions[name]).toBeNull();
    }
    expect(issuesOf(() => s.setBuiltinInstructions("beam", "   "))).toEqual([
      { field: "instructions", message: "Write instructions, or restore the built-in instructions." },
    ]);
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
  it("round-trips through the file without persisting the built-ins", () => {
    const file = join(dir, "state", "agents.json");
    const first = store({ storePath: file });
    first.save(custom("reviewer"));
    first.save(custom("lead", { supportsSubagents: true, allowedAgents: ["reviewer"] }));
    first.setDefault("lead");
    first.setPolicy({ maxDepth: 2 });
    first.setBuiltinModel("beam", { provider: "openai", id: "gpt-5-mini" });
    first.setBuiltinModel("chat", { provider: "anthropic", id: "claude-haiku" });
    first.setBuiltinModel("namer", { provider: "openai", id: "gpt-5-nano" });
    first.setBuiltinInstructions("beam", "Read first, then answer.");
    first.setBuiltinInstructions("chat", "Write with warmth.");
    first.setBuiltinInstructions("namer", "Prefer concrete nouns.");
    first.close();

    const stored = JSON.parse(readFileSync(file, "utf8")) as { version: number; revision: number; agents: Array<{ name: string }>; defaultAgent: string };
    expect(stored.version).toBe(1);
    expect(stored.agents.map((a) => a.name)).toEqual(["default", "reviewer", "lead"]);
    expect(stored.defaultAgent).toBe("lead");
    expect(JSON.stringify(stored)).not.toContain('"name": "beam"');

    const second = store({ storePath: file });
    const snapshot = second.snapshot();
    expect(snapshot.revision).toBe(stored.revision);
    expect(snapshot.agents.map((a) => a.name)).toEqual(["default", "reviewer", "lead", "beam", "chat", "namer"]);
    expect(snapshot.defaultAgent).toBe("lead");
    expect(snapshot.policy.maxDepth).toBe(2);
    expect(snapshot.beam).toEqual({ model: { provider: "openai", id: "gpt-5-mini" }, suggested: null, needsChoice: false });
    expect(snapshot.namer).toMatchObject({ status: "ready", model: { provider: "openai", id: "gpt-5-nano" } });
    expect(snapshot.chat).toEqual({ model: { provider: "anthropic", id: "claude-haiku" } });
    expect(snapshot.builtinInstructions).toEqual({ beam: "Read first, then answer.", chat: "Write with warmth.", namer: "Prefer concrete nouns." });
    expect(second.get("beam")?.model).toEqual({ provider: "openai", id: "gpt-5-mini" });
    // The choice reaches the definition the worker runs, not only the snapshot's state block.
    expect(second.get("chat")?.model).toEqual({ provider: "anthropic", id: "claude-haiku" });
    expect(second.get("namer")?.model).toEqual({ provider: "openai", id: "gpt-5-nano" });
    expect(second.get("beam")?.instructions).toBe("Read first, then answer.");
    expect(second.get("chat")?.instructions).toBe("Write with warmth.");
    expect(second.get("namer")?.instructions).toBe("Prefer concrete nouns.");
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
    first.delete("default");
    first.close();
    const second = store({ storePath: file });
    expect(second.snapshot().agents.map((a) => a.name)).toEqual(["lead", "beam", "chat", "namer"]);

    const broken = JSON.parse(readFileSync(file, "utf8")) as { defaultAgent: string };
    broken.defaultAgent = "vanished";
    writeFile(file, broken);
    const third = store({ storePath: file });
    expect(third.snapshot().defaultAgent).toBe("lead");
  });

  it("reads a file written before Chat had a model, and drops a chat value it cannot read", () => {
    const file = join(dir, "old-agents.json");
    // Exactly what an earlier release wrote: no `chat` key at all.
    writeFile(file, { version: 1, revision: 4, agents: [], defaultAgent: "default", beam: { model: null, suggested: null, needsChoice: false } });
    const old = store({ storePath: file });
    expect(old.snapshot().chat).toEqual({ model: null });
    expect(old.snapshot().builtinInstructions).toEqual({ beam: null, chat: null, namer: null });
    expect(old.get("chat")?.model).toBeNull();

    // Hand-edited nonsense is dropped, never thrown on: the store must still boot.
    for (const chat of [{ model: { provider: "openai" } }, { model: "gpt-5-mini" }, {}]) {
      const junk = join(dir, `junk-${JSON.stringify(chat).length}-agents.json`);
      writeFile(junk, { version: 1, revision: 1, agents: [], defaultAgent: "default", chat });
      expect(store({ storePath: junk }).snapshot().chat).toEqual({ model: null });
    }
    const wrongType = join(dir, "wrong-agents.json");
    writeFile(wrongType, { version: 1, revision: 1, agents: [], defaultAgent: "default", chat: "gpt-5-mini" });
    expect(store({ storePath: wrongType }).snapshot().chat).toEqual({ model: null });
  });

  it("starts from the seed on a corrupt file and recovers on the next write", () => {
    const file = join(dir, "agents.json");
    writeFile(file, "{ not json");
    const s = store({ storePath: file });
    expect(s.snapshot().agents.map((a) => a.name)).toEqual(["default", "beam", "chat", "namer"]);
    s.save(custom("reviewer"));
    s.close();
    expect(JSON.parse(readFileSync(file, "utf8")).agents.map((a: { name: string }) => a.name)).toEqual(["default", "reviewer"]);
  });
});

function writeFile(file: string, content: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
