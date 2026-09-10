/**
 * M13-T3 · `agents/skills` lists the driver's roots with their scope and
 * existence and dedupes user-authored skills by name in precedence order.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("lists only the skills discovered from global and project folders", () => {
    const agentDir = join(base, "agent");
    const home = join(base, "home");
    const cwd = join(base, "project");
    writeSkill(join(agentDir, "skills"), "global-one");
    writeSkill(join(home, ".agents", "skills"), "shared-one");
    writeSkill(join(cwd, PROJECT_DIR_NAME, "skills"), "project-one");
    writeSkill(join(cwd, PROJECT_DIR_NAME, "skills"), "global-one"); // shadowed by the global one
    const listing = listAgentSkills({ cwd, agentDir, home });
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
