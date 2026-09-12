/**
 * The environment-command contract (M16-T17).
 *
 * These tests pin the rules that keep a project's environment from becoming a
 * way to take over the agent itself.
 */
import { describe, expect, it } from "vitest";
import {
  ENV,
  PROJECT_ENV_VERSION,
  parseProjectEnvDocument,
  projectEnvApproved,
  projectEnvFingerprint,
  projectEnvResolution,
  projectEnvWorkerConfig,
  type ProjectEnvConfig,
} from "../src/index.js";

const document = (set: Record<string, string>, unset: string[] = []) => ({
  version: PROJECT_ENV_VERSION,
  set,
  unset,
});

describe("projectEnvResolution", () => {
  it("passes ordinary variables through", () => {
    const resolved = projectEnvResolution(document({ DATABASE_URL: "postgres://x/y", PORT_NUMBER: "8080" }));
    expect(resolved.set).toEqual({ DATABASE_URL: "postgres://x/y", PORT_NUMBER: "8080" });
    expect(resolved.refused).toEqual([]);
  });

  it("refuses a model-provider credential by default", () => {
    // Real projects on real machines set this in their environment files. If a
    // project hook could set it, opening that project would silently repoint
    // the agent's own authentication.
    const resolved = projectEnvResolution(document({ ANTHROPIC_API_KEY: "sk-project", DATABASE_URL: "postgres://x/y" }));
    expect(resolved.set).toEqual({ DATABASE_URL: "postgres://x/y" });
    expect(resolved.refused).toEqual([
      { name: "ANTHROPIC_API_KEY", reason: "a model-provider credential; allow it for this project to use it" },
    ]);
  });

  it("allows a provider credential only when the project opted in", () => {
    const resolved = projectEnvResolution(document({ OPENAI_API_KEY: "sk-test" }), {
      allowProviderKeys: ["OPENAI_API_KEY"],
    });
    expect(resolved.set).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(resolved.refused).toEqual([]);
  });

  it("refuses the app's own and the runtime's pinned variables", () => {
    // The product's own namespace is derived, never spelled: product.json is
    // the only place this product is named (D-36).
    const resolved = projectEnvResolution(
      document({ [ENV.stateDir]: "/tmp/evil", NODE_OPTIONS: "--require /tmp/x.js", ELECTRON_RUN_AS_NODE: "1" }),
    );
    expect(resolved.set).toEqual({});
    expect(resolved.refused.map((entry) => entry.name).sort()).toEqual(
      ["ELECTRON_RUN_AS_NODE", ENV.stateDir, "NODE_OPTIONS"].sort(),
    );
  });

  it("refuses names that are not variable names, and values that are not text", () => {
    const resolved = projectEnvResolution(
      document({ "not a name": "x", "WITH\u0000NUL": "y", GOOD: "value\u0000" } as Record<string, string>),
    );
    expect(resolved.set).toEqual({});
    expect(resolved.refused).toHaveLength(3);
  });

  it("collects unset names, ignoring anything protected or also being set", () => {
    const resolved = projectEnvResolution(document({ KEEP: "1" }, ["STALE", "KEEP", "NODE_OPTIONS", "STALE"]));
    expect(resolved.unset).toEqual(["STALE"]);
  });
});

describe("parseProjectEnvDocument", () => {
  it("reads a valid document", () => {
    const parsed = parseProjectEnvDocument(JSON.stringify(document({ A: "1" }, ["B"])));
    expect(parsed).toEqual({ document: { version: 1, set: { A: "1" }, unset: ["B"] } });
  });

  it("explains unreadable output without quoting it", () => {
    const parsed = parseProjectEnvDocument("this is not json");
    expect(parsed).toEqual({ error: "The environment command did not return readable output." });
  });

  it("refuses a version it does not speak", () => {
    const parsed = parseProjectEnvDocument(JSON.stringify({ version: 99, set: {} }));
    expect("error" in parsed && parsed.error).toContain("version 99");
  });

  it("refuses a document whose shape is wrong", () => {
    expect(parseProjectEnvDocument(JSON.stringify({ version: 1, set: [] }))).toHaveProperty("error");
    expect(parseProjectEnvDocument(JSON.stringify({ version: 1, unset: {} }))).toHaveProperty("error");
    expect(parseProjectEnvDocument(JSON.stringify([1, 2, 3]))).toHaveProperty("error");
  });
});

describe("approval", () => {
  const base: ProjectEnvConfig = { enabled: true, command: "/usr/bin/helper", args: ["--project", "a"], required: true };

  it("treats the executable and its arguments as the material identity", () => {
    const approved: ProjectEnvConfig = { ...base, approvedFingerprint: projectEnvFingerprint(base) };
    expect(projectEnvApproved(approved)).toBe(true);

    // A different program, or different arguments, is a different decision.
    expect(projectEnvApproved({ ...approved, command: "/usr/bin/other" })).toBe(false);
    expect(projectEnvApproved({ ...approved, args: ["--project", "b"] })).toBe(false);
  });

  it("treats an unapproved configuration as unapproved", () => {
    expect(projectEnvApproved({ ...base })).toBe(false);
    expect(projectEnvApproved(undefined)).toBe(false);
  });

  it("does not require re-approval for an unrelated change", () => {
    const approved: ProjectEnvConfig = { ...base, approvedFingerprint: projectEnvFingerprint(base) };
    expect(projectEnvApproved({ ...approved, required: false })).toBe(true);
  });
});

describe("projectEnvWorkerConfig", () => {
  it("hands a worker the command, its arguments and the approval state", () => {
    const config: ProjectEnvConfig = { enabled: true, command: "helper", args: ["--x"], required: true };
    expect(projectEnvWorkerConfig({ ...config, approvedFingerprint: projectEnvFingerprint(config) })).toEqual({
      enabled: true,
      command: "helper",
      args: ["--x"],
      required: true,
      allowProviderKeys: [],
      approved: true,
    });
  });

  it("hands a worker nothing when the command is off or absent", () => {
    expect(projectEnvWorkerConfig(undefined)).toBeUndefined();
    expect(projectEnvWorkerConfig({ enabled: false, command: "helper", args: [], required: true })).toBeUndefined();
  });
});
