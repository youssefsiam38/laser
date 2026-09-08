/**
 * M13-T3 · the Beam skill is written from real paths, idempotently, and only
 * names the product through its identity constants.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEAM_SKILL_NAME, beamSkillPath, beamSkillRef, ensureBeamSkill, renderBeamSkill } from "../../src/agents/beam-skill.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-beam-skill-`));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("Beam skill", () => {
  it("renders frontmatter, the real paths, the navigation map and the rules", () => {
    const text = renderBeamSkill({ agentDir: "/data/agent", stateDir: "/data/state" });
    expect(text.startsWith(`---\nname: ${BEAM_SKILL_NAME}\n`)).toBe(true);
    expect(text).toContain("disable-model-invocation: false");
    expect(text).toContain(`\`${join("/data/agent", "sessions")}/<project-slug>/<timestamp>_<id>.jsonl\``);
    expect(text).toContain(join("/data/state", "agents.json"));
    expect(text).toContain(join("/data/state", "agent-runs.json"));
    expect(text).toContain(join("/data/state", "prefs.json"));
    expect(text).toContain(join("/data/state", "projects.json"));
    expect(text).toContain(join("/data/state", "logs.db"));
    expect(text).toContain(SESSION_AGENT_ENTRY_TYPE);
    expect(text).toContain("Providers and models");
    expect(text).toContain("Help and shortcuts");
    expect(text).toContain("End agent");
    expect(text).toContain(PRODUCT_DISPLAY_NAME);
    expect(text).toContain("Never edit, move or delete session files");
  });

  it("writes the file under <agentDir>/skills once and leaves an unchanged file alone", () => {
    const agentDir = join(base, "agent");
    const path = ensureBeamSkill({ agentDir, stateDir: join(base, "state") });
    expect(path).toBe(beamSkillPath(agentDir));
    expect(path).toBe(join(agentDir, "skills", BEAM_SKILL_NAME, "SKILL.md"));
    const first = statSync(path).mtimeMs;
    const text = readFileSync(path, "utf8");
    expect(text).toBe(renderBeamSkill({ agentDir, stateDir: join(base, "state") }));
    ensureBeamSkill({ agentDir, stateDir: join(base, "state") });
    expect(statSync(path).mtimeMs).toBe(first);
    expect(beamSkillRef(agentDir)).toEqual({ name: BEAM_SKILL_NAME, path, scope: "global" });
  });
});
