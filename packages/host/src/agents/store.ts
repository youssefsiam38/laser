/**
 * Durable agent definitions: metadata in agents.json, one Markdown file per
 * custom agent, and live watches for global and trusted-project locations.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENT_MAX_DEPTH_DEFAULT,
  AGENT_MAX_DEPTH_LIMIT,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_PATTERN,
  DEFAULT_AGENT_NAME,
  ErrorCodes,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  FOREGROUND_COMMAND_SECONDS_MAX,
  FOREGROUND_COMMAND_SECONDS_MIN,
  GLOBAL_AGENTS_DIR_NAME,
  PROJECT_AGENTS_DIR,
  ProtocolError,
  instructionTemplateIssue,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
  type AgentModelChoice,
  type AgentPolicy,
  type AgentWarning,
  type AgentsSnapshot,
  type BeamState,
  type BuiltinAgentName,
  type BuiltinInstructionOverrides,
  type ChatState,
  type NamerState,
} from "@lasercode/protocol";
import { parseAgentFile, serializeAgentFile } from "./agent-file.js";
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
}

interface StoredV1 {
  version: 1;
  revision: number;
  agents: unknown[];
  defaultAgent: string;
  policy: AgentPolicy;
  namer: NamerState;
  beam: BeamState;
  chat: ChatState;
  builtinInstructions: BuiltinInstructionOverrides;
  renamedAgents: Readonly<Record<string, string>>;
}

interface StoredV2 extends Omit<StoredV1, "version" | "agents"> {
  version: 2;
}

type Stored = Partial<Omit<StoredV1, "version"> & { version: 1 | 2 }>;
type Location = { scope: "global" } | { scope: "project"; projectCwd: string };

const DELETE_DEFAULT_MESSAGE = "This agent starts new sessions. Choose another default first.";
const BUILTIN_STAMP = "1970-01-01T00:00:00.000Z";

export class AgentStore {
  private readonly custom = new Map<string, AgentDefinition>();
  private defaultAgent = DEFAULT_AGENT_NAME;
  private policy: AgentPolicy = { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
  private namer: NamerState = { status: "unqualified", model: null, candidates: [] };
  private beam: BeamState = { model: null, suggested: null, needsChoice: true };
  private chat: ChatState = { model: null };
  private builtinInstructions: BuiltinInstructionOverrides = { beam: null, chat: null, namer: null };
  private renamedAgents: Readonly<Record<string, string>> = {};
  private skillWarnings: AgentWarning[] = [];
  private readonly fileWarnings = new Map<string, AgentWarning>();
  private readonly digests = new Map<string, string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchedRoots = new Map<string, string>();
  private readonly pendingPaths = new Set<string>();
  private readonly pendingScans = new Set<string>();
  private readonly failedWatchDirectories = new Set<string>();
  private trustedProjects = new Set<string>();
  private revision = 0;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => Date;
  private migrationBlocked = false;
  private tmpCounter = 0;

  constructor(private readonly options: AgentStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.trustedProjects = new Set((options.trustedProjects?.() ?? []).map(canonical));
    this.load();
    if (options.storePath) this.rebuildWatchers();
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
      namer: this.namer,
      beam: this.beam,
      chat: this.chat,
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

    this.writeDefinition(agent);
    for (const other of changedOthers.values()) this.writeDefinition(other);
    if (renaming && existing?.path && existing.path !== path) this.unlinkDefinition(existing.path, true);

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

  delete(name: string): void {
    if (isBuiltinAgentName(name)) throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is a built-in agent and cannot be deleted.`);
    let agent = this.custom.get(keyOf({ scope: "global" }, name));
    if (!agent) {
      const matches = [...this.custom.values()].filter((candidate) => candidate.name === name);
      if (matches.length > 1) {
        throw new ProtocolError(ErrorCodes.InvalidParams, `More than one project has an agent named "${name}". Open its definition file and remove that file instead.`);
      }
      agent = matches[0];
    }
    if (!agent) throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}".`);
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

  setBuiltinModel(name: BuiltinAgentName, model: AgentModelChoice | null): void {
    if (name === "beam") this.setBeamModel(model);
    else if (name === "chat") this.setChatModel(model);
    else this.setNamerModel(model);
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

  setBeamModel(model: AgentModelChoice | null): void {
    this.beam = { ...this.beam, model: model ? { ...model } : null, needsChoice: false };
    this.commit();
  }

  setChatModel(model: AgentModelChoice | null): void {
    this.chat = { model: model ? { ...model } : null };
    this.commit();
  }

  setBeamSuggestion(model: AgentModelChoice | null): void {
    this.beam = { ...this.beam, suggested: model ? { ...model } : null };
    this.commit();
  }

  setNamerState(state: NamerState): void {
    this.namer = structuredClone(state);
    this.commit();
  }

  setNamerModel(model: AgentModelChoice | null): void {
    this.namer = { ...this.namer, model: model ? { ...model } : null, status: model ? "ready" : "unqualified", ...(model ? { qualifiedAt: this.now().toISOString() } : {}) };
    if (!model) delete this.namer.qualifiedAt;
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
    if (sameSet(next, this.trustedProjects)) return;
    this.trustedProjects = next;
    let changed = false;
    for (const [key, agent] of [...this.custom]) {
      if (agent.scope !== "project" || next.has(agent.projectCwd!)) continue;
      this.custom.delete(key);
      if (agent.path) {
        this.digests.delete(agent.path);
        this.fileWarnings.delete(agent.path);
      }
      changed = true;
    }
    for (const projectCwd of next) changed = this.scanDirectory(this.projectAgentsDir(projectCwd), { scope: "project", projectCwd }, false) || changed;
    this.rebuildWatchers();
    if (changed) this.commit();
  }

  close(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchedRoots.clear();
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
      beamModel: this.beam.model,
      chatModel: this.chat.model,
      namerModel: this.namer.model,
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
    this.scanDirectory(this.globalAgentsDir(), { scope: "global" }, false, !this.migrationBlocked);
    for (const projectCwd of this.trustedProjects) this.scanDirectory(this.projectAgentsDir(projectCwd), { scope: "project", projectCwd }, false);

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
    const namer = readNamer(parsed?.namer);
    if (namer) this.namer = namer;
    const beam = readBeam(parsed?.beam);
    if (beam) this.beam = beam;
    const chat = readChat(parsed?.chat);
    if (chat) this.chat = chat;
    this.builtinInstructions = readBuiltinInstructions(parsed?.builtinInstructions);
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
      copyFileSync(file, `${file}.v1.bak`);
      const v2: StoredV2 = {
        version: 2,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        defaultAgent: typeof parsed.defaultAgent === "string" ? parsed.defaultAgent : DEFAULT_AGENT_NAME,
        policy: parsed.policy ?? this.policy,
        namer: parsed.namer ?? this.namer,
        beam: parsed.beam ?? this.beam,
        chat: parsed.chat ?? this.chat,
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
      if (!diskAlreadyGone) this.unlinkDefinition(agent.path, true);
    }
    if (agent.scope === "global") this.renamedAgents = Object.fromEntries(Object.entries(this.renamedAgents).filter(([, target]) => target !== agent.name));
    const at = this.now().toISOString();
    for (const [key, other] of this.custom) {
      if (!other.allowedAgents.includes(agent.name) || !referenceTargets(other, agent, this.custom)) continue;
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

  private scanDirectory(directory: string, location: Location, notify: boolean, reconcileMissing = true): boolean {
    let names: string[] = [];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
    } catch {
      names = [];
    }
    const paths = new Set(names.map((name) => join(directory, name)));
    let changed = false;
    for (const path of paths) changed = this.readDefinitionPath(path, location, false) || changed;
    if (reconcileMissing) for (const agent of [...this.custom.values()]) {
      if (!sameLocation(locationOf(agent), location) || !agent.path || paths.has(agent.path)) continue;
      this.removeDefinition(agent, true);
      changed = true;
    }
    for (const path of [...this.fileWarnings.keys()]) {
      if (dirname(path) !== directory || paths.has(path)) continue;
      this.fileWarnings.delete(path);
      this.digests.delete(path);
      changed = true;
    }
    if (changed && notify) this.commit();
    return changed;
  }

  private readDefinitionPath(path: string, location: Location, notify: boolean): boolean {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      const current = this.custom.get(keyOf(location, basename(path, ".md")));
      let changed = false;
      if (current?.path === path) {
        this.removeDefinition(current, true);
        changed = true;
      }
      if (this.fileWarnings.delete(path)) changed = true;
      this.digests.delete(path);
      if (changed && notify) this.commit();
      return changed;
    }
    const digest = digestOf(text);
    if (this.digests.get(path) === digest) return false;
    this.digests.set(path, digest);
    const name = basename(path, ".md");
    const parsed = parseAgentFile(text, name);
    if (parsed.issues) {
      const previous = this.fileWarnings.get(path);
      this.fileWarnings.set(path, {
        agentName: name,
        field: "file",
        target: path,
        message: `${parsed.issues.join(" ")} Fix ${path} and save it again; the last valid definition is still in use.`,
        since: previous?.since ?? this.now().toISOString(),
      });
      if (notify) this.commit();
      return true;
    }
    const definition: AgentDefinition = {
      ...parsed.definition,
      scope: location.scope,
      ...(location.scope === "project" ? { projectCwd: location.projectCwd } : {}),
      path,
    };
    this.custom.set(keyOf(location, name), definition);
    this.fileWarnings.delete(path);
    if (notify) this.commit();
    return true;
  }

  private rebuildWatchers(): void {
    const wanted = new Map<string, Location>();
    wanted.set(this.globalAgentsDir(), { scope: "global" });
    for (const projectCwd of this.trustedProjects) wanted.set(this.projectAgentsDir(projectCwd), { scope: "project", projectCwd });
    for (const [directory, watcher] of this.watchers) {
      if (wanted.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
      this.watchedRoots.delete(directory);
      this.failedWatchDirectories.delete(directory);
    }
    for (const directory of wanted.keys()) {
      const root = closestExistingDirectory(directory);
      if (!root) continue;
      if (this.watchers.has(directory) && this.watchedRoots.get(directory) === root) continue;
      this.watchers.get(directory)?.close();
      try {
        const watcher = watch(root, (_event, filename) => {
          const text = filename?.toString();
          if (root === directory && text?.endsWith(".md")) this.pendingPaths.add(join(directory, text));
          else this.pendingScans.add(directory);
          this.scheduleWatchFlush();
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(directory);
          this.watchedRoots.delete(directory);
          this.failedWatchDirectories.add(directory);
          this.ensureWatchFallback();
        });
        this.watchers.set(directory, watcher);
        this.watchedRoots.set(directory, root);
        this.failedWatchDirectories.delete(directory);
      } catch {
        // inotify can be exhausted by unrelated processes. Poll only the
        // affected location until a real watcher can be established again.
        this.failedWatchDirectories.add(directory);
        this.ensureWatchFallback();
      }
    }
    if (this.failedWatchDirectories.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private ensureWatchFallback(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const directory of [...this.failedWatchDirectories]) {
        const location = this.locationForDirectory(directory);
        if (!location) {
          this.failedWatchDirectories.delete(directory);
          continue;
        }
        this.scanDirectory(directory, location, true);
      }
      this.rebuildWatchers();
    }, this.options.watchDebounceMs ?? 250);
    this.pollTimer.unref?.();
  }

  private scheduleWatchFlush(): void {
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      const scans = [...this.pendingScans];
      const paths = [...this.pendingPaths];
      this.pendingScans.clear();
      this.pendingPaths.clear();
      for (const directory of scans) {
        const location = this.locationForDirectory(directory);
        if (location) this.scanDirectory(directory, location, true);
      }
      for (const path of paths) {
        if (scans.includes(dirname(path))) continue;
        const location = this.locationForDirectory(dirname(path));
        if (location) this.readDefinitionPath(path, location, true);
      }
      this.rebuildWatchers();
    }, this.options.watchDebounceMs ?? 250);
    this.watchTimer.unref?.();
  }

  private locationForDirectory(directory: string): Location | undefined {
    if (directory === this.globalAgentsDir()) return { scope: "global" };
    for (const projectCwd of this.trustedProjects) if (directory === this.projectAgentsDir(projectCwd)) return { scope: "project", projectCwd };
    return undefined;
  }

  private writeDefinition(agent: AgentDefinition): void {
    if (!this.options.storePath) return;
    const path = agent.path ?? this.definitionPath(locationOf(agent), agent.name);
    const text = serializeAgentFile(agent);
    this.writeFileAtomic(path, text);
    this.digests.set(path, digestOf(text));
    this.fileWarnings.delete(path);
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
      writeFileSync(tmp, text);
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
    const stored: StoredV2 = {
      version: 2,
      revision: this.revision,
      defaultAgent: this.defaultAgent,
      policy: this.policy,
      namer: this.namer,
      beam: this.beam,
      chat: this.chat,
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
  return input.scope === "project" ? { scope: "project", projectCwd: canonical(input.projectCwd ?? "") } : { scope: "global" };
}

function locationOf(agent: AgentDefinition): Location {
  return agent.scope === "project" ? { scope: "project", projectCwd: canonical(agent.projectCwd ?? "") } : { scope: "global" };
}

function keyOf(location: Location, name: string): string {
  return location.scope === "global" ? `global\0${name}` : `project\0${canonical(location.projectCwd)}\0${name}`;
}

function sameLocation(left: Location, right: Location): boolean {
  return left.scope === right.scope && (left.scope === "global" || (right.scope === "project" && canonical(left.projectCwd) === canonical(right.projectCwd)));
}

function referenceTargets(parent: AgentDefinition, target: AgentDefinition, definitions: ReadonlyMap<string, AgentDefinition>): boolean {
  if (target.scope === "project") return parent.scope === "project" && canonical(parent.projectCwd ?? "") === canonical(target.projectCwd ?? "");
  if (parent.scope === "global") return true;
  return !definitions.has(keyOf({ scope: "project", projectCwd: canonical(parent.projectCwd ?? "") }, target.name));
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function closestExistingDirectory(path: string): string | undefined {
  let cursor = path;
  while (true) {
    try {
      if (statSync(cursor).isDirectory()) return cursor;
    } catch { /* move to the parent */ }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function readModel(value: unknown): AgentModelChoice | null {
  const model = value as Partial<AgentModelChoice> | null | undefined;
  return model && isString(model.provider) && isString(model.id) && model.provider && model.id ? { provider: model.provider, id: model.id } : null;
}

