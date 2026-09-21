/**
 * M22 review B1/B2 · what a person's machine still holds from before Model
 * Profiles, and what the one-way migration does with it
 * (`docs/model-profiles.md`, "Migration"; D-i, D-j, D-k, D-l).
 *
 * The store's half, against real files: the built-in model choices in
 * `agents.json`, the `model:` field in a global and in a project definition
 * file, the rewrite, and the fact that a second start finds nothing left to do.
 * The worker's half — which model becomes which profile — is proven in
 * `packages/worker/test/profiles/migrate.test.ts`; this file proves that the
 * choices are handed over, that the answer is applied, and that nothing is
 * claimed that did not happen.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_AGENTS_DIR_NAME, PRODUCT_NAME, PROJECT_AGENTS_DIR } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../src/agents/store.js";

const BEAM_PROFILE = "mp_testbeamprofile000000";
const REVIEWER_PROFILE = "mp_testreviewerprofile00";
const WRITER_PROFILE = "mp_testwriterprofile0000";

let dir: string;
let stateDir: string;
let projectCwd: string;
let stores: AgentStore[];

const workspaces = { beam: "/workspaces/beam", chat: "/workspaces/chat" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-legacy-models-`));
  stateDir = join(dir, "state");
  projectCwd = join(dir, "project");
  mkdirSync(join(stateDir, GLOBAL_AGENTS_DIR_NAME), { recursive: true });
  mkdirSync(join(projectCwd, PROJECT_AGENTS_DIR), { recursive: true });
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function createStore(): AgentStore {
  const store = new AgentStore({
    storePath: join(stateDir, "agents.json"),
    stateDir,
    agentDir: join(dir, "engine"),
    workspaces,
    trustedProjects: () => [projectCwd],
    watchDebounceMs: 25,
    watchPollMs: 25,
  });
  stores.push(store);
  return store;
}

/** An `agents.json` as the generation before Model Profiles wrote it. */
function writeLegacyMetadata(): void {
  writeFileSync(
    join(stateDir, "agents.json"),
    JSON.stringify({
      version: 2,
      revision: 4,
      defaultAgent: "default",
      policy: { maxDepth: 3, foregroundCommandSeconds: 60 },
      namer: { status: "ready", model: { provider: "openai", id: "gpt-5-nano" }, candidates: [] },
      beam: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, suggested: null, needsChoice: false },
      chat: { model: null },
      builtinInstructions: { beam: null, chat: null, namer: null },
      renamedAgents: {},
    }, null, 2),
  );
}

/** A definition file as it was written before `profile:` existed. */
function writeLegacyDefinition(path: string, name: string, model: string): void {
  writeFileSync(
    path,
    `---\ndescription: ${name} description\nmodel: ${model}\nthinkingLevel: null\nsupportsSubagents: false\nallowedAgents: []\nscopedSkills: false\nskills: []\nengineInstructions: false\nexcludeCoreInstructions: false\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nAct as ${name}.\n`,
  );
}

const globalPath = (name: string) => join(stateDir, GLOBAL_AGENTS_DIR_NAME, `${name}.md`);
const projectPath = (name: string) => join(projectCwd, PROJECT_AGENTS_DIR, `${name}.md`);
const metadata = () => JSON.parse(readFileSync(join(stateDir, "agents.json"), "utf8")) as Record<string, unknown>;

