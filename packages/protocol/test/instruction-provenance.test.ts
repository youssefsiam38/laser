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

it("round-trips a capture as it comes off the wire, and refuses ranges that are not ranges", () => {
  // The sample a real capture looks like: one JSON leaf, its digest, and the
  // prompt covered left to right by one span per contributor.
  const sample = {
    path: ["messages", 0, "content"],
    sha256: "b".repeat(64),
    spans: [
      { start: 0, end: 12, source: { kind: "agent", origin: "agent", label: "Engine · base prompt", inline: true } },
      { start: 12, end: 40, source: { kind: "file", origin: "project", label: "AGENTS.md", path: "/project/AGENTS.md" } },
      { start: 44, end: 60, source: { kind: "skill", origin: "skill", label: "Skill · testing", path: "/skills/testing/SKILL.md" } },
    ],
  };
  const wire = JSON.parse(JSON.stringify(sample)) as typeof sample;
  expect(instructionSourceMapSchema.parse(wire)).toEqual(sample);

  const span = sample.spans[0]!;
  const rejected: Array<[string, unknown]> = [
    ["backwards", [{ ...span, start: 30, end: 12 }]],
    ["empty", [{ ...span, start: 12, end: 12 }]],
    ["overlapping", [span, { ...span, start: 6, end: 20 }]],
    ["out of order", [{ ...span, start: 40, end: 60 }, { ...span, start: 0, end: 12 }]],
    ["negative", [{ ...span, start: -1, end: 12 }]],
  ];
  for (const [what, spans] of rejected) {
    expect(instructionSourceMapSchema.safeParse({ ...sample, spans }).success, what).toBe(false);
  }
  // A capture that covers only part of its string is still a legal map: which
  // text it covers is checked against the text itself, not here.
  expect(instructionSourceMapSchema.safeParse({ ...sample, spans: [{ ...span, start: 8, end: 12 }] }).success).toBe(true);
  expect(instructionSourceMapSchema.safeParse({ ...sample, spans: [] }).success).toBe(true);
});
