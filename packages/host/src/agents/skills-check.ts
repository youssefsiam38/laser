/**
 * Periodic validation of what an agent definition points at.
 *
 * A scoped skill is a file; files move and get deleted, and nothing tells the
 * definition. So every 30 s (and right after a save) the host stats every
 * scoped skill of every custom agent and turns a missing file into a gentle
 * warning that names the agent, the field and the skill — enough for the UI to
 * take the person to the exact setting. The same pass flags a child list that
 * names an agent that no longer exists.
 *
 * Same discipline as the pi-subagents layer: a stat per file, never a parse,
 * and the timer never throws. `since` is the first time a problem was seen and
 * stays put across ticks, so the UI can say "since Tuesday" rather than
 * flashing a fresh timestamp every half minute.
 */
import { statSync } from "node:fs";
import { effectiveAgents, type AgentDefinition, type AgentWarning } from "@lasercode/protocol";

export interface SkillsCheckOptions {
  /** The current definitions, custom and built-in. */
  agents(): readonly AgentDefinition[];
  /**
   * The ids of the person's Model Profiles. A definition naming one that is
   * gone runs on the profile assigned to new sessions; this pass is what says
   * so (`docs/model-profiles.md`, "Assignments"). Omit to skip the check.
   */
  profileIds?(): ReadonlySet<string>;
  /** Hand the full warning list over; the receiver decides whether it changed. */
  report(warnings: AgentWarning[]): void;
  intervalMs?: number;
  now?: () => Date;
  /** Injectable for tests; defaults to `statSync` existence. */
  exists?: (path: string) => boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class SkillsCheck {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** `agentName\u0000field\u0000target` → when it was first seen. */
  private readonly since = new Map<string, string>();

  constructor(private readonly options: SkillsCheckOptions) {}

  start(): void {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Never throws: it runs on a timer. */
  run(): void {
    let warnings: AgentWarning[];
    try {
      warnings = this.check();
    } catch {
      return;
    }
    try {
      this.options.report(warnings);
    } catch {
      /* the receiver's problem; the next tick reports again */
    }
  }

  private check(): AgentWarning[] {
    const agents = this.options.agents();
    const exists = this.options.exists ?? fileExists;
    const warnings: AgentWarning[] = [];
    const live = new Set<string>();

    for (const agent of agents) {
      // Built-ins are not editable, so a warning that links to their edit page
      // would lead nowhere; their bundled skill is the worker's to write.
      if (agent.kind !== "custom" || !agent.path) continue;
      if (agent.scopedSkills) {
        for (const skill of agent.skills) {
          if (exists(skill.path)) continue;
          warnings.push(
            this.warning(live, agent.path, agent.name, "skills", skill.name, `Skill "${skill.name}" is no longer at ${skill.path}. Choose it again or remove it from this agent.`),
          );
        }
      }
      if (agent.profileId) {
        const known = this.options.profileIds?.();
        if (known && known.size > 0 && !known.has(agent.profileId)) {
          warnings.push(
            this.warning(
              live,
              agent.path,
              agent.name,
              "profile",
              agent.profileId,
              `The model profile this agent used is gone, so it runs on the profile new conversations use. Choose a profile for it.`,
            ),
          );
        }
      }
      const sameProject = new Set(
        effectiveAgents(agents, agent.scope === "project" ? agent.projectCwd : undefined)
          .filter((candidate) => candidate.kind === "custom")
          .map((candidate) => candidate.name),
      );
      for (const child of agent.allowedAgents) {
        if (sameProject.has(child)) continue;
        warnings.push(
          this.warning(live, agent.path, agent.name, "allowedAgents", child, `"${child}" no longer exists, so this agent cannot start it. Remove it from the agents it may start.`),
        );
      }
    }
    for (const key of [...this.since.keys()]) if (!live.has(key)) this.since.delete(key);
    return warnings;
  }

  private warning(live: Set<string>, path: string, agentName: string, field: AgentWarning["field"], target: string, message: string): AgentWarning {
    const key = `${path}\u0000${field}\u0000${target}`;
    live.add(key);
    let since = this.since.get(key);
    if (!since) {
      since = (this.options.now ?? (() => new Date()))().toISOString();
      this.since.set(key, since);
    }
    return { agentName, field, path, target, message, since };
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
