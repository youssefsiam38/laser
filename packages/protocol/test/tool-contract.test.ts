import { describe, expect, it } from "vitest";
import {
  LASER_TOOL_NAMES,
  TOOL_DESCRIPTION_MAX,
  TOOL_ERROR_COMMITTED_SENTENCE,
  TOOL_ERROR_MESSAGE_MAX,
  TOOL_ERROR_PROPERTY,
  TOOL_ERROR_UNCOMMITTED_SENTENCE,
  assertToolContract,
  carriedToolError,
  isLaserToolName,
  isPageSizeProperty,
  mcpToolAnnotations,
  parseToolError,
  renderToolError,
  toolContract,
  toolError,
  toolErrorSchema,
  type LaserToolSpec,
  type ToolContractRule,
} from "../src/tool-contract.js";
import { isToolLabelExempt } from "../src/tool-label.js";

/** A tool that obeys every rule; each test bends exactly one thing. */
function conforming(overrides: Partial<LaserToolSpec> = {}): LaserToolSpec {
  return {
    name: "inspect_agent",
    description: "One agent in depth: its status, its task and the question it is paused on.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", maxLength: 128, description: "A runId from start_agent or inspect_fleet." },
        messages: { type: "integer", minimum: 0, maximum: 10, description: "How many of the agent's last messages to include." },
      },
    },
    output: {
      type: "object",
      properties: {
        status: { type: "string", description: "running, needs_input, completed, blocked, failed or cancelled." },
      },
    },
    annotations: { readOnly: true, idempotent: true, destructive: false, external: false },
    label: "injected",
    ...overrides,
  };
}

/** The rules a spec breaks, for assertions that do not care about wording. */
function rules(spec: LaserToolSpec): ToolContractRule[] {
  return toolContract(spec).map((issue) => issue.rule);
}