describe("definition files written before Model Profiles", () => {
  it("still load, and say on the profile field that they name a model", () => {
    writeLegacyDefinition(globalPath("reviewer"), "reviewer", "anthropic/claude-opus-4");
    const store = createStore();

    const reviewer = store.get("reviewer");
    expect(reviewer?.description).toBe("reviewer description");
    expect(reviewer?.instructions).toBe("Act as reviewer.\n");
    // Nothing is inherited from the old field: the agent runs on the profile
    // new conversations use until the migration rewrites it.
    expect(reviewer?.profileId).toBeNull();
    expect(store.warnings()).toEqual([
      expect.objectContaining({
        agentName: "reviewer",
        field: "profile",
        path: globalPath("reviewer"),
        target: "anthropic/claude-opus-4",
        message: expect.stringContaining("anthropic/claude-opus-4"),
      }),
    ]);
  });

  it("offers every pre-M22 choice to the migration, global, project and built-in alike", () => {
    writeLegacyMetadata();
    writeLegacyDefinition(globalPath("reviewer"), "reviewer", "anthropic/claude-opus-4");
    writeLegacyDefinition(projectPath("writer"), "writer", "openai/gpt-5-mini");
    const store = createStore();

    expect(store.legacyModelChoices()).toEqual(
      expect.arrayContaining([
        { key: "builtin:beam", label: "Beam", model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
        { key: "builtin:namer", label: "Namer", model: { provider: "openai", id: "gpt-5-nano" } },
        { key: globalPath("reviewer"), label: "reviewer", model: { provider: "anthropic", id: "claude-opus-4" } },
        { key: projectPath("writer"), label: "writer", model: { provider: "openai", id: "gpt-5-mini" } },
      ]),
    );
    // Chat never chose a model, so it has nothing to migrate and is not listed.
    expect(store.legacyModelChoices().some((choice) => choice.key === "builtin:chat")).toBe(false);
  });

  it("rewrites each file once, moves the built-ins, and finds nothing left on the next start", () => {
    writeLegacyMetadata();
    writeLegacyDefinition(globalPath("reviewer"), "reviewer", "anthropic/claude-opus-4");
    writeLegacyDefinition(projectPath("writer"), "writer", "openai/gpt-5-mini");
    const store = createStore();

    const applied = store.applyLegacyModelMigration({
      "builtin:beam": BEAM_PROFILE,
      [globalPath("reviewer")]: REVIEWER_PROFILE,
      [projectPath("writer")]: WRITER_PROFILE,
    });

    // Real before and after, and only what was actually converted: Namer was
    // offered a profile nobody resolved, so it is not in this list.
    expect(applied.builtins).toEqual([{ name: "beam", from: "anthropic/claude-sonnet-4-5", to: BEAM_PROFILE }]);
    expect(applied.agentFiles).toEqual([
      { path: globalPath("reviewer"), from: "anthropic/claude-opus-4", to: REVIEWER_PROFILE },
      { path: projectPath("writer"), from: "openai/gpt-5-mini", to: WRITER_PROFILE },
    ]);
    expect(store.builtinProfileIds).toEqual({ beam: BEAM_PROFILE, chat: null, namer: null });

    // The files themselves: the field changed, the instructions did not.
    const rewritten = readFileSync(globalPath("reviewer"), "utf8");
    expect(rewritten).toContain(`profile: ${REVIEWER_PROFILE}`);
    expect(rewritten).not.toContain("model:");
    expect(rewritten.endsWith("Act as reviewer.\n")).toBe(true);
    expect(readFileSync(projectPath("writer"), "utf8")).toContain(`profile: ${WRITER_PROFILE}`);

    // They load as profiles now, with nothing left to warn about.
    expect(store.get("reviewer")?.profileId).toBe(REVIEWER_PROFILE);
    expect(store.get("writer", projectCwd)?.profileId).toBe(WRITER_PROFILE);
    expect(store.warnings()).toEqual([]);

    // And a second start has nothing left to offer for what was converted, and
    // rewrites nothing: only Namer, whose choice nobody resolved, is still
    // waiting for a profile.
    store.close();
    const next = createStore();
    expect(next.legacyModelChoices()).toEqual([
      { key: "builtin:namer", label: "Namer", model: { provider: "openai", id: "gpt-5-nano" } },
    ]);
    expect(next.applyLegacyModelMigration({ "builtin:beam": BEAM_PROFILE })).toEqual({ builtins: [], agentFiles: [] });
    expect(next.get("reviewer")?.profileId).toBe(REVIEWER_PROFILE);
    expect(readFileSync(globalPath("reviewer"), "utf8")).toBe(rewritten);
  });

  it("never overrules a built-in profile a person already chose", () => {
    writeLegacyMetadata();
    const store = createStore();
    store.setBuiltinProfile("beam", REVIEWER_PROFILE);

    expect(store.legacyModelChoices().some((choice) => choice.key === "builtin:beam")).toBe(false);
    expect(store.applyLegacyModelMigration({ "builtin:beam": BEAM_PROFILE }).builtins).toEqual([]);
    expect(store.builtinProfileIds.beam).toBe(REVIEWER_PROFILE);
  });

  it("keeps the old keys in place for one release, through every metadata write", () => {
    writeLegacyMetadata();
    const store = createStore();
    store.setBuiltinProfile("chat", BEAM_PROFILE);
    store.close();

    // Rolling the app back must find its own state exactly as it left it
    // (D-346): the metadata this version writes carries the old blobs through.
    const stored = metadata();
    expect(stored.beam).toEqual({ model: { provider: "anthropic", id: "claude-sonnet-4-5" }, suggested: null, needsChoice: false });
    expect(stored.namer).toMatchObject({ model: { provider: "openai", id: "gpt-5-nano" } });
    expect(stored.builtinProfiles).toEqual({ beam: null, chat: BEAM_PROFILE, namer: null });
  });

  it("leaves a file it could not rewrite exactly as the person wrote it", () => {
    writeLegacyDefinition(globalPath("reviewer"), "reviewer", "anthropic/claude-opus-4");
    const before = readFileSync(globalPath("reviewer"), "utf8");
    const store = new AgentStore({
      storePath: join(stateDir, "agents.json"),
      stateDir,
      agentDir: join(dir, "engine"),
      workspaces,
      writeFile: () => { throw new Error("disk is full"); },
    });
    stores.push(store);

    expect(store.applyLegacyModelMigration({ [globalPath("reviewer")]: REVIEWER_PROFILE })).toEqual({ builtins: [], agentFiles: [] });
    expect(readFileSync(globalPath("reviewer"), "utf8")).toBe(before);
    // Still offered, so the next start tries again rather than losing it.
    expect(store.legacyModelChoices()).toEqual([
      { key: globalPath("reviewer"), label: "reviewer", model: { provider: "anthropic", id: "claude-opus-4" } },
    ]);
    expect(existsSync(globalPath("reviewer"))).toBe(true);
  });
});
