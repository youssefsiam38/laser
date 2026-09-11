/**
 * M14-T2 · what a worker settles before anything loads the MCP engine.
 *
 * An MCP server is an ordinary program: `npx …`, `node …`. A packaged app runs
 * on its own bundled runtime with an empty PATH, so the runtime's bin
 * directory (and the bundled package manager's) are prepended once at start —
 * adding, never removing. The engine also finds its caches through the
 * environment rather than the SDK's `agentDir`, so the worker makes the two
 * agree before any of it is read.
 */
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alignEngineAgentDir, runtimePathAdditions } from "../../src/runtime-env.js";
import { McpInspector } from "../../src/mcp/inspector.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-start-`));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("runtimePathAdditions", () => {
  it("adds the runtime's own directory, never npm's internal bin", () => {
    const additions = runtimePathAdditions(
      { PATH: "/usr/bin", [ENV.npmCli]: "/opt/app/runtime/npm/bin/npm-cli.js" },
      "/opt/app/runtime/node",
    );
    expect(additions).toEqual(["/opt/app/runtime"]);
  });

  it("adds the runtime's directory even with no PATH at all", () => {
    expect(runtimePathAdditions({}, "/opt/app/runtime/node")).toEqual(["/opt/app/runtime"]);
  });

  it("never repeats a directory the person's PATH already has", () => {
    expect(runtimePathAdditions({ PATH: ["/opt/app/runtime", "/usr/bin"].join(delimiter) }, "/opt/app/runtime/node")).toEqual([]);
  });

  it("never adds internal directories from the command the host passes", () => {
    const additions = runtimePathAdditions(
      { PATH: "/usr/bin", [ENV.npmCommand]: JSON.stringify(["/opt/app/runtime/node", "/opt/app/runtime/npm/bin/npm-cli.js", "--no-audit"]) },
      "/opt/app/runtime/node",
    );
    expect(additions).toEqual(["/opt/app/runtime"]);
    expect(runtimePathAdditions({ PATH: "/usr/bin", [ENV.npmCommand]: "not json" }, "/opt/app/runtime/node")).toEqual(["/opt/app/runtime"]);
  });
});

describe("the engine's data directory", () => {
  it("follows the agent directory the worker was given, whatever the environment said", () => {
    const agentDir = join(base, "agent");
    process.env["PI_CODING_AGENT_DIR"] = join(base, "somewhere-else");
    alignEngineAgentDir(agentDir);
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(agentDir);
    // Relative paths are resolved, and an absent argument changes nothing.
    const previous = process.env["PI_CODING_AGENT_DIR"];
    alignEngineAgentDir(undefined);
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(previous);
  });

  it("follows the session directory too, and drops an inherited one the host did not name", () => {
    const agentDir = join(base, "agent");
    process.env["PI_CODING_AGENT_SESSION_DIR"] = join(base, "another-installation", "sessions");
    alignEngineAgentDir(agentDir, join(base, "sessions"));
    expect(process.env["PI_CODING_AGENT_SESSION_DIR"]).toBe(join(base, "sessions"));
    alignEngineAgentDir(agentDir);
    expect(process.env["PI_CODING_AGENT_SESSION_DIR"]).toBeUndefined();
  });


  it("is where the engine puts the caches an MCP server produces", async () => {
    const agentDir = join(base, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env["PI_CODING_AGENT_DIR"] = join(base, "wrong");
    alignEngineAgentDir(agentDir);
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    expect(getAgentDir()).toBe(agentDir);

    const inspector = new McpInspector(base);
    try {
      const inspection = await inspector.inspect({
        scope: "global",
        config: { name: "fixture", transport: { kind: "stdio", command: process.execPath, args: [FIXTURE] } },
        secrets: new Map(),
      });
      expect(inspection.status).toBe("connected");
    } finally {
      await inspector.dispose();
    }
    expect(existsSync(join(base, "wrong"))).toBe(false);
  }, 60_000);
});
