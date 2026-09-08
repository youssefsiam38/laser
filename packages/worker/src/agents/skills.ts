/**
 * The skills an agent definition can scope to, listed from the same roots the
 * driver gives the engine — without opening a session.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { PROJECT_DIR_NAME, type AgentSkillRef, type AgentSkillScope, type AgentSkillsListing, type AgentSkillsRoot } from "@lasercode/protocol";

export interface SkillRootsInput {
  cwd: string;
  agentDir: string;
  /** False hides the project roots, exactly as the driver does for an untrusted project. */
  projectTrusted?: boolean;
  home?: string;
}

/** The roots, in the driver's precedence order, with their scope. */
export function skillRoots(input: SkillRootsInput): Array<{ path: string; scope: AgentSkillScope }> {
  const home = input.home ?? homedir();
  const roots: Array<{ path: string; scope: AgentSkillScope }> = [
    { path: join(input.agentDir, "skills"), scope: "global" },
    { path: join(home, ".agents", "skills"), scope: "global" },
  ];
  if (input.projectTrusted !== false) {
    roots.push({ path: join(input.cwd, PROJECT_DIR_NAME, "skills"), scope: "project" });
    roots.push({ path: join(input.cwd, ".agents", "skills"), scope: "project" });
  }
  return roots;
}

export function listAgentSkills(input: SkillRootsInput & { exclude?: readonly string[] }): AgentSkillsListing {
  const excluded = new Set(input.exclude ?? []);
  const roots: AgentSkillsRoot[] = [];
  const skills: AgentSkillRef[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(input)) {
    const exists = existsSync(root.path);
    roots.push({ path: root.path, scope: root.scope, exists });
    if (!exists) continue;
    const loaded = loadSkillsFromDir({ dir: root.path, source: root.scope === "global" ? "user" : "project" });
    for (const skill of loaded.skills) {
      if (excluded.has(skill.name) || seen.has(skill.name)) continue;
      seen.add(skill.name);
      skills.push({ name: skill.name, path: skill.filePath, scope: root.scope });
    }
  }
  return { skills, roots };
}
