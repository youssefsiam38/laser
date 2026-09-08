/**
 * M13-T3 · `agents/skills` lists the driver's roots with their scope and
 * existence, dedupes by name in precedence order, and hides the Beam skill.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEAM_SKILL_NAME, ensureBeamSkill } from "../../src/agents/beam-skill.js";
import { listAgentSkills } from "../../src/agents/skills.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-skills-`));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse ${name}.\n`);
}

describe("listAgentSkills", () => {
  it("lists global and project skills with scopes, exists flags and no Beam skill", () => {
    const agentDir = join(base, "agent");
    const home = join(base, "home");
    const cwd = join(base, "project");
    writeSkill(join(agentDir, "skills"), "global-one");
    writeSkill(join(home, ".agents", "skills"), "shared-one");
    writeSkill(join(cwd, PROJECT_DIR_NAME, "skills"), "project-one");
    writeSkill(join(cwd, PROJECT_DIR_NAME, "skills"), "global-one"); // shadowed by the global one
    ensureBeamSkill({ agentDir, stateDir: join(base, "state") });
    const listing = listAgentSkills({ cwd, agentDir, home, exclude: [BEAM_SKILL_NAME] });
    expect(listing.roots).toEqual([
      { path: join(agentDir, "skills"), scope: "global", exists: true },
      { path: join(home, ".agents", "skills"), scope: "global", exists: true },
      { path: join(cwd, PROJECT_DIR_NAME, "skills"), scope: "project", exists: true },
      { path: join(cwd, ".agents", "skills"), scope: "project", exists: false },
    ]);
    expect(listing.skills).toEqual([
      { name: "global-one", path: join(agentDir, "skills", "global-one", "SKILL.md"), scope: "global" },
      { name: "shared-one", path: join(home, ".agents", "skills", "shared-one", "SKILL.md"), scope: "global" },
      { name: "project-one", path: join(cwd, PROJECT_DIR_NAME, "skills", "project-one", "SKILL.md"), scope: "project" },
    ]);
    // An untrusted project shows no project roots at all.
    expect(listAgentSkills({ cwd, agentDir, home, projectTrusted: false }).roots.map((r) => r.scope)).toEqual(["global", "global"]);
  });
});
