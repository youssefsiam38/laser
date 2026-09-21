/**
 * Durable agent definitions: metadata in agents.json, one Markdown file per
 * custom agent, and live watches for global and trusted-project locations.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENT_MAX_DEPTH_DEFAULT,
  AGENT_MAX_DEPTH_LIMIT,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_PATTERN,
  BUILTIN_AGENT_NAMES,
  DEFAULT_AGENT_NAME,
  ErrorCodes,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  FOREGROUND_COMMAND_SECONDS_MAX,
  FOREGROUND_COMMAND_SECONDS_MIN,
  GLOBAL_AGENTS_DIR_NAME,
  PROJECT_AGENTS_DIR,
  ProtocolError,
  effectiveAgents,
  instructionTemplateIssue,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
  type AgentLocation,
  isModelProfileId,
  PROFILE_NAME_MAX,
  type AgentPolicy,
  type AgentWarning,
  type AgentsSnapshot,
  type BuiltinAgentName,
  type BuiltinInstructionOverrides,
  type BuiltinProfiles,
  type LegacyModelChoice,
  type ModelIdentity,
} from "@lasercode/protocol";
import { serializeAgentFile } from "./agent-file.js";
import {
  AgentFilesWatch,
  agentFileDigest,
  type AgentFileLocation,
} from "./agent-files-watch.js";
import { builtinAgents, seedDefaultAgent } from "./builtins.js";
import { validateAgentInput } from "./validate.js";
import { canonical } from "../trust.js";

export interface AgentStoreOptions {
  /** Metadata file. Absent keeps the store memory-only (unit tests). */
  storePath?: string;
  agentDir: string;
  stateDir?: string;
  workspaces: { beam: string; chat: string };
  /** Canonical roots currently listed as trusted by ProjectRegistry. */
  trustedProjects?: () => readonly string[];
  onChange?: (snapshot: AgentsSnapshot) => void;
  log?: (line: string) => void;
  now?: () => Date;
  watchDebounceMs?: number;
  watchPollMs?: number;
  /** Injectable write primitive for failure-path tests. */
  writeFile?: (path: string, text: string) => void;
}

interface StoredV1 {
  version: 1;
  revision: number;
  agents: unknown[];
  defaultAgent: string;
  policy: AgentPolicy;
  builtinProfiles: BuiltinProfiles;
  builtinInstructions: BuiltinInstructionOverrides;
  renamedAgents: Readonly<Record<string, string>>;
}

interface StoredV2 extends Omit<StoredV1, "version" | "agents"> {
  version: 2;
}

/**
 * The built-in model choices the previous generation wrote (`beam`, `chat`,
 * `namer`, each with a `model`). They are read by the one-way migration and
 * written back untouched for one release, so rolling the app back finds them
 * exactly as it left them (D-346).
 */
type LegacyBuiltinState = Partial<Record<BuiltinAgentName, unknown>>;

type Stored = Partial<Omit<StoredV1, "version"> & { version: 1 | 2 }> & LegacyBuiltinState;
type Location = AgentFileLocation;

const DELETE_DEFAULT_MESSAGE = "This agent starts new sessions. Choose another default first.";
const BUILTIN_STAMP = "1970-01-01T00:00:00.000Z";

