import { expect, it } from "vitest";
import { INSTRUCTION_APP_ORIGIN } from "../src/pi-extension.js";
import { instructionSourceMapSchema } from "../src/schemas.js";
it("round-trips named inline and file-backed identities without adding prompt text", () => {
  const map = { path: ["messages", 0, "content"], sha256: "a".repeat(64), spans: [
    { start: 0, end: 15, source: { kind: INSTRUCTION_APP_ORIGIN, origin: INSTRUCTION_APP_ORIGIN, label: "Agent role", detail: "The current session's role.", inline: true } },
    { start: 15, end: 30, source: { kind: "file", origin: "project", label: "AGENTS.md", path: "/project/AGENTS.md" } },
    { start: 30, end: 45, source: { kind: "variable", origin: "variable", label: "Variable · Available tools", detail: "A field selected in this agent's saved instructions.", inline: true } },
  ] };
  expect(instructionSourceMapSchema.parse(JSON.parse(JSON.stringify(map)))).toEqual(map);
  expect(instructionSourceMapSchema.safeParse({ ...map, spans: [{ start: 0, end: 1, source: { kind: "extension", origin: "invented", label: "Unknown" } }] }).success).toBe(false);
});