describe("toolContract", () => {
  it("passes a conforming tool", () => {
    expect(toolContract(conforming())).toEqual([]);
  });

  describe("name", () => {
    it("accepts verb_object snake_case", () => {
      expect(rules(conforming({ name: "remove_agent_worktree", label: "injected" }))).toEqual([]);
    });
    it("refuses a one-word name", () => {
      expect(rules(conforming({ name: "inspect" }))).toContain("name");
    });
    it("refuses camelCase and kebab-case", () => {
      expect(rules(conforming({ name: "inspectAgent" }))).toContain("name");
      expect(rules(conforming({ name: "inspect-agent" }))).toContain("name");
    });
  });

  describe("description", () => {
    it("refuses an empty description", () => {
      expect(rules(conforming({ description: "   " }))).toContain("description");
    });
    it("refuses one over the budget", () => {
      expect(rules(conforming({ description: "x".repeat(TOOL_DESCRIPTION_MAX + 1) }))).toContain("description");
    });
    it("accepts one exactly at the budget", () => {
      expect(rules(conforming({ description: "x".repeat(TOOL_DESCRIPTION_MAX) }))).toEqual([]);
    });
  });

  describe("input-closed", () => {
    it("refuses an open schema", () => {
      const spec = conforming({ input: { type: "object", properties: {} } });
      expect(rules(spec)).toContain("input-closed");
    });
    it("refuses a non-object input", () => {
      expect(rules(conforming({ input: { type: "string", maxLength: 10 } }))).toContain("input-closed");
    });
    it("accepts a closed schema with no properties", () => {
      expect(rules(conforming({ name: "inspect_fleet", label: "exempt", input: { type: "object", additionalProperties: false, properties: {} } }))).toEqual([]);
    });
    it("refuses an open nested object", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            window: { type: "object", description: "The window to read.", properties: { from: { type: "integer", description: "First byte." } } },
          },
        },
      });
      expect(rules(spec)).toContain("input-closed");
    });
  });

  describe("property-described", () => {
    it("refuses a property with no description", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { runId: { type: "string", maxLength: 128 } } },
      });
      expect(toolContract(spec)).toEqual([
        { rule: "property-described", path: "input.properties.runId", message: expect.stringContaining("runId") },
      ]);
    });
    it("refuses a nested property with no description", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            window: {
              type: "object",
              additionalProperties: false,
              description: "The window to read.",
              properties: { from: { type: "integer" } },
            },
          },
        },
      });
      expect(rules(spec)).toContain("property-described");
    });
  });

  describe("string-bounds", () => {
    it("refuses an unbounded string", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { runId: { type: "string", description: "A runId." } } },
      });
      expect(rules(spec)).toContain("string-bounds");
    });
    it("accepts a string closed by an enum instead", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { mode: { type: "string", enum: ["interrupt", "steer"], description: "How to deliver it." } },
        },
      });
      expect(rules(spec)).toEqual([]);
    });
    it("checks the branches of a union", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            worktree: {
              description: "Whether to isolate the agent.",
              anyOf: [{ type: "boolean" }, { type: "string" }],
            },
          },
        },
      });
      expect(rules(spec)).toContain("string-bounds");
    });
    it("accepts a union of a boolean and a literal", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            worktree: {
              description: "Whether to isolate the agent.",
              anyOf: [{ type: "boolean" }, { type: "string", const: "strict" }],
            },
          },
        },
      });
      expect(rules(spec)).toEqual([]);
    });
  });

  describe("array-bounds", () => {
    it("refuses an unbounded array", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { domains: { type: "array", items: { type: "string", maxLength: 253 }, description: "Domains to search." } },
        },
      });
      expect(rules(spec)).toContain("array-bounds");
    });
    it("refuses unbounded items inside a bounded array", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { domains: { type: "array", maxItems: 20, items: { type: "string" }, description: "Domains to search." } },
        },
      });
      expect(rules(spec)).toContain("string-bounds");
    });
    it("accepts a bounded array of bounded items", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { domains: { type: "array", maxItems: 20, items: { type: "string", maxLength: 253 }, description: "Domains to search." } },
        },
      });
      expect(rules(spec)).toEqual([]);
    });
  });

  describe("page-size-bounds", () => {
    it("names the page-size properties", () => {
      expect(isPageSizeProperty("limit")).toBe(true);
      expect(isPageSizeProperty("numResults")).toBe(true);
      expect(isPageSizeProperty("num_results")).toBe(true);
      expect(isPageSizeProperty("tail")).toBe(true);
      expect(isPageSizeProperty("offset")).toBe(false);
      expect(isPageSizeProperty("timeout")).toBe(false);
    });
    // N5: the list grows by name, one review at a time.
    it("knows the page sizes written under another name", () => {
      expect(isPageSizeProperty("take")).toBe(true);
      expect(isPageSizeProperty("bytes")).toBe(true);
      expect(isPageSizeProperty("window")).toBe(true);
      expect(isPageSizeProperty("maxBytes")).toBe(false);
    });
    it("refuses a page size with no ceiling", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, description: "How many rows." } } },
      });
      expect(rules(spec)).toContain("page-size-bounds");
    });
    it("accepts a page size with a maximum", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many rows." } } },
      });
      expect(rules(spec)).toEqual([]);
    });
    it("leaves a number that is not a page size alone", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { timeout: { type: "number", description: "Seconds before the command is killed." } } },
      });
      expect(rules(spec)).toEqual([]);
    });
  });

  describe("enum-closed", () => {
    it("refuses an empty enum", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: [], description: "How to deliver it." } } },
      });
      expect(rules(spec)).toContain("enum-closed");
    });
    it("refuses an enum of objects", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: [{ mode: "steer" }], description: "How to deliver it." } } },
      });
      expect(rules(spec)).toContain("enum-closed");
    });
    it("refuses an empty union", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { mode: { anyOf: [], description: "How to deliver it." } } },
      });
      expect(rules(spec)).toContain("enum-closed");
    });
  });

  describe("annotations", () => {
    it("refuses a missing flag", () => {
      const spec = conforming({ annotations: { readOnly: true, idempotent: true, destructive: false } as never });
      expect(rules(spec)).toContain("annotations");
    });
    it("refuses read-only and destructive together", () => {
      const spec = conforming({ annotations: { readOnly: true, idempotent: true, destructive: true, external: false } });
      expect(rules(spec)).toContain("annotations");
    });
    it("accepts a destructive, external write", () => {
      const spec = conforming({ annotations: { readOnly: false, idempotent: true, destructive: true, external: true } });
      expect(rules(spec)).toEqual([]);
    });
  });

  describe("label", () => {
    it("refuses a label on an exempt tool", () => {
      expect(rules(conforming({ name: "start_agent", label: "injected" }))).toContain("label");
      expect(rules(conforming({ name: "complete_agent_run", label: "injected" }))).toContain("label");
      expect(rules(conforming({ name: "inspect_fleet", label: "injected" }))).toContain("label");
    });
    it("refuses a missing label on every other tool", () => {
      expect(rules(conforming({ name: "stop_agent", label: "exempt" }))).toContain("label");
    });
    it("refuses a tool that declares the injected parameter itself", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { activity_label: { type: "string", maxLength: 25, description: "What this call is doing." } },
        },
      });
      expect(rules(spec)).toContain("label");
    });
    it("accepts the three exempt tools with label exempt", () => {
      expect(rules(conforming({ name: "start_agent", label: "exempt" }))).toEqual([]);
    });
  });

  // F-B1: the four constructs that walked straight past the lint, and the
  // ones a schema could grow into next. Each is a probe from the M26 review,
  // written as the negative test it should have had.
  describe("constructs that used to bypass the walk", () => {
    /** What `Type.Intersect` emits: the real shape is inside `allOf`. */
    const intersect = (member: Record<string, unknown>): LaserToolSpec =>
      conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { filter: { description: "How to narrow the fleet.", allOf: [member] } },
        },
      });

    it("walks allOf: an open, undescribed, unbounded object inside one is caught", () => {
      const spec = intersect({ type: "object", properties: { needle: { type: "string" } } });
      expect(new Set(rules(spec))).toEqual(new Set(["input-closed", "property-described", "string-bounds"]));
    });

    it("requires every allOf member to be closed and described, not just the first", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            filter: {
              description: "How to narrow the fleet.",
              allOf: [
                { type: "object", additionalProperties: false, properties: { kind: { type: "string", maxLength: 20, description: "Which kind." } } },
                { type: "object", properties: { since: { type: "string", maxLength: 40, description: "From when." } } },
              ],
            },
          },
        },
      });
      const issues = toolContract(spec);
      expect(issues.map((issue) => issue.rule)).toEqual(["input-closed"]);
      expect(issues[0]!.path).toBe("input.properties.filter.allOf[1]");
    });

    it("bounds a string written as a type list", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: ["string", "null"], description: "Why, or nothing." } },
        },
      });
      expect(rules(spec)).toContain("string-bounds");
    });

    it("walks oneOf even when anyOf is there too", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            worktree: {
              description: "Whether to isolate the agent.",
              anyOf: [{ type: "boolean" }],
              oneOf: [{ type: "string" }],
            },
          },
        },
      });
      const issues = toolContract(spec);
      expect(issues.map((issue) => issue.rule)).toEqual(["string-bounds"]);
      expect(issues[0]!.path).toBe("input.properties.worktree.oneOf[0]");
    });

    it("refuses a union branch that is not a schema at all", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: { worktree: { description: "Whether to isolate.", anyOf: [42, { type: "boolean" }] } },
        },
      });
      const issues = toolContract(spec);
      expect(issues.map((issue) => issue.rule)).toEqual(["input-closed"]);
      expect(issues[0]!.message).toContain("42");
    });

    it("walks prefixItems and a tuple-shaped items", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            span: { type: "array", maxItems: 2, prefixItems: [{ type: "string" }], items: { type: "string", maxLength: 8 }, description: "From and to." },
            pair: { type: "array", maxItems: 2, items: [{ type: "string" }], description: "A pair." },
          },
        },
      });
      expect(toolContract(spec).map((issue) => issue.path)).toEqual(["input.properties.span.prefixItems[0]", "input.properties.pair.items[0]"]);
    });

    it("walks the branches of a union inside an array's items", () => {
      const spec = conforming({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            ids: { type: "array", maxItems: 10, items: { anyOf: [{ type: "string" }, { type: "integer" }] }, description: "The ids to read." },
          },
        },
      });
      expect(rules(spec)).toContain("string-bounds");
    });

    it("refuses an array that never says what is in it", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { ids: { type: "array", maxItems: 10, description: "The ids to read." } } },
      });
      expect(rules(spec)).toContain("array-bounds");
    });

    it("refuses a property that declares nothing at all", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { anything: { description: "Whatever you like." } } },
      });
      expect(rules(spec)).toContain("input-closed");
      expect(toolContract(spec)[0]!.message).toContain("declares no type");
    });

    it("refuses a type it does not know, rather than skipping the value", () => {
      const spec = conforming({
        input: { type: "object", additionalProperties: false, properties: { span: { type: "tuple", description: "From and to." } } },
      });
      expect(rules(spec)).toContain("input-closed");
      expect(toolContract(spec)[0]!.message).toContain("\"tuple\"");
    });

    // The harness's validator calls these unvalidatable; the lint may not call
    // them fine. A schema that grows one fails here first.
    const unsupported: Array<[string, Record<string, unknown>]> = [
      ["$ref", { $ref: "#/$defs/filter" }],
      ["patternProperties", { type: "object", additionalProperties: false, patternProperties: { "^x-": { type: "string" } } }],
      ["if/then", { type: "boolean", if: { const: true }, then: { const: true } }],
      ["not", { type: "string", maxLength: 10, not: { const: "no" } }],
      ["dependentSchemas", { type: "object", additionalProperties: false, dependentSchemas: { a: { type: "object" } } }],
      ["unevaluatedProperties", { type: "object", additionalProperties: false, unevaluatedProperties: false }],
      ["additionalItems", { type: "array", maxItems: 2, items: { type: "string", maxLength: 4 }, additionalItems: true }],
    ];
    for (const [label, node] of unsupported) {
      it(`reports ${label} instead of walking past it`, () => {
        const spec = conforming({
          input: { type: "object", additionalProperties: false, properties: { filter: { description: "How to narrow the fleet.", ...node } } },
        });
        const issues = toolContract(spec);
        expect(issues.some((issue) => issue.rule === "input-closed" && issue.message.includes("outside the schema subset"))).toBe(true);
      });
    }
  });

  describe("output-schema", () => {
    it("refuses a missing output shape", () => {
      expect(rules(conforming({ output: {} }))).toContain("output-schema");
    });
    it("refuses an output with no fields", () => {
      expect(rules(conforming({ output: { type: "object", properties: {} } }))).toContain("output-schema");
    });
    it("refuses an undescribed result field", () => {
      expect(rules(conforming({ output: { type: "object", properties: { status: { type: "string" } } } }))).toContain("output-schema");
    });
    // D-350.i: an output is described at every level, and nothing more.
    it("refuses an undescribed field nested inside the result", () => {
      const spec = conforming({
        output: {
          type: "object",
          properties: {
            agents: {
              type: "array",
              description: "The agents under you.",
              items: { type: "object", properties: { runId: { type: "string" } } },
            },
          },
        },
      });
      const issues = toolContract(spec);
      expect(issues.map((issue) => issue.rule)).toEqual(["output-schema"]);
      expect(issues[0]!.path).toBe("output.properties.agents.items.properties.runId");
    });
    it("does not ask a result to be closed or bounded (D-350.i)", () => {
      const spec = conforming({
        output: {
          type: "object",
          properties: {
            messages: { type: "array", description: "The agent's last messages.", items: { type: "string", description: "One message." } },
            note: { type: "string", description: "What was left out, and how to ask for less." },
          },
        },
      });
      expect(rules(spec)).toEqual([]);
    });
    it("refuses a construct it cannot read, in a result as in an argument", () => {
      const spec = conforming({ output: { type: "object", properties: { status: { $ref: "#/$defs/status", description: "How it went." } } } });
      expect(rules(spec)).toContain("output-schema");
    });
  });

  it("reports every violation at once rather than the first", () => {
    const spec = conforming({
      name: "inspect",
      description: "",
      input: { type: "object", properties: { runId: { type: "string" } } },
      output: {},
    });
    expect(new Set(rules(spec))).toEqual(new Set(["name", "description", "input-closed", "property-described", "string-bounds", "output-schema"]));
  });

  describe("assertToolContract", () => {
    it("says nothing about a conforming tool", () => {
      expect(() => assertToolContract(conforming())).not.toThrow();
    });
    it("throws naming the tool, the rule and the contract", () => {
      expect(() => assertToolContract(conforming({ name: "inspect" }))).toThrow(/inspect.*tool contract.*docs\/agent-tool-contract\.md/s);
    });
  });
});

