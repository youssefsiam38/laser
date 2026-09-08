/**
 * AgentStore — the agent definitions, kept by the host in `<stateDir>/agents.json`.
 *
 * Same discipline as PrefsStore: load on construct, memory-only without a
 * path, debounced atomic writes, `close()` flushes. Only what a person owns is
 * persisted — their custom agents (the seeded `default` among them), which one
 * starts new sessions, the policy, and the model choices for Beam and Namer.
 * The three built-ins are rebuilt from `builtins.ts` on every load so a copy
 * change ships with the next release instead of being frozen in a file.
 *
 * Every accepted change bumps `revision` and hands the whole snapshot to
 * `onChange`; the server broadcasts it to clients (`agents/updated`) and to
 * every live worker (`agents/sync`). Warnings from the periodic skill check
 * arrive through `setWarnings` and count as a change only when they differ.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_MAX_DEPTH_DEFAULT,
  AGENT_MAX_DEPTH_LIMIT,
  DEFAULT_AGENT_NAME,
  ErrorCodes,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  FOREGROUND_COMMAND_SECONDS_MAX,
  FOREGROUND_COMMAND_SECONDS_MIN,
  ProtocolError,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
  type AgentModelChoice,
  type AgentPolicy,
  type AgentWarning,
  type AgentsSnapshot,
  type BeamState,
  type NamerState,
} from "@lasercode/protocol";
import { builtinAgents, seedDefaultAgent } from "./builtins.js";
import { validateAgentInput } from "./validate.js";

export interface AgentStoreOptions {
  /** File the definitions are persisted to. Absent = memory only (tests). */
  storePath?: string;
  /** Where the engine keeps skills; Beam's bundled skill path is derived from it. */
  agentDir: string;
  /** The directories Beam and Chat sessions run in. Reported on the snapshot. */
  workspaces: { beam: string; chat: string };
  /** Notified after every accepted change with the new snapshot. */
  onChange?: (snapshot: AgentsSnapshot) => void;
  now?: () => Date;
}

/** The persisted file. Built-ins are deliberately absent. */
interface Stored {
  version: 1;
  revision: number;
  agents: AgentDefinition[];
  defaultAgent: string;
  policy: AgentPolicy;
  namer: NamerState;
  beam: BeamState;
}

const DELETE_DEFAULT_MESSAGE = "This agent starts new sessions. Choose another default first.";

