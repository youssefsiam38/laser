/**
 * The worker's copy of the agent definitions.
 *
 * The host is the source of truth (`<stateDir>/agents.json`) and pushes
 * `agents/sync { snapshot }` right after `pi/worker/status: ready` and on
 * every change. Until the first sync arrives this cache answers with built-in
 * fallbacks for `default`, `beam`, `chat` and `namer`, shaped exactly like the
 * host's seeds, so a session opened in the first milliseconds still runs as an
 * agent rather than as nothing.
 */
import {
  AGENT_DEFAULT_TOOLS,
  AGENT_MAX_DEPTH_DEFAULT,
  BUILTIN_AGENT_NAMES,
  DEFAULT_AGENT_NAME,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  PRODUCT_DISPLAY_NAME,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentModelChoice,
  type AgentPolicy,
  type AgentsSnapshot,
  type AgentSkillRef,
} from "@lasercode/protocol";

export interface DefinitionsOptions {
  /** The Beam skill reference for this installation (the fallback Beam definition scopes to it). */
  beamSkill?: AgentSkillRef;
  /** Whether the Web search feature is on, which decides whether `web_search` is offered to Chat. */
  webSearch?: boolean;
}

const EPOCH = "1970-01-01T00:00:00.000Z";

function base(name: string, kind: AgentDefinition["kind"], partial: Partial<AgentDefinition>): AgentDefinition {
  return {
    name,
    kind,
    description: "",
    instructions: "",
    engineInstructions: false,
    model: null,
    thinkingLevel: null,
    tools: [...AGENT_DEFAULT_TOOLS],
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    runTimeoutMinutes: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...partial,
  };
}

/** The shipped `default` agent: the engine's own instructions, every default tool, may start itself. */
export function fallbackDefaultAgent(): AgentDefinition {
  return base(DEFAULT_AGENT_NAME, "custom", {
    description: "General coding agent with the engine's built-in instructions.",
    engineInstructions: true,
    supportsSubagents: true,
    allowedAgents: [DEFAULT_AGENT_NAME],
  });
}

export function fallbackBeamAgent(options: { model: AgentModelChoice | null; beamSkill?: AgentSkillRef }): AgentDefinition {
  const app = PRODUCT_DISPLAY_NAME;
  return base("beam", "builtin", {
    description: `${app}'s assistant for the app itself.`,
    instructions: [
      `You are Beam, the person's assistant for ${app}.`,
      `You answer questions about their sessions, logs, agents and settings by reading ${app}'s data directory; the ${app} skill explains where everything is and how the app is laid out. Read before you answer.`,
      "You explain how to navigate the app, propose concrete next actions in the app's own words, and ask before changing any file or setting.",
      "Be brief and specific. Quote the paths you read so the person can check.",
    ].join("\n"),
    model: options.model,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"],
    scopedSkills: true,
    skills: options.beamSkill ? [options.beamSkill] : [],
  });
}

export function fallbackChatAgent(options: { webSearch: boolean }): AgentDefinition {
  return base("chat", "builtin", {
    description: "A general assistant for conversations not tied to a project.",
    instructions: [
      "You are a general assistant. This conversation is not tied to any project or code base.",
      "Answer directly and concisely. You have no file tools here; if the person wants work done in a project, tell them to open a project session.",
    ].join("\n"),
    tools: options.webSearch ? ["web_search"] : [],
  });
}

/** Namer is a service, never a session: no tools, never startable. */
export function fallbackNamerAgent(model: AgentModelChoice | null): AgentDefinition {
  return base("namer", "builtin", {
    description: "Names sessions and labels running tool calls. Not a session agent.",
    instructions: "Answer with the shortest accurate title.",
    model,
    tools: [],
  });
}

export function fallbackPolicy(): AgentPolicy {
  return { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
}

export function fallbackSnapshot(options: DefinitionsOptions = {}): AgentsSnapshot {
  return {
    revision: 0,
    agents: [
      fallbackDefaultAgent(),
      fallbackBeamAgent({ model: null, ...(options.beamSkill ? { beamSkill: options.beamSkill } : {}) }),
      fallbackChatAgent({ webSearch: options.webSearch ?? false }),
      fallbackNamerAgent(null),
    ],
    defaultAgent: DEFAULT_AGENT_NAME,
    warnings: [],
    policy: fallbackPolicy(),
    namer: { status: "unqualified", model: null, candidates: [] },
    beam: { model: null, suggested: null, needsChoice: false },
    workspaces: { beam: "", chat: "" },
  };
}

/** True for a definition a parent may start as a child. Built-ins never are. */
export function isStartable(definition: AgentDefinition): boolean {
  return definition.kind === "custom" && !isBuiltinAgentName(definition.name);
}

export class DefinitionsCache {
  private current: AgentsSnapshot;
  private synced = false;
  private readonly listeners = new Set<(snapshot: AgentsSnapshot) => void>();

  constructor(private readonly options: DefinitionsOptions = {}) {
    this.current = fallbackSnapshot(options);
  }

  /** Whether a host snapshot has arrived yet. */
  get isSynced(): boolean {
    return this.synced;
  }

  snapshot(): AgentsSnapshot {
    return this.current;
  }

  sync(snapshot: AgentsSnapshot): void {
    // A host that has not seeded a built-in yet still gets the fallback for
    // it, so Beam and Chat never go missing between two host versions.
    const names = new Set(snapshot.agents.map((agent) => agent.name));
    const agents = [...snapshot.agents];
    for (const name of BUILTIN_AGENT_NAMES) {
      if (names.has(name)) continue;
      if (name === "beam") agents.push(fallbackBeamAgent({ model: snapshot.beam.model, ...(this.options.beamSkill ? { beamSkill: this.options.beamSkill } : {}) }));
      else if (name === "chat") agents.push(fallbackChatAgent({ webSearch: this.options.webSearch ?? false }));
      else agents.push(fallbackNamerAgent(snapshot.namer.model));
    }
    this.current = { ...snapshot, agents };
    this.synced = true;
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch {
        // One listener's fault must not stop the others.
      }
    }
  }

  definition(name: string): AgentDefinition | undefined {
    return this.current.agents.find((agent) => agent.name === name);
  }

  defaultAgent(): AgentDefinition {
    return this.definition(this.current.defaultAgent) ?? this.definition(DEFAULT_AGENT_NAME) ?? fallbackDefaultAgent();
  }

  policy(): AgentPolicy {
    return this.current.policy;
  }

  /** Namer's model once a person or the qualifier chose one; null means "do not name". */
  namerModel(): AgentModelChoice | null {
    return this.current.namer.model;
  }

  beamModel(): AgentModelChoice | null {
    return this.current.beam.model;
  }

  onChange(listener: (snapshot: AgentsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
