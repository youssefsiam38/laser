import { existsSync, readFileSync } from "node:fs";
import {
  instructionTemplateFields,
  instructionTemplateIssue,
  PRODUCT_DISPLAY_NAME,
} from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { agentPrompt, coreInstructions } from "../../src/agents/core-instructions.js";
import { instructionTemplateValues } from "../../src/agents/instruction-templates.js";
import type { DriverAgentOptions } from "../../src/driver.js";
import {
  fallbackBeamAgent,
  fallbackChatAgent,
  fallbackDefaultAgent,
  fallbackNamerAgent,
} from "../../src/agents/definitions.js";

describe("core instructions", () => {
  it("is a valid agent template and documents every allowed field without inserting extra blocks", () => {
    const source = readFileSync(new URL("../../src/agents/core-instructions.md", import.meta.url), "utf8");
    expect(source.startsWith("<!--")).toBe(true);
    expect(coreInstructions()).not.toContain("<!--");
    expect(coreInstructions()).toBe(source.replace(/^<!--[\s\S]*?-->/, "").trim());
    expect(coreInstructions().startsWith("# Core instructions")).toBe(true);
    expect(instructionTemplateIssue(source, "agent")).toBeNull();
    for (const field of instructionTemplateFields("agent")) expect(source).toContain(field.key);
    expect(source).not.toContain("{{availableAgents}}");
    expect(source).not.toContain(PRODUCT_DISPLAY_NAME);
  });

  it("prepends custom engine and custom saved instructions, with an explicit opt-out", () => {
    const engine = { ...fallbackDefaultAgent(), engineInstructions: true };
    const core = `${coreInstructions()}\n\n`;
    const enginePrompt = agentPrompt(engine, "ENGINE");
    expect(enginePrompt).toEqual({ core, own: "ENGINE", template: `${core}ENGINE` });
    // The boundary provenance reads is the same object's core length.
    expect(enginePrompt.template.slice(enginePrompt.core!.length)).toBe("ENGINE");

    const saved = { ...engine, engineInstructions: false, instructions: "SAVED" };
    expect(agentPrompt(saved, "ENGINE").template).toBe(`${core}SAVED`);
    expect(agentPrompt({ ...saved, excludeCoreInstructions: true }, "ENGINE")).toEqual({ own: "SAVED", template: "SAVED" });
  });

  it.each([
    ["beam", fallbackBeamAgent({ model: null })],
    ["chat", fallbackChatAgent()],
    ["namer", fallbackNamerAgent(null)],
  ])("never prepends the core block to the %s built-in", (_name, definition) => {
    expect(agentPrompt({ ...definition, excludeCoreInstructions: false }, "ENGINE")).toEqual({ own: definition.instructions, template: definition.instructions });
  });

  it("points Beam's definition field at the global definitions folder", () => {
    const definition = fallbackBeamAgent({ model: null });
    const values = instructionTemplateValues(
      { cwd: "/project" },
      {},
      { agent: { definition } as DriverAgentOptions, agentDir: "/agent", stateDir: "/state", session: () => undefined },
    );
    expect(values.agentDefinitionsFile).toBe("/state/agents");
  });

  it("copies the runtime asset into the worker dist", () => {
    const built = new URL("../../dist/agents/core-instructions.md", import.meta.url);
    expect(existsSync(built)).toBe(true);
    expect(readFileSync(built, "utf8")).toBe(readFileSync(new URL("../../src/agents/core-instructions.md", import.meta.url), "utf8"));
  });
});
