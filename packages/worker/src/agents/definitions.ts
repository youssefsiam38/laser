/**
 * The worker's copy of the agent definitions.
 *
 * The host is the source of truth (`<stateDir>/agents/*.md` plus definition
 * metadata in `<stateDir>/agents.json`) and pushes `agents/sync { snapshot }`
 * right after `pi/worker/status: ready` and on every change. Until the first
 * sync arrives this cache answers with a fallback for `default`, shaped
 * exactly like the host's seed, so a session opened in the first milliseconds
 * still runs as an agent rather than as nothing.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_MAX_DEPTH_DEFAULT,
  DEFAULT_AGENT_NAME,
  FOREGROUND_COMMAND_SECONDS_DEFAULT,
  PRODUCT_DISPLAY_NAME,
  effectiveAgents,
  isRetiredAgentName,
  type AgentDefinition,
  type AgentPolicy,
  type AgentsSnapshot,
} from "@lasercode/protocol";

const EPOCH = "1970-01-01T00:00:00.000Z";

function canonicalProjectCwd(projectCwd: string): string {
  const resolved = resolve(projectCwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Synthetic workers and snapshots in protocol tests may name paths that
    // have not been opened. The resolved spelling still compares consistently.
    return resolved;
  }
}

function base(name: string, partial: Partial<AgentDefinition>): AgentDefinition {
  return {
    name,
    kind: "custom",
    scope: "global",
    description: "",
    instructions: "",
    engineInstructions: false,
    excludeCoreInstructions: false,
    profileId: null,
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
  return base(DEFAULT_AGENT_NAME, {
    description: `${app}'s standard coding agent with its default instructions.`,
    engineInstructions: true,
    supportsSubagents: true,
    allowedAgents: [DEFAULT_AGENT_NAME],
  });
}

export function fallbackPolicy(): AgentPolicy {
  return { maxDepth: AGENT_MAX_DEPTH_DEFAULT, foregroundCommandSeconds: FOREGROUND_COMMAND_SECONDS_DEFAULT };
}

export function fallbackSnapshot(): AgentsSnapshot {
  return {
    revision: 0,
    agents: [fallbackDefaultAgent()],
    defaultAgent: DEFAULT_AGENT_NAME,
    warnings: [],
    policy: fallbackPolicy(),
    renamedAgents: {},
    workspaces: { chat: "" },
  };
}

/**
 * True for a definition a parent may start as a child. Every definition is a
 * person's own now; the three names that used to be built-in agents are still
 * refused here, so a stale reference cannot start something unexpected.
 */
export function isStartable(definition: AgentDefinition): boolean {
  return !isRetiredAgentName(definition.name);
}

export class DefinitionsCache {
  private current: AgentsSnapshot;
  private synced = false;
  private readonly listeners = new Set<(snapshot: AgentsSnapshot) => void>();
  private readonly projectCwd: string;

  constructor(projectCwd = process.cwd()) {
    this.current = fallbackSnapshot();
    this.projectCwd = canonicalProjectCwd(projectCwd);
  }

  /** Whether a host snapshot has arrived yet. */
  get isSynced(): boolean {
    return this.synced;
  }

  snapshot(): AgentsSnapshot {
    return this.current;
  }

  sync(snapshot: AgentsSnapshot): void {
    // The host broadcasts every project's definitions. This worker retains
    // globals and only its own realpath-normalised project scope; a matching
    // project definition replaces the same-named global definition.
    const normalized = snapshot.agents.map((agent) => {
      if (agent.scope !== "project" || !agent.projectCwd) return agent;
      const projectCwd = canonicalProjectCwd(agent.projectCwd);
      return projectCwd === agent.projectCwd ? agent : { ...agent, projectCwd };
    });
    const agents = effectiveAgents(normalized, this.projectCwd);
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

  onChange(listener: (snapshot: AgentsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
