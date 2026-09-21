import { describe, expect, it } from "vitest";
import {
  TOOL_DESCRIPTION_MAX,
  TOOL_ERROR_COMMITTED_SENTENCE,
  TOOL_ERROR_MESSAGE_MAX,
  TOOL_ERROR_PROPERTY,
  TOOL_ERROR_UNCOMMITTED_SENTENCE,
  assertToolContract,
  carriedToolError,
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
