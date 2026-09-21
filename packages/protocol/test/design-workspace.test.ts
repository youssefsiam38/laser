/**
 * The design workspace methods (M21-T13).
 *
 * The shapes are the contract between three processes — the window, the host
 * that routes and the worker that owns the project's files — so what is
 * asserted here is what each of them may rely on: a policy row for every
 * method, closed params, the refusals that stop a half-formed review, and a
 * round trip of every result through its own schema.
 */
import { describe, expect, it } from "vitest";
import {
  DESIGN_WORKSPACE_METHODS,
  DESIGN_WORKSPACE_READ_METHODS,
  designWorkspaceParamsSchemas,
  designWorkspaceResultSchemas,
  methodPolicy,
  parseClientRequest,
  type DesignIndexGetResult,
  type DesignSketchGroundResult,
} from "../src/index.js";

const PROJECT = "pw_11111111111111111111111111";

describe("design workspace method inventory", () => {
  it("names the six methods once", () => {
    expect([...DESIGN_WORKSPACE_METHODS].sort()).toEqual([
      "design/host/ground",
      "design/index/build",
      "design/index/get",
      "design/index/review",
      "design/index/stop",
      "design/sketch/ground",
    ]);
  });

  it("gives every method a policy row: reads reach any, writes are project_write", () => {
    for (const method of DESIGN_WORKSPACE_METHODS) {
      const policy = methodPolicy(method);
      expect(policy, method).toBeDefined();
      expect(policy?.reach ?? "any").toBe("any");
      expect(policy?.scope).toBe(DESIGN_WORKSPACE_READ_METHODS.includes(method) ? "read" : "project_write");
    }
  });

  it("starts no work: an index build is a Command, not a turn", () => {
    for (const method of DESIGN_WORKSPACE_METHODS) expect(methodPolicy(method)?.startsWork ?? false).toBe(false);
  });
});

describe("params", () => {
  it("parses a read over the wire", () => {
    const parsed = parseClientRequest({ jsonrpc: "2.0", id: 1, method: "design/index/get", params: { projectId: PROJECT } });
    expect(parsed.method).toBe("design/index/get");
  });

  it("refuses a field the schema does not know", () => {
    expect(designWorkspaceParamsSchemas["design/index/get"].safeParse({ projectId: PROJECT, secret: 1 }).success).toBe(false);
  });

  it("refuses a rename with no name and a merge with no target", () => {
    const schema = designWorkspaceParamsSchemas["design/index/review"];
    expect(schema.safeParse({ projectId: PROJECT, entryId: "e1", action: "rename" }).success).toBe(false);
    expect(schema.safeParse({ projectId: PROJECT, entryId: "e1", action: "rename", name: "Button" }).success).toBe(true);
    expect(schema.safeParse({ projectId: PROJECT, entryId: "e1", action: "merge" }).success).toBe(false);
    expect(schema.safeParse({ projectId: PROJECT, entryId: "e1", action: "merge", intoEntryId: "e2" }).success).toBe(true);
  });

  it("bounds a sketch document at the sketch bound", () => {
    const schema = designWorkspaceParamsSchemas["design/sketch/ground"];
    expect(schema.safeParse({ projectId: PROJECT, document: "<p>hi</p>" }).success).toBe(true);
    expect(schema.safeParse({ projectId: PROJECT, document: "x".repeat(512 * 1024 + 1) }).success).toBe(false);
  });

  it("takes the host's cwd but never requires it of a client", () => {
    const schema = designWorkspaceParamsSchemas["design/index/get"];
    expect(schema.safeParse({ projectId: PROJECT }).success).toBe(true);
    expect(schema.safeParse({ projectId: PROJECT, cwd: "/home/p" }).success).toBe(true);
  });

  /**
   * A build is a Command in a conversation — watched by files and stopped
   * there — so the method cannot be called without naming the one that owns
   * it. This is the wire's half of that rule; the worker checks the session is
   * one it actually holds.
   */
  it("refuses a build that names no owning conversation", () => {
    const schema = designWorkspaceParamsSchemas["design/index/build"];
    expect(schema.safeParse({ projectId: PROJECT }).success).toBe(false);
    expect(schema.safeParse({ projectId: PROJECT, sessionPath: "" }).success).toBe(false);
    expect(schema.safeParse({ projectId: PROJECT, sessionPath: "/s.jsonl" }).success).toBe(true);
  });
});

describe("results", () => {
  it("round-trips an absent index", () => {
    const answer: DesignIndexGetResult = { state: "absent", commands: [], detail: "not indexed yet" };
    expect(designWorkspaceResultSchemas["design/index/get"].parse(answer)).toEqual(answer);
  });

  it("round-trips a running build with progress by files", () => {
    const command = {
      commandId: "dib_1",
      title: "Indexing the design system",
      phase: "parsing" as const,
      filesParsed: 12,
      filesFound: 240,
      filesFromCache: 3,
      currentPath: "src/Button.tsx",
      elapsedMs: 900,
      running: true,
      sessionPath: "/s.jsonl",
    };
    expect(designWorkspaceResultSchemas["design/index/build"].parse({ command })).toEqual({ command });
    // Nothing in the shape can carry a percentage: the row shows files.
    expect(Object.keys(command)).not.toContain("percent");
  });

  it("round-trips a grounded sketch with its unmapped parts", () => {
    const answer: DesignSketchGroundResult = {
      screen: {
        id: "scr_1",
        name: "Grounded sketch",
        content: { tree: { rootNodeId: "n_1", nodes: [{ id: "n_1", component: { primitive: "stack" }, fidelity: "proposed", props: {}, children: [] }] } },
        states: [{ name: "loading", included: true }],
        fidelity: "proposed",
      },
      unmapped: [{ what: "<canvas>", why: "No index component draws a canvas.", primitive: "box" }],
      states: [{ name: "loading", included: true }],
      usedEntryIds: [],
      notes: [],
    };
    expect(designWorkspaceResultSchemas["design/sketch/ground"].parse(answer)).toEqual(answer);
  });

  it("refuses a host page whose fidelity claims Native", () => {
    const bad = {
      hostPage: { routeOrPath: "/orders", outline: [], files: [], fidelity: "native" },
      candidates: [],
      gaps: [],
    };
    expect(designWorkspaceResultSchemas["design/host/ground"].safeParse(bad).success).toBe(false);
  });
});
