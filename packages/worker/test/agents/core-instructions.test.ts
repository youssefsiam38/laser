import { existsSync, readFileSync } from "node:fs";
import {
  instructionTemplateFields,
  instructionTemplateIssue,
  PRODUCT_DISPLAY_NAME,
} from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { agentPromptTemplate, coreInstructions } from "../../src/agents/core-instructions.js";
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
    expect(coreInstructions()).toBe(source.trim());
    expect(instructionTemplateIssue(source, "agent")).toBeNull();
    for (const field of instructionTemplateFields("agent")) expect(source).toContain(field.key);
    expect(source).toContain("{{productName}}");
    expect(source).not.toContain("{{availableAgents}}");
    expect(source).not.toContain(PRODUCT_DISPLAY_NAME);
  });

  it("prepends custom engine and custom saved instructions, with an explicit opt-out", () => {
    const engine = { ...fallbackDefaultAgent(), engineInstructions: true };
    const prefixedEngine = `${coreInstructions()}\n\nENGINE`;
    expect(agentPromptTemplate(engine, "ENGINE")).toBe(prefixedEngine);
    expect(agentPromptTemplate(engine, prefixedEngine)).toBe(prefixedEngine);

    const saved = { ...engine, engineInstructions: false, instructions: "SAVED" };
    expect(agentPromptTemplate(saved, "ENGINE")).toBe(`${coreInstructions()}\n\nSAVED`);
    expect(agentPromptTemplate({ ...saved, excludeCoreInstructions: true }, "ENGINE")).toBe("SAVED");
  });

  it.each([
    ["beam", fallbackBeamAgent({ model: null })],
    ["chat", fallbackChatAgent()],
    ["namer", fallbackNamerAgent(null)],
  ])("never prepends the core block to the %s built-in", (_name, definition) => {
    expect(agentPromptTemplate({ ...definition, excludeCoreInstructions: false }, "ENGINE")).toBe(definition.instructions);
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
