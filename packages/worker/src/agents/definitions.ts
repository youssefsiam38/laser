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
  AGENT_MAX_DEPTH_DEFAULT,
  BUILTIN_AGENT_NAMES,
  DEFAULT_AGENT_NAME,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  PRODUCT_DISPLAY_NAME,
  instructionTemplateToken,
  isBuiltinAgentName,
  type AgentDefinition,
  type AgentModelChoice,
  type AgentPolicy,
  type AgentsSnapshot,
} from "@lasercode/protocol";

const EPOCH = "1970-01-01T00:00:00.000Z";
export const FALLBACK_NAMER_INSTRUCTIONS =
  "You name sessions from what the person wants done and label running actions by what they are doing. Keep every name concrete, brief and easy to scan.";

function base(name: string, kind: AgentDefinition["kind"], partial: Partial<AgentDefinition>): AgentDefinition {
  return {
    name,
    kind,
    description: "",
    instructions: "",
    engineInstructions: false,
    model: null,
    thinkingLevel: null,
    supportsSubagents: false,
    allowedAgents: [],
    scopedSkills: false,
    skills: [],
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...partial,
  };
}

/** The shipped `default` agent: Laser's instructions, every default tool, may start itself. */
export function fallbackDefaultAgent(): AgentDefinition {
  const app = PRODUCT_DISPLAY_NAME;
  return base(DEFAULT_AGENT_NAME, "custom", {
    description: `${app}'s standard coding agent with its default instructions.`,
    engineInstructions: true,
    supportsSubagents: true,
    allowedAgents: [DEFAULT_AGENT_NAME],
  });
}

export function fallbackBeamAgent(options: { model: AgentModelChoice | null }): AgentDefinition {
  const app = PRODUCT_DISPLAY_NAME;
  return base("beam", "builtin", {
    description: `${app}'s assistant for the app itself.`,
    instructions: [
      `You are Beam, the person's assistant for ${app}.`,
      `You answer questions about their sessions, logs, agents and settings by inspecting the ${app} data available in your workspace. Read before you answer.`,
      "You explain how to navigate the app, propose concrete next actions in the app's own words, and ask before changing any file or setting.",
      "Be brief and specific. Quote the paths you read so the person can check.",
      instructionTemplateToken("availableTools"),
      instructionTemplateToken("toolGuidelines"),
      instructionTemplateToken("availableSkills"),
    ].join("\n"),
    model: options.model,
    scopedSkills: false,
    skills: [],
  });
}

export function fallbackChatAgent(model: AgentModelChoice | null = null): AgentDefinition {
  return base("chat", "builtin", {
    description: "A general assistant for conversations not tied to a project.",
    instructions: [
      "You are a general assistant. This conversation is not tied to any project or code base.",
      "Answer directly and concisely. You work in a scratch folder of your own, not in the person's project: if they want work done in one, tell them to open a session there.",
      instructionTemplateToken("availableTools"),
      instructionTemplateToken("toolGuidelines"),
      instructionTemplateToken("availableSkills"),
    ].join("\n"),
    model,
  });
}

/** Namer is a service, never a session: never startable. */
export function fallbackNamerAgent(model: AgentModelChoice | null): AgentDefinition {
  return base("namer", "builtin", {
    description: "Names sessions and labels running tool calls. Not a session agent.",
    instructions: FALLBACK_NAMER_INSTRUCTIONS,
    model,
  });
}

export function fallbackPolicy(): AgentPolicy {
  return { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
}

export function fallbackSnapshot(): AgentsSnapshot {
  return {
    revision: 0,
    agents: [
      fallbackDefaultAgent(),
      fallbackBeamAgent({ model: null }),
      fallbackChatAgent(),
      fallbackNamerAgent(null),
    ],
    defaultAgent: DEFAULT_AGENT_NAME,
    warnings: [],
    policy: fallbackPolicy(),
    namer: { status: "unqualified", model: null, candidates: [] },
    beam: { model: null, suggested: null, needsChoice: false },
    chat: { model: null },
    builtinInstructions: { beam: null, chat: null, namer: null },
    renamedAgents: {},
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

  constructor() {
    this.current = fallbackSnapshot();
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
      if (name === "beam") agents.push(fallbackBeamAgent({ model: snapshot.beam.model }));
      else if (name === "chat") agents.push(fallbackChatAgent(snapshot.chat?.model ?? null));
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
    const direct = this.current.agents.find((agent) => agent.name === name);
    if (direct) return direct;
    const seen = new Set<string>();
    let resolved = name;
    while (!seen.has(resolved)) {
      seen.add(resolved);
      const next = this.current.renamedAgents?.[resolved];
      if (!next) return undefined;
      const renamed = this.current.agents.find((agent) => agent.name === next);
      if (renamed) return renamed;
      resolved = next;
    }
    return undefined;
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

  /** Namer is a service rather than a session, so it reads its prompt here. */
  namerInstructions(): string {
    const instructions = this.definition("namer")?.instructions.trim();
    return instructions || FALLBACK_NAMER_INSTRUCTIONS;
  }

  beamModel(): AgentModelChoice | null {
    return this.current.beam.model;
  }

  /** Chat's model; null means the Chat agent follows the configured default. */
  chatModel(): AgentModelChoice | null {
    return this.current.chat?.model ?? null;
  }

  onChange(listener: (snapshot: AgentsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