export class AgentStore {
  private readonly custom = new Map<string, AgentDefinition>();
  private defaultAgent = DEFAULT_AGENT_NAME;
  private policy: AgentPolicy = { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
  private builtinProfiles: BuiltinProfiles = { beam: null, chat: null, namer: null };
  private builtinInstructions: BuiltinInstructionOverrides = { beam: null, chat: null, namer: null };
  private renamedAgents: Readonly<Record<string, string>> = {};
  private skillWarnings: AgentWarning[] = [];
  private readonly fileWarnings = new Map<string, AgentWarning>();
  /** Definition files that still name a model, by path (`docs/model-profiles.md`). */
  private readonly legacyModels = new Map<string, ModelIdentity>();
  /** The built-ins' pre-M22 model choices, kept verbatim for one release (D-346). */
  private legacyBuiltins: LegacyBuiltinState = {};
  private readonly digests = new Map<string, string>();
  private trustedProjects = new Set<string>();
  private revision = 0;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => Date;
  private migrationBlocked = false;
  private tmpCounter = 0;
  private readonly files: AgentFilesWatch;

  constructor(private readonly options: AgentStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.trustedProjects = new Set((options.trustedProjects?.() ?? []).map(canonical));
    this.files = new AgentFilesWatch({
      globalDirectory: () => this.globalAgentsDir(),
      projectDirectory: (projectCwd) => this.projectAgentsDir(projectCwd),
      trustedProjects: () => this.trustedProjects,
      globalReconciliationBlocked: () => this.migrationBlocked,
      definitions: () => this.custom.values(),
      definition: (location, name) => this.custom.get(keyOf(location, name)),
      replaceDefinition: (location, definition) => this.custom.set(keyOf(location, definition.name), definition),
      removeDefinition: (definition) => this.removeDefinition(definition, true),
      digest: (path) => this.digests.get(path),
      setDigest: (path, digest) => digest === undefined ? this.digests.delete(path) : void this.digests.set(path, digest),
      warning: (path) => this.fileWarnings.get(path),
      warningPaths: () => this.fileWarnings.keys(),
      setWarning: (path, warning) => warning === undefined ? this.fileWarnings.delete(path) : void this.fileWarnings.set(path, warning),
      setLegacyModel: (path, model) => model === undefined ? void this.legacyModels.delete(path) : void this.legacyModels.set(path, model),
      commit: () => this.commit(),
      now: () => this.now(),
      log: (line) => this.log(line),
      ...(options.watchDebounceMs !== undefined ? { debounceMs: options.watchDebounceMs } : {}),
      ...(options.watchPollMs !== undefined ? { pollMs: options.watchPollMs } : {}),
    });
    this.load();
    if (options.storePath) this.files.start();
  }

  get currentRevision(): number {
    return this.revision;
  }

  snapshot(): AgentsSnapshot {
    return structuredClone({
      revision: this.revision,
      agents: [...this.custom.values(), ...this.builtins()],
      defaultAgent: this.defaultAgent,
      warnings: [...this.skillWarnings, ...this.fileWarnings.values()],
      policy: this.policy,
      builtinProfiles: this.builtinProfiles,
      builtinInstructions: this.builtinInstructions,
      renamedAgents: this.renamedAgents,
      workspaces: this.options.workspaces,
    });
  }

  /** Without a cwd, the global definition wins. With one, its project definition wins. */
  get(name: string, projectCwd?: string): AgentDefinition | undefined {
    if (projectCwd) {
      const project = this.custom.get(keyOf({ scope: "project", projectCwd: canonical(projectCwd) }, name));
      if (project) return structuredClone(project);
    }
    const global = this.custom.get(keyOf({ scope: "global" }, name));
    if (global) return structuredClone(global);
    return this.builtins().find((agent) => agent.name === name);
  }

  get defaultAgentName(): string {
    return this.defaultAgent;
  }

  get workspaces(): { beam: string; chat: string } {
    return { ...this.options.workspaces };
  }

  warnings(): AgentWarning[] {
    return structuredClone([...this.skillWarnings, ...this.fileWarnings.values()]);
  }

  validate(input: AgentDefinitionInput, originalName: string | null = null): AgentIssue[] {
    const normalized = normalizeInput(input);
    const original = originalName === null ? undefined : this.custom.get(keyOf(locationOfInput(normalized), originalName));
    return validateAgentInput(normalized, {
      existing: [...this.custom.values(), ...this.builtins()],
      ...(original ? { original } : {}),
      originalName,
      renamedAgents: this.renamedAgents,
      trustedProjectCwds: this.trustedProjects,
    });
  }

  save(input: AgentDefinitionInput, originalName: string | null = null): AgentDefinition {
    const normalized = normalizeInput(input);
    const location = locationOfInput(normalized);
    if (originalName !== null && isBuiltinAgentName(originalName)) {
      throw invalid([{ field: "name", message: `"${originalName}" is a built-in agent and cannot be changed.` }]);
    }
    const originalKey = originalName === null ? undefined : keyOf(location, originalName);
    const existing = originalKey ? this.custom.get(originalKey) : undefined;
    if (originalName !== null && !existing) {
      throw invalid([{ field: "name", message: `There is no agent named "${originalName}" in this scope.` }]);
    }
    if (isBuiltinAgentName(normalized.name)) {
      throw invalid([{ field: "name", message: `"${normalized.name}" is a built-in agent and cannot be changed.` }]);
    }
    const renaming = originalName !== null && originalName !== normalized.name;
    if (renaming) {
      normalized.allowedAgents = normalized.allowedAgents.map((name) => (name === originalName ? normalized.name : name));
    }
    const issues = this.validate(normalized, originalName);
    if (issues.length > 0) throw invalid(issues);

    const at = this.now().toISOString();
    const path = this.definitionPath(location, normalized.name);
    const agent: AgentDefinition = {
      ...normalized,
      kind: "custom",
      path,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const changedOthers = new Map<string, AgentDefinition>();
    if (renaming && existing) {
      for (const [key, other] of this.custom) {
        if (key === originalKey || !other.allowedAgents.includes(originalName!)) continue;
        if (!referenceTargets(other, existing, this.custom)) continue;
        changedOthers.set(key, { ...other, allowedAgents: other.allowedAgents.map((name) => (name === originalName ? agent.name : name)), updatedAt: at });
      }
    }

    const written = [agent, ...changedOthers.values()];
    const touchedPaths = written.map((definition) => definition.path ?? this.definitionPath(locationOf(definition), definition.name));
    try {
      this.writeDefinitions(written);
      if (renaming && existing?.path && existing.path !== path) this.unlinkDefinition(existing.path, true);
    } catch (error) {
      for (const touched of touchedPaths) this.digests.delete(touched);
      if (existing?.path) this.digests.delete(existing.path);
      throw error;
    }

    if (originalKey) this.custom.delete(originalKey);
    for (const [key, other] of changedOthers) this.custom.set(key, other);
    this.custom.set(keyOf(location, agent.name), agent);

    if (renaming && existing) {
      if (existing.scope === "global") {
        if (this.defaultAgent === originalName) this.defaultAgent = agent.name;
        const aliases: Record<string, string> = {};
        for (const [from, to] of Object.entries(this.renamedAgents)) aliases[from] = to === originalName ? agent.name : to;
        aliases[originalName!] = agent.name;
        this.renamedAgents = aliases;
      }
      this.fileWarnings.delete(existing.path ?? "");
      this.fileWarnings.forEach((warning, warningPath) => {
        if (warning.agentName === originalName && warningPath === existing.path) this.fileWarnings.delete(warningPath);
      });
    }
    this.commit();
    return structuredClone(agent);
  }

  delete(name: string, requestedLocation: AgentLocation): void {
    if (isBuiltinAgentName(name)) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is a built-in agent and cannot be deleted.`);
    const location: Location = requestedLocation.scope === "project"
      ? { scope: "project", projectCwd: canonical(requestedLocation.projectCwd) }
      : { scope: "global" };
    const agent = this.custom.get(keyOf(location, name));
    if (!agent) throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}" in this scope.`);
    if (agent.scope === "global" && name === this.defaultAgent) throw new ProtocolError(ErrorCodes.InvalidParams, DELETE_DEFAULT_MESSAGE);
    if (agent.path) this.unlinkDefinition(agent.path, false);
    this.removeDefinition(agent, false);
    this.commit();
  }

  setDefault(name: string): void {
    if (isBuiltinAgentName(name)) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is a built-in agent and cannot start project sessions.`);
    const global = this.custom.get(keyOf({ scope: "global" }, name));
    if (!global) {
      if ([...this.custom.values()].some((agent) => agent.name === name && agent.scope === "project")) {
        throw new ProtocolError(ErrorCodes.InvalidParams, "A project agent cannot be the default. Choose a global agent instead.");
      }
      throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}".`);
    }
    if (this.defaultAgent === name) return;
    this.defaultAgent = name;
    this.commit();
  }

  setPolicy(patch: Partial<AgentPolicy>): AgentPolicy {
    const next = { ...this.policy };
    if (patch.maxDepth !== undefined) {
      if (!Number.isInteger(patch.maxDepth) || patch.maxDepth < 1 || patch.maxDepth > AGENT_MAX_DEPTH_LIMIT) {
        throw invalid([{ field: "maxDepth", message: `Nesting depth is a whole number between 1 and ${AGENT_MAX_DEPTH_LIMIT}.` }]);
      }
      next.maxDepth = patch.maxDepth;
    }
    if (patch.foregroundCommandSeconds !== undefined) {
      const seconds = patch.foregroundCommandSeconds;
      if (!Number.isInteger(seconds) || seconds < FOREGROUND_COMMAND_SECONDS_MIN || seconds > FOREGROUND_COMMAND_SECONDS_MAX) {
        throw invalid([{ field: "foregroundCommandSeconds", message: `Commands move to the background after a whole number of seconds between ${FOREGROUND_COMMAND_SECONDS_MIN} and ${FOREGROUND_COMMAND_SECONDS_MAX}.` }]);
      }
      next.foregroundCommandSeconds = seconds;
    }
    if (next.maxDepth === this.policy.maxDepth && next.foregroundCommandSeconds === this.policy.foregroundCommandSeconds) return { ...this.policy };
    this.policy = next;
    this.commit();
    return { ...this.policy };
  }

  /**
   * A person chooses which Model Profile a built-in runs on; `null` returns it
   * to the profile assigned to new sessions (`docs/model-profiles.md`).
   */
  setBuiltinProfile(name: BuiltinAgentName, profileId: string | null): void {
    if (profileId !== null && !isModelProfileId(profileId)) {
      throw invalid([{ field: "profile", message: "Choose one of your model profiles." }]);
    }
    if (this.builtinProfiles[name] === profileId) return;
    this.builtinProfiles = { ...this.builtinProfiles, [name]: profileId };
    this.commit();
  }

  /** Which profile each built-in runs on, for the host's own reads. */
  get builtinProfileIds(): BuiltinProfiles {
    return { ...this.builtinProfiles };
  }

  /**
   * Every pre-M22 model choice this store still holds: each built-in that has
   * chosen no profile, and each definition file that still names a model.
   *
   * The worker turns them into profiles, because it is the only writer of the
   * global settings file; this side only says what was chosen, and applies the
   * answer in {@link applyLegacyModelMigration} (`docs/model-profiles.md`,
   * "Migration").
   */
  legacyModelChoices(): LegacyModelChoice[] {
    const choices: LegacyModelChoice[] = [];
    for (const name of BUILTIN_AGENT_NAMES) {
      if (this.builtinProfiles[name] !== null) continue;
      const model = readLegacyBuiltinModel(this.legacyBuiltins[name]);
      if (model) choices.push({ key: builtinChoiceKey(name), label: builtinLabel(name), model });
    }
    for (const [path, model] of this.legacyModels) {
      const agent = this.definitionAt(path);
      if (agent) choices.push({ key: path, label: agent.name.slice(0, PROFILE_NAME_MAX), model });
    }
    return choices;
  }

  /**
   * The host's half of the one-way migration: a built-in that chose a model
   * takes the profile that model became, and a definition file that still
   * names one is rewritten to name that profile instead — once, because the
   * rewritten file no longer carries a model.
   *
   * Returns exactly what changed, and nothing it did not do: the preview a
   * person reads is evidence, not a summary.
   */
  applyLegacyModelMigration(resolved: Readonly<Record<string, string>>): {
    builtins: Array<{ name: string; from: string; to: string }>;
    agentFiles: Array<{ path: string; from: string; to: string }>;
  } {
    const builtins: Array<{ name: string; from: string; to: string }> = [];
    for (const name of BUILTIN_AGENT_NAMES) {
      if (this.builtinProfiles[name] !== null) continue;
      const model = readLegacyBuiltinModel(this.legacyBuiltins[name]);
      const to = model ? resolved[builtinChoiceKey(name)] : undefined;
      if (!model || !to || !isModelProfileId(to)) continue;
      this.builtinProfiles = { ...this.builtinProfiles, [name]: to };
      builtins.push({ name, from: modelText(model), to });
    }
    const agentFiles: Array<{ path: string; from: string; to: string }> = [];
    for (const [path, model] of [...this.legacyModels]) {
      const to = resolved[path];
      const agent = this.definitionAt(path);
      if (!agent || !to || !isModelProfileId(to)) continue;
      try {
        this.save({ ...agent, profileId: to }, agent.name);
      } catch (error) {
        // The file stays exactly as the person wrote it, warning and all, and
        // the next start tries again: a failed rewrite is never a lost choice.
        this.log(`agents: ${path} still names a model; it could not be rewritten: ${messageOf(error)}`);
        continue;
      }
      this.legacyModels.delete(path);
      this.fileWarnings.delete(path);
      agentFiles.push({ path, from: modelText(model), to });
    }
    if (builtins.length > 0) this.commit();
    return { builtins, agentFiles };
  }

  /**
   * Say on the definition itself that its profile could not be changed.
   *
   * Deleting a profile moves every reference in the same call; when one of
   * those writes fails the id is already gone, so the person is told at once
   * rather than at the next periodic check (`router.ts`, delete-with-replacement).
   */
  noteProfileWarning(agent: AgentDefinition, message: string, cause?: unknown): void {
    if (cause !== undefined) this.log(`agents: ${agent.name} kept its model profile id: ${messageOf(cause)}`);
    if (!agent.path) return;
    const previous = this.fileWarnings.get(agent.path);
    this.fileWarnings.set(agent.path, {
      agentName: agent.name,
      field: "profile",
      path: agent.path,
      ...(agent.profileId ? { target: agent.profileId } : {}),
      message,
      since: previous?.since ?? this.now().toISOString(),
    });
    this.commit();
  }

  /** The definition a path holds, whatever scope it is in. */
  private definitionAt(path: string): AgentDefinition | undefined {
    return [...this.custom.values()].find((agent) => agent.path === path);
  }

  /**
   * Move every built-in that pointed at `from` to `to`. Part of deleting a
   * profile: nothing is ever left pointing at one that is gone.
   */
  replaceBuiltinProfile(from: string, to: string | null): boolean {
    const next: BuiltinProfiles = {
      beam: this.builtinProfiles.beam === from ? to : this.builtinProfiles.beam,
      chat: this.builtinProfiles.chat === from ? to : this.builtinProfiles.chat,
      namer: this.builtinProfiles.namer === from ? to : this.builtinProfiles.namer,
    };
    if (JSON.stringify(next) === JSON.stringify(this.builtinProfiles)) return false;
    this.builtinProfiles = next;
    this.commit();
    return true;
  }

  setBuiltinInstructions(name: BuiltinAgentName, instructions: string | null): void {
    if (instructions !== null) {
      if (instructions.length > AGENT_INSTRUCTIONS_MAX) throw invalid([{ field: "instructions", message: `Instructions are limited to ${Math.round(AGENT_INSTRUCTIONS_MAX / 1024)} KB.` }]);
      if (instructions.trim().length === 0) throw invalid([{ field: "instructions", message: "Write instructions, or restore the built-in instructions." }]);
      const issue = instructionTemplateIssue(instructions, name);
      if (issue) throw invalid([{ field: "instructions", message: issue }]);
    }
    if (this.builtinInstructions[name] === instructions) return;
    this.builtinInstructions = { ...this.builtinInstructions, [name]: instructions };
    this.commit();
  }

  /** SkillsCheck owns these warnings; file warnings are retained alongside them. */
  setWarnings(warnings: readonly AgentWarning[]): void {
    const next = structuredClone([...warnings]);
    if (JSON.stringify(next) === JSON.stringify(this.skillWarnings)) return;
    this.skillWarnings = next;
    this.commit();
  }

  /** Reconcile project files after the registry list or a trust decision changes. */
  setTrustedProjects(projects: readonly string[]): void {
    const next = new Set(projects.map(canonical));
    const locationsChanged = !sameSet(next, this.trustedProjects);
    this.trustedProjects = next;
    let changed = false;
    if (locationsChanged) {
      for (const [key, agent] of [...this.custom]) {
        if (agent.scope !== "project" || next.has(agent.projectCwd!)) continue;
        this.custom.delete(key);
        if (agent.path) {
          this.digests.delete(agent.path);
          this.fileWarnings.delete(agent.path);
        }
        changed = true;
      }
    }
    for (const projectCwd of next) changed = this.files.reconcile({ scope: "project", projectCwd }, false) || changed;
    this.files.locationsChanged();
    if (changed) this.commit();
  }

  close(): void {
    this.files.close();
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      this.persist();
    }
  }

  private builtins(): AgentDefinition[] {
    return builtinAgents({
      agentDir: this.options.agentDir,
      stateDir: this.stateDir(),
      beamProfileId: this.builtinProfiles.beam,
      chatProfileId: this.builtinProfiles.chat,
      namerProfileId: this.builtinProfiles.namer,
      instructions: this.builtinInstructions,
      at: BUILTIN_STAMP,
    });
  }

  private commit(): void {
    this.revision += 1;
    this.schedulePersist();
    this.options.onChange?.(this.snapshot());
  }

  private load(): void {
    const file = this.options.storePath;
    let parsed: Stored | undefined;
    let legacyAgents: AgentDefinition[] = [];
    if (file) {
      try {
        const text = readFileSync(file, "utf8");
        parsed = JSON.parse(text) as Stored;
        if (parsed.version === 1 && Array.isArray(parsed.agents)) {
          const migrated = this.migrateV1(parsed);
          if (migrated) parsed = migrated;
          else {
            this.migrationBlocked = true;
            legacyAgents = parsed.agents.map(readLegacyAgent).filter((agent): agent is AgentDefinition => Boolean(agent));
          }
        }
      } catch {
        /* first run or damaged metadata: definitions remain independently readable */
      }
    }
    this.loadMetadata(parsed);
    for (const agent of legacyAgents) {
      const path = this.definitionPath({ scope: "global" }, agent.name);
      this.custom.set(keyOf({ scope: "global" }, agent.name), { ...agent, scope: "global", path });
    }
    this.files.reconcile({ scope: "global" }, false);
    for (const projectCwd of this.trustedProjects) this.files.reconcile({ scope: "project", projectCwd }, false);

    if (![...this.custom.values()].some((agent) => agent.scope === "global")) {
      const seeded = { ...seedDefaultAgent(this.now().toISOString()), path: this.definitionPath({ scope: "global" }, DEFAULT_AGENT_NAME) };
      this.custom.set(keyOf({ scope: "global" }, seeded.name), seeded);
      if (file) {
        try {
          this.writeDefinition(seeded);
        } catch (error) {
          this.log(`agents: the default definition could not be written: ${messageOf(error)}`);
        }
      }
    }
    const wanted = typeof parsed?.defaultAgent === "string" ? parsed.defaultAgent : DEFAULT_AGENT_NAME;
    this.defaultAgent = this.globalAgent(wanted)?.name ?? this.globalAgent(DEFAULT_AGENT_NAME)?.name ?? this.firstGlobal()!.name;
    this.renamedAgents = readRenamedAgents(parsed?.renamedAgents, new Map([...this.custom.values()].filter((agent) => agent.scope === "global").map((agent) => [agent.name, agent])));
  }

  private loadMetadata(parsed: Stored | undefined): void {
    if (typeof parsed?.revision === "number" && Number.isFinite(parsed.revision)) this.revision = parsed.revision;
    if (parsed?.policy && typeof parsed.policy === "object") {
      const { maxDepth, foregroundCommandSeconds } = parsed.policy as Partial<AgentPolicy>;
      if (Number.isInteger(maxDepth) && maxDepth! >= 1 && maxDepth! <= AGENT_MAX_DEPTH_LIMIT) this.policy.maxDepth = maxDepth!;
      if (Number.isInteger(foregroundCommandSeconds) && foregroundCommandSeconds! >= FOREGROUND_COMMAND_SECONDS_MIN && foregroundCommandSeconds! <= FOREGROUND_COMMAND_SECONDS_MAX) this.policy.foregroundCommandSeconds = foregroundCommandSeconds!;
    }
    const profiles = readBuiltinProfiles(parsed?.builtinProfiles);
    if (profiles) this.builtinProfiles = profiles;
    this.builtinInstructions = readBuiltinInstructions(parsed?.builtinInstructions);
    this.legacyBuiltins = readLegacyBuiltins(parsed);
  }

  private migrateV1(parsed: Stored): StoredV2 | undefined {
    const file = this.options.storePath!;
    try {
      const rawAgents = parsed.agents ?? [];
      const agents = rawAgents.map(readLegacyAgent);
      if (agents.some((agent) => !agent)) throw new Error("one stored definition is not valid");
      for (const agent of agents as AgentDefinition[]) {
        const path = this.definitionPath({ scope: "global" }, agent.name);
        if (existsSync(path)) continue;
        this.writeFileAtomic(path, serializeAgentFile({ ...agent, scope: "global", path }));
      }
      copyFileSync(file, nextMigrationBackupPath(file));
      const v2: StoredV2 & LegacyBuiltinState = {
        // Whatever the previous generation wrote about the built-ins comes
        // across untouched; the profile migration reads it (D-346).
        ...readLegacyBuiltins(parsed),
        version: 2,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        defaultAgent: typeof parsed.defaultAgent === "string" ? parsed.defaultAgent : DEFAULT_AGENT_NAME,
        policy: parsed.policy ?? this.policy,
        builtinProfiles: parsed.builtinProfiles ?? this.builtinProfiles,
        builtinInstructions: parsed.builtinInstructions ?? this.builtinInstructions,
        renamedAgents: parsed.renamedAgents ?? {},
      };
      this.writeFileAtomic(file, JSON.stringify(v2, null, 2));
      return v2;
    } catch (error) {
      this.log(`agents: version 1 migration left agents.json unchanged: ${messageOf(error)}`);
      return undefined;
    }
  }

  private removeDefinition(agent: AgentDefinition, diskAlreadyGone: boolean): void {
    this.custom.delete(keyOf(locationOf(agent), agent.name));
    if (agent.path) {
      this.digests.delete(agent.path);
      this.fileWarnings.delete(agent.path);
      this.legacyModels.delete(agent.path);
      if (!diskAlreadyGone) this.unlinkDefinition(agent.path, true);
    }
    if (agent.scope === "global") this.renamedAgents = Object.fromEntries(Object.entries(this.renamedAgents).filter(([, target]) => target !== agent.name));
    const at = this.now().toISOString();
    for (const [key, other] of this.custom) {
      if (!other.allowedAgents.includes(agent.name) || referenceResolves(other, agent.name, this.custom)) continue;
      const changed = { ...other, allowedAgents: other.allowedAgents.filter((child) => child !== agent.name), updatedAt: at };
      this.custom.set(key, changed);
      this.writeDefinition(changed);
    }
    if (agent.scope === "global" && this.defaultAgent === agent.name) {
      const fallback = this.globalAgent(DEFAULT_AGENT_NAME) ?? this.firstGlobal();
      if (fallback) this.defaultAgent = fallback.name;
      else {
        const seeded = { ...seedDefaultAgent(at), path: this.definitionPath({ scope: "global" }, DEFAULT_AGENT_NAME) };
        this.custom.set(keyOf({ scope: "global" }, seeded.name), seeded);
        this.writeDefinition(seeded);
        this.defaultAgent = seeded.name;
      }
    }
  }

  private writeDefinition(agent: AgentDefinition): void {
    this.writeDefinitions([agent]);
  }

  private writeDefinitions(agents: readonly AgentDefinition[]): void {
    if (!this.options.storePath || agents.length === 0) return;
    const entries = agents.map((agent) => {
      const path = agent.path ?? this.definitionPath(locationOf(agent), agent.name);
      const text = serializeAgentFile(agent);
      return { path, text, digest: agentFileDigest(text), tmp: "" };
    });
    try {
      for (const entry of entries) {
        mkdirSync(dirname(entry.path), { recursive: true });
        entry.tmp = join(dirname(entry.path), `.${basename(entry.path)}.${process.pid}.${++this.tmpCounter}.tmp`);
        (this.options.writeFile ?? writeFileSync)(entry.tmp, entry.text);
      }
      for (const entry of entries) renameSync(entry.tmp, entry.path);
    } catch (error) {
      for (const entry of entries) {
        if (entry.tmp) rmSync(entry.tmp, { force: true });
        this.digests.delete(entry.path);
      }
      throw error;
    }
    for (const entry of entries) {
      this.digests.set(entry.path, entry.digest);
      this.fileWarnings.delete(entry.path);
    }
  }

  private unlinkDefinition(path: string, missingOkay: boolean): void {
    if (!this.options.storePath) return;
    try {
      unlinkSync(path);
    } catch (error) {
      if (!missingOkay || existsSync(path)) throw new ProtocolError(ErrorCodes.Internal, `The agent file could not be removed. Check ${path} and try again.`, { cause: messageOf(error) });
    }
    this.digests.delete(path);
    this.fileWarnings.delete(path);
  }

  private writeFileAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${++this.tmpCounter}.tmp`);
    try {
      (this.options.writeFile ?? writeFileSync)(tmp, text);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  private schedulePersist(): void {
    if (!this.options.storePath || this.migrationBlocked || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.persist();
    }, 300);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file || this.migrationBlocked) return;
    const stored: StoredV2 & LegacyBuiltinState = {
      ...this.legacyBuiltins,
      version: 2,
      revision: this.revision,
      defaultAgent: this.defaultAgent,
      policy: this.policy,
      builtinProfiles: this.builtinProfiles,
      builtinInstructions: this.builtinInstructions,
      renamedAgents: this.renamedAgents,
    };
    try {
      this.writeFileAtomic(file, JSON.stringify(stored, null, 2));
    } catch (error) {
      this.log(`agents: metadata could not be saved: ${messageOf(error)}`);
    }
  }

  private globalAgentsDir(): string {
    return join(this.stateDir(), GLOBAL_AGENTS_DIR_NAME);
  }

  private projectAgentsDir(projectCwd: string): string {
    return join(canonical(projectCwd), PROJECT_AGENTS_DIR);
  }

  private definitionPath(location: Location, name: string): string {
    return resolve(location.scope === "global" ? this.globalAgentsDir() : this.projectAgentsDir(location.projectCwd), `${name}.md`);
  }

  private stateDir(): string {
    return resolve(this.options.stateDir ?? (this.options.storePath ? dirname(this.options.storePath) : dirname(this.options.workspaces.beam)));
  }

  private globalAgent(name: string): AgentDefinition | undefined {
    return this.custom.get(keyOf({ scope: "global" }, name));
  }

  private firstGlobal(): AgentDefinition | undefined {
    return [...this.custom.values()].find((agent) => agent.scope === "global");
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function invalid(issues: AgentIssue[]): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, issues[0]?.message ?? "That agent definition is not valid.", { issues });
}

function normalizeInput(input: AgentDefinitionInput): AgentDefinitionInput {
  const copy = structuredClone(input);
  if (copy.scope === "project" && copy.projectCwd) copy.projectCwd = canonical(copy.projectCwd);
  return copy;
}

function locationOfInput(input: AgentDefinitionInput): Location {
  return input.scope === "project" ? { scope: "project", projectCwd: input.projectCwd ?? "" } : { scope: "global" };
}

function locationOf(agent: AgentDefinition): Location {
  return agent.scope === "project" ? { scope: "project", projectCwd: agent.projectCwd ?? "" } : { scope: "global" };
}

function keyOf(location: Location, name: string): string {
  return location.scope === "global" ? `global\0${name}` : `project\0${location.projectCwd}\0${name}`;
}

function referenceTargets(parent: AgentDefinition, target: AgentDefinition, definitions: ReadonlyMap<string, AgentDefinition>): boolean {
  return effectiveAgents([...definitions.values(), target], parent.scope === "project" ? parent.projectCwd : undefined).includes(target);
}

function referenceResolves(
  parent: AgentDefinition,
  name: string,
  definitions: ReadonlyMap<string, AgentDefinition>,
): boolean {
  return effectiveAgents(
    [...definitions.values()],
    parent.scope === "project" ? parent.projectCwd : undefined,
  ).some((candidate) => candidate.name === name);
}

function nextMigrationBackupPath(file: string): string {
  const base = `${file}.v1.bak`;
  if (!existsSync(base)) return base;
  let suffix = 1;
  while (existsSync(`${base}.${suffix}`)) suffix += 1;
  return `${base}.${suffix}`;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** How a built-in's pre-M22 model choice is keyed while the migration resolves it. */
function builtinChoiceKey(name: BuiltinAgentName): string {
  return `builtin:${name}`;
}

/** What a profile created for a built-in is named after. */
function builtinLabel(name: BuiltinAgentName): string {
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function modelText(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

/** The `beam`/`chat`/`namer` blobs the previous generation wrote, verbatim (D-346). */
function readLegacyBuiltins(parsed: Stored | undefined): LegacyBuiltinState {
  const state: LegacyBuiltinState = {};
  for (const name of BUILTIN_AGENT_NAMES) {
    const value = parsed?.[name];
    if (value && typeof value === "object" && !Array.isArray(value)) state[name] = value;
  }
  return state;
}

/** The model one of those blobs named, when it named one. */
function readLegacyBuiltinModel(raw: unknown): ModelIdentity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = (raw as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  if (!isString(provider) || !isString(id) || provider.trim() === "" || id.trim() === "") return undefined;
  return { provider: provider.trim(), id: id.trim() };
}

/** The profile a stored legacy definition named, when it names a real one. */
function readStoredProfileId(value: Record<string, unknown>): string | null {
  const raw = value["profile"];
  return isString(raw) && isModelProfileId(raw) ? raw : null;
}

/** Which profile each built-in runs on, from the stored metadata. */
function readBuiltinProfiles(raw: unknown): BuiltinProfiles | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const read = (name: BuiltinAgentName): string | null =>
    isString(value[name]) && isModelProfileId(value[name]) ? (value[name] as string) : null;
  return { beam: read("beam"), chat: read("chat"), namer: read("namer") };
}

function readBuiltinInstructions(value: unknown): BuiltinInstructionOverrides {
  const record = value && typeof value === "object" ? (value as Partial<Record<BuiltinAgentName, unknown>>) : {};
  const read = (name: BuiltinAgentName): string | null => {
    const instructions = record[name];
    if (typeof instructions !== "string" || instructions.trim().length === 0 || instructions.length > AGENT_INSTRUCTIONS_MAX) return null;
    // Keep old overrides byte-for-byte. The editor explains fields that this
    // version removed and offers Restore; the worker safely falls back for a
    // turn rather than deleting the person's text during load/persist.
    return instructions;
  };
  return { beam: read("beam"), chat: read("chat"), namer: read("namer") };
}

function readRenamedAgents(value: unknown, global: ReadonlyMap<string, AgentDefinition>): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object") return {};
  const aliases: Record<string, string> = {};
  for (const [from, target] of Object.entries(value)) {
    if (!AGENT_NAME_PATTERN.test(from) || isBuiltinAgentName(from) || global.has(from)) continue;
    if (typeof target !== "string" || !global.has(target) || from === target) continue;
    aliases[from] = target;
  }
  return aliases;
}

function readLegacyAgent(raw: unknown): AgentDefinition | undefined {
  const value = raw as Partial<AgentDefinition> | null;
  if (!value || !isString(value.name) || isBuiltinAgentName(value.name) || !AGENT_NAME_PATTERN.test(value.name)) return undefined;
  const skills = Array.isArray(value.skills)
    ? value.skills.filter((skill): skill is AgentDefinition["skills"][number] => {
        const item = skill as Partial<AgentDefinition["skills"][number]> | null;
        return !!item && isString(item.name) && isString(item.path) && (item.scope === "global" || item.scope === "project");
      }).map((skill) => ({ name: skill.name, path: skill.path, scope: skill.scope }))
    : [];
  const level = value.thinkingLevel;
  const thinkingLevel = (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).find((known) => known === level) ?? null;
  const createdAt = isString(value.createdAt) ? value.createdAt : BUILTIN_STAMP;
  return {
    name: value.name,
    kind: "custom",
    scope: "global",
    description: isString(value.description) ? value.description : "",
    instructions: isString(value.instructions) ? value.instructions : "",
    engineInstructions: value.engineInstructions === true,
    excludeCoreInstructions: value.excludeCoreInstructions === true,
    profileId: readStoredProfileId(value),
    thinkingLevel,
    supportsSubagents: value.supportsSubagents === true,
    allowedAgents: isStringList(value.allowedAgents) ? [...value.allowedAgents] : [],
    scopedSkills: value.scopedSkills === true,
    skills,
    createdAt,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : createdAt,
  };
}