function readBuiltinInstructions(value: unknown): BuiltinInstructionOverrides {
  const record = value && typeof value === "object" ? (value as Partial<Record<BuiltinAgentName, unknown>>) : {};
  const read = (name: BuiltinAgentName): string | null => {
    const instructions = record[name];
    return typeof instructions === "string" && instructions.trim().length > 0 && instructions.length <= AGENT_INSTRUCTIONS_MAX ? instructions : null;
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
    model: readModel(value.model),
    thinkingLevel,
    supportsSubagents: value.supportsSubagents === true,
    allowedAgents: isStringList(value.allowedAgents) ? [...value.allowedAgents] : [],
    scopedSkills: value.scopedSkills === true,
    skills,
    createdAt,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : createdAt,
  };
}

function readNamer(raw: unknown): NamerState | undefined {
  const value = raw as Partial<NamerState> | null | undefined;
  if (!value || typeof value !== "object") return undefined;
  const status = value.status;
  if (status !== "unqualified" && status !== "qualifying" && status !== "ready" && status !== "unavailable") return undefined;
  const model = readModel(value.model);
  const candidates = Array.isArray(value.candidates) ? value.candidates.filter((candidate) => {
    const item = candidate as Partial<NamerState["candidates"][number]> | null;
    return !!item && readModel(item.model) !== null && typeof item.valid === "boolean";
  }) : [];
  return { status: status === "qualifying" ? "unqualified" : status, model, candidates: structuredClone(candidates), ...(isString(value.qualifiedAt) ? { qualifiedAt: value.qualifiedAt } : {}), ...(isString(value.reason) ? { reason: value.reason } : {}) };
}

function readChat(raw: unknown): ChatState | undefined {
  const value = raw as Partial<ChatState> | null | undefined;
  return value && typeof value === "object" ? { model: readModel(value.model) } : undefined;
}

function readBeam(raw: unknown): BeamState | undefined {
  const value = raw as Partial<BeamState> | null | undefined;
  if (!value || typeof value !== "object") return undefined;
  return { model: readModel(value.model), suggested: readModel(value.suggested), needsChoice: value.needsChoice !== false };
}