describe("the product's own tool names", () => {
  it("names the tools under this contract and nothing else", () => {
    expect(isLaserToolName("inspect_agent")).toBe(true);
    expect(isLaserToolName("web_search")).toBe(true);
    expect(isLaserToolName("bash")).toBe(false);
    expect(isLaserToolName("read")).toBe(false);
    expect(isLaserToolName("mcp__server__tool")).toBe(false);
    expect(isLaserToolName(undefined)).toBe(false);
  });
  it("is a list of contract-shaped names", () => {
    for (const name of LASER_TOOL_NAMES) expect(rules(conforming({ name, label: isToolLabelExempt(name) ? "exempt" : "injected" }))).toEqual([]);
  });
});

describe("annotations", () => {
  it("maps to MCP's names", () => {
    expect(mcpToolAnnotations({ readOnly: true, idempotent: false, destructive: false, external: true })).toEqual({
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});

describe("ToolError", () => {
  const error = toolError({
    code: "no_such_run",
    message: 'No run called "run_9" was started by this session.',
    committed: false,
    next: "call inspect_fleet to list the agents under you with their runIds",
  });

  it("is closed: an extra field is refused", () => {
    expect(toolErrorSchema.safeParse({ ...error, detail: "extra" }).success).toBe(false);
  });

  it("refuses an empty message, an empty next and a malformed code", () => {
    expect(() => toolError({ ...error, message: "   " })).toThrow();
    expect(() => toolError({ ...error, next: "" })).toThrow();
    expect(() => toolError({ ...error, code: "No Such Run" })).toThrow();
  });

  it("cuts over-long text rather than throwing", () => {
    const long = toolError({ ...error, message: "x".repeat(TOOL_ERROR_MESSAGE_MAX + 50) });
    expect(long.message).toHaveLength(TOOL_ERROR_MESSAGE_MAX);
  });

  it("renders the four fields as sentences", () => {
    expect(renderToolError(error)).toBe(
      '[no_such_run] No run called "run_9" was started by this session.\n' +
        `${TOOL_ERROR_UNCOMMITTED_SENTENCE}\n` +
        "Next: call inspect_fleet to list the agents under you with their runIds",
    );
    expect(renderToolError({ ...error, committed: true })).toContain(TOOL_ERROR_COMMITTED_SENTENCE);
  });

  it("round-trips through the rendering", () => {
    expect(parseToolError(renderToolError(error))).toEqual(error);
    const committed = { ...error, committed: true };
    expect(parseToolError(renderToolError(committed))).toEqual(committed);
  });

  it("round-trips a multi-line message", () => {
    const multiline = toolError({ ...error, message: "The branch still holds work your checkout does not have.\nMerge it first." });
    expect(parseToolError(renderToolError(multiline))).toEqual(multiline);
  });

  // F-S6: the rendering's own sentences are the ones a harness refusal is
  // most likely to quote. Quoting them may not move the fields around.
  it("round-trips a message that quotes the state sentence and the next line", () => {
    const quoting = toolError({
      ...error,
      message: 'The last attempt said "Nothing was changed." and then "Next: call inspect_fleet", which was not true.',
      committed: true,
    });
    expect(parseToolError(renderToolError(quoting))).toEqual(quoting);
  });

  it("round-trips a message whose own lines are the rendering's three", () => {
    const impostor = toolError({
      ...error,
      message: `A tool answered with this:\n${TOOL_ERROR_UNCOMMITTED_SENTENCE}\nNext: call stop_agent`,
      committed: true,
    });
    const parsed = parseToolError(renderToolError(impostor));
    expect(parsed).toEqual(impostor);
    expect(parsed?.committed).toBe(true);
    expect(parsed?.next).toBe(error.next);
  });

  it("keeps next on one line, so the split has one candidate", () => {
    const folded = toolError({ ...error, next: `merge the branch first\n${TOOL_ERROR_COMMITTED_SENTENCE}\nNext: nothing` });
    expect(folded.next).not.toContain("\n");
    expect(parseToolError(renderToolError(folded))).toEqual(folded);
  });

  it("does not read a sentence that only looks like one of the two", () => {
    expect(parseToolError("[no_such_run] Gone.\nNothing was changedX\nNext: call inspect_fleet")).toBeUndefined();
  });

  it("does not claim an engine error as its own", () => {
    expect(parseToolError("ENOENT: no such file or directory, open '/tmp/x'")).toBeUndefined();
    expect(parseToolError("[no_such_run] Missing the rest of the shape.")).toBeUndefined();
  });

  it("reads a carried error off a thrown value", () => {
    const thrown = Object.assign(new Error(error.message), { [TOOL_ERROR_PROPERTY]: error });
    expect(carriedToolError(thrown)).toEqual(error);
    expect(carriedToolError(new Error("plain"))).toBeUndefined();
    expect(carriedToolError(Object.assign(new Error("x"), { [TOOL_ERROR_PROPERTY]: { code: "x" } }))).toBeUndefined();
    expect(carriedToolError(undefined)).toBeUndefined();
  });
});
