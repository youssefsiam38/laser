import { expect, it } from "vitest";
import { INSTRUCTION_APP_ORIGIN, ORIGINS } from "../src/pi-extension.js";
import { instructionSourceMapSchema } from "../src/schemas.js";
it("uses stable app identity and derives every schema origin from the catalog", () => {
  expect(INSTRUCTION_APP_ORIGIN).toBe("app");
  for (const { id } of ORIGINS) {
    const map = { path: ["instructions"], sha256: "a".repeat(64), spans: [
      { start: 0, end: 1, source: { origin: id, label: id } },
    ] };
    expect(instructionSourceMapSchema.parse(map)).toEqual(map);
  }
});
it("round-trips named inline and file-backed identities without adding prompt text", () => {
  const map = { path: ["messages", 0, "content"], sha256: "a".repeat(64), spans: [
    { start: 0, end: 15, source: { kind: INSTRUCTION_APP_ORIGIN, origin: INSTRUCTION_APP_ORIGIN, label: "Agent role", module: "agent-role", inline: true } },
    { start: 15, end: 30, source: { kind: "file", origin: "project", label: "AGENTS.md", path: "/project/AGENTS.md" } },
    { start: 30, end: 45, source: { kind: "variable", origin: "variable", label: "Variable · Available tools", fieldKey: "availableTools", agentName: "reviewer", inline: true } },
  ] };
  expect(instructionSourceMapSchema.parse(JSON.parse(JSON.stringify(map)))).toEqual(map);
  expect(instructionSourceMapSchema.safeParse({ ...map, spans: [{ start: 0, end: 1, source: { kind: "extension", origin: "invented", label: "Unknown" } }] }).success).toBe(false);
});