export class AgentStore {
  /** Custom agents, in creation order. Always holds at least one. */
  private readonly custom = new Map<string, AgentDefinition>();
  private defaultAgent: string = DEFAULT_AGENT_NAME;
  private policy: AgentPolicy = { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
  private namer: NamerState = { status: "unqualified", model: null, candidates: [] };
  private beam: BeamState = { model: null, suggested: null, needsChoice: true };
  private warningList: AgentWarning[] = [];
  private revision = 0;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: AgentStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  get currentRevision(): number {
    return this.revision;
  }

  // ------------------------------------------------------------------ reads

  /** Everything a client or worker needs: custom agents first, then the built-ins. */
  snapshot(): AgentsSnapshot {
    return structuredClone({
      revision: this.revision,
      agents: [...this.custom.values(), ...this.builtins()],
      defaultAgent: this.defaultAgent,
      warnings: this.warningList,
      policy: this.policy,
      namer: this.namer,
      beam: this.beam,
      workspaces: this.options.workspaces,
    });
  }

  /** One agent by name, custom or built-in. */
  get(name: string): AgentDefinition | undefined {
    const custom = this.custom.get(name);
    if (custom) return structuredClone(custom);
    return this.builtins().find((agent) => agent.name === name);
  }

  /** The agent `session/new` starts when none is named. */
  get defaultAgentName(): string {
    return this.defaultAgent;
  }

  /** The directories Beam and Chat sessions run in. */
  get workspaces(): { beam: string; chat: string } {
    return { ...this.options.workspaces };
  }

  warnings(): AgentWarning[] {
    return structuredClone(this.warningList);
  }

  /** Pure: the issues a save would refuse on. */
  validate(input: AgentDefinitionInput): AgentIssue[] {
    return validateAgentInput(input, { existing: [...this.custom.values(), ...this.builtins()] });
  }

  // ----------------------------------------------------------------- writes

  /** Create or update a custom agent. Built-ins are refused; issues are thrown with their fields. */
  save(input: AgentDefinitionInput): AgentDefinition {
    if (isBuiltinAgentName(input.name)) {
      throw invalid([{ field: "name", message: `"${input.name}" is a built-in agent and cannot be changed.` }]);
    }
    const issues = this.validate(input);
    if (issues.length > 0) throw invalid(issues);
    const at = this.now().toISOString();
    const existing = this.custom.get(input.name);
    const agent: AgentDefinition = {
      ...structuredClone(input),
      kind: "custom",
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.custom.set(agent.name, agent);
    this.commit();
    return structuredClone(agent);
  }

  /**
   * Remove a custom agent. The current default is refused (it is what starts
   * new sessions); so are the built-ins. Every other agent that listed it as a
   * child forgets it, so no definition points at a name that no longer exists.
   */
  delete(name: string): void {
    if (isBuiltinAgentName(name)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is a built-in agent and cannot be deleted.`);
    }
    if (!this.custom.has(name)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}".`);
    }
    if (name === this.defaultAgent) throw new ProtocolError(ErrorCodes.InvalidParams, DELETE_DEFAULT_MESSAGE);
    this.custom.delete(name);
    const at = this.now().toISOString();
    for (const agent of this.custom.values()) {
      if (!agent.allowedAgents.includes(name)) continue;
      agent.allowedAgents = agent.allowedAgents.filter((child) => child !== name);
      agent.updatedAt = at;
    }
    this.commit();
  }

  /** Which agent new sessions start with. Custom agents only. */
  setDefault(name: string): void {
    if (isBuiltinAgentName(name)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `"${name}" is a built-in agent and cannot start project sessions.`);
    }
    if (!this.custom.has(name)) {
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
        throw invalid([
          {
            field: "foregroundCommandSeconds",
            message: `Commands move to the background after a whole number of seconds between ${FOREGROUND_COMMAND_SECONDS_MIN} and ${FOREGROUND_COMMAND_SECONDS_MAX}.`,
          },
        ]);
      }
      next.foregroundCommandSeconds = seconds;
    }
    if (next.maxDepth === this.policy.maxDepth && next.foregroundCommandSeconds === this.policy.foregroundCommandSeconds) {
      return { ...this.policy };
    }
    this.policy = next;
    this.commit();
    return { ...this.policy };
  }

  /** A person chose (or dismissed with `null`): either way the dialog is done. */
  setBeamModel(model: AgentModelChoice | null): void {
    this.beam = { ...this.beam, model: model ? { ...model } : null, needsChoice: false };
    this.commit();
  }

  /** The product's proposal for the choose-model dialog; never applied by itself. */
  setBeamSuggestion(model: AgentModelChoice | null): void {
    this.beam = { ...this.beam, suggested: model ? { ...model } : null };
    this.commit();
  }

  setNamerState(state: NamerState): void {
    this.namer = structuredClone(state);
    this.commit();
  }

  /** A person overrides the benchmark; `null` returns Namer to the next qualification. */
  setNamerModel(model: AgentModelChoice | null): void {
    this.namer = {
      ...this.namer,
      model: model ? { ...model } : null,
      status: model ? "ready" : "unqualified",
      ...(model ? { qualifiedAt: this.now().toISOString() } : {}),
    };
    if (!model) delete this.namer.qualifiedAt;
    this.commit();
  }

  /** Replace the warning list. A change is a change; an identical list is not. */
  setWarnings(warnings: readonly AgentWarning[]): void {
    const next = structuredClone([...warnings]);
    if (JSON.stringify(next) === JSON.stringify(this.warningList)) return;
    this.warningList = next;
    this.commit();
  }

  /** Flush any pending write now. Called when the host shuts down. */
  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
      this.persist();
    }
  }

  // -------------------------------------------------------------- internals

  private builtins(): AgentDefinition[] {
    return builtinAgents({
      agentDir: this.options.agentDir,
      beamModel: this.beam.model,
      namerModel: this.namer.model,
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
    let parsed: Partial<Stored> | undefined;
    if (file) {
      try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
      } catch {
        /* first run, or a truncated file: seed rather than fail to boot */
      }
    }
    if (typeof parsed?.revision === "number" && Number.isFinite(parsed.revision)) this.revision = parsed.revision;
    if (Array.isArray(parsed?.agents)) {
      for (const raw of parsed.agents) {
        const agent = readAgent(raw);
        if (agent) this.custom.set(agent.name, agent);
      }
    }
    if (parsed?.policy && typeof parsed.policy === "object") {
      const { maxDepth, foregroundCommandSeconds } = parsed.policy as Partial<AgentPolicy>;
      if (Number.isInteger(maxDepth) && maxDepth! >= 1 && maxDepth! <= AGENT_MAX_DEPTH_LIMIT) this.policy.maxDepth = maxDepth!;
      if (
        Number.isInteger(foregroundCommandSeconds) &&
        foregroundCommandSeconds! >= FOREGROUND_COMMAND_SECONDS_MIN &&
        foregroundCommandSeconds! <= FOREGROUND_COMMAND_SECONDS_MAX
      ) {
        this.policy.foregroundCommandSeconds = foregroundCommandSeconds!;
      }
    }
    const namer = readNamer(parsed?.namer);
    if (namer) this.namer = namer;
    const beam = readBeam(parsed?.beam);
    if (beam) this.beam = beam;

    // A store with nothing in it (first run) is seeded; one whose person
    // deleted `default` after choosing another default is left alone. The
    // invariant either way: at least one custom agent, and the default names one.
    if (this.custom.size === 0) {
      const seeded = seedDefaultAgent(this.now().toISOString());
      this.custom.set(seeded.name, seeded);
    }
    const wanted = typeof parsed?.defaultAgent === "string" ? parsed.defaultAgent : DEFAULT_AGENT_NAME;
    this.defaultAgent = this.custom.has(wanted) ? wanted : this.custom.has(DEFAULT_AGENT_NAME) ? DEFAULT_AGENT_NAME : [...this.custom.keys()][0]!;
    // Every child list names an agent that exists; a name that does not is
    // dropped here rather than surfacing as a warning about a stale file.
    for (const agent of this.custom.values()) {
      agent.allowedAgents = agent.allowedAgents.filter((child) => this.custom.has(child));
    }
  }

  private schedulePersist(): void {
    if (!this.options.storePath || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.persist();
    }, 300);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    const file = this.options.storePath;
    if (!file) return;
    const stored: Stored = {
      version: 1,
      revision: this.revision,
      agents: [...this.custom.values()],
      defaultAgent: this.defaultAgent,
      policy: this.policy,
      namer: this.namer,
      beam: this.beam,
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${process.pid}.agents.tmp`);
      writeFileSync(tmp, JSON.stringify(stored, null, 2));
      renameSync(tmp, file);
    } catch {
      /* read-only home, full disk: the definitions still apply for this run */
    }
  }
}

/** Built-ins have no history of their own; one fixed stamp keeps snapshots comparable. */
const BUILTIN_STAMP = "1970-01-01T00:00:00.000Z";

function invalid(issues: AgentIssue[]): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, issues[0]?.message ?? "That agent definition is not valid.", { issues });
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function readModel(value: unknown): AgentModelChoice | null {
  const model = value as Partial<AgentModelChoice> | null | undefined;
  return model && isString(model.provider) && isString(model.id) && model.provider && model.id ? { provider: model.provider, id: model.id } : null;
}

/** A stale or hand-edited file is untrusted input: keep only what the writer could have written. */
function readAgent(raw: unknown): AgentDefinition | undefined {
  const value = raw as Partial<AgentDefinition> | null;
  if (!value || !isString(value.name) || isBuiltinAgentName(value.name)) return undefined;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value.name)) return undefined;
  const skills = Array.isArray(value.skills)
    ? value.skills
        .filter((skill): skill is AgentDefinition["skills"][number] => {
          const s = skill as Partial<AgentDefinition["skills"][number]> | null;
          return !!s && isString(s.name) && isString(s.path) && (s.scope === "global" || s.scope === "project" || s.scope === "bundled");
        })
        .map((skill) => ({ name: skill.name, path: skill.path, scope: skill.scope }))
    : [];
  const level = value.thinkingLevel;
  const thinkingLevel = (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).find((known) => known === level) ?? null;
  const timeout = value.runTimeoutMinutes;
  const created = isString(value.createdAt) ? value.createdAt : BUILTIN_STAMP;
  return {
    name: value.name,
    kind: "custom",
    description: isString(value.description) ? value.description : "",
    instructions: isString(value.instructions) ? value.instructions : "",
    engineInstructions: value.engineInstructions === true,
    model: readModel(value.model),
    thinkingLevel,
    tools: isStringList(value.tools) ? [...value.tools] : [],
    supportsSubagents: value.supportsSubagents === true,
    allowedAgents: isStringList(value.allowedAgents) ? [...value.allowedAgents] : [],
    scopedSkills: value.scopedSkills === true,
    skills,
    runTimeoutMinutes: Number.isInteger(timeout) && (timeout as number) > 0 ? (timeout as number) : null,
    createdAt: created,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : created,
  };
}

function readNamer(raw: unknown): NamerState | undefined {
  const value = raw as Partial<NamerState> | null | undefined;
  if (!value || typeof value !== "object") return undefined;
  const status = value.status;
  if (status !== "unqualified" && status !== "qualifying" && status !== "ready" && status !== "unavailable") return undefined;
  const model = readModel(value.model);
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.filter((candidate) => {
        const c = candidate as Partial<NamerState["candidates"][number]> | null;
        return !!c && readModel(c.model) !== null && typeof c.valid === "boolean";
      })
    : [];
  return {
    // A host that died mid-benchmark must not come back saying it is still measuring.
    status: status === "qualifying" ? "unqualified" : status,
    model,
    candidates: structuredClone(candidates),
    ...(isString(value.qualifiedAt) ? { qualifiedAt: value.qualifiedAt } : {}),
    ...(isString(value.reason) ? { reason: value.reason } : {}),
  };
}

function readBeam(raw: unknown): BeamState | undefined {
  const value = raw as Partial<BeamState> | null | undefined;
  if (!value || typeof value !== "object") return undefined;
  return {
    model: readModel(value.model),
    suggested: readModel(value.suggested),
    needsChoice: value.needsChoice !== false,
  };
}
