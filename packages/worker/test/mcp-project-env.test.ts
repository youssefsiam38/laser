/**
 * MCP servers and the project environment (M16-T17).
 *
 * An MCP server is started by the engine, not by the shell tool, so it never
 * passes the spawn hook the project's commands do. Its environment is decided
 * when its entry is built, and these tests pin the three rules that keeps
 * honest.
 */
import { describe, expect, it } from "vitest";
import { toAdapterConfig } from "../src/mcp/adapter-config.js";
import type { McpConfiguredServer } from "@lasercode/protocol";

const stdio = (name: string, extra: Record<string, unknown> = {}): { config: McpConfiguredServer } => ({
  config: {
    name,
    transport: { kind: "stdio", command: "some-server", args: ["--serve"], ...extra },
  } as McpConfiguredServer,
});

/** A project that sets one variable and removes an inherited one. */
const projectEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...base };
  delete next["INHERITED_TOKEN"];
  next["PROJECT_DATABASE_URL"] = "postgres://project/db";
  return next;
};

describe("MCP servers and the project environment", () => {
  it("gives an inheriting stdio server the project's environment", () => {
    process.env["INHERITED_TOKEN"] = "from-the-launching-terminal";
    try {
      const config = toAdapterConfig([stdio("tools")], projectEnv);
      const entry = config.mcpServers["tools"]!;
      expect(entry.env?.["PROJECT_DATABASE_URL"]).toBe("postgres://project/db");
      // The point of taking the environment over in full: an `env` map can add
      // a name, but only this can take one away.
      expect(entry.env?.["INHERITED_TOKEN"]).toBeUndefined();
      expect(entry.inheritEnv).toBe(false);
      // The rest of the machine's environment is still there; this is not a
      // stripped-down shell.
      expect(entry.env?.["PATH"]).toBe(process.env["PATH"]);
    } finally {
      delete process.env["INHERITED_TOKEN"];
    }
  });

  it("leaves a server that asked for no inheritance exactly as configured", () => {
    const config = toAdapterConfig(
      [stdio("isolated", { inheritEnv: false, env: { ONLY: "this" } })],
      projectEnv,
    );
    const entry = config.mcpServers["isolated"]!;
    expect(entry.env).toEqual({ ONLY: "this" });
    expect(entry.env?.["PROJECT_DATABASE_URL"]).toBeUndefined();
    expect(entry.env?.["PATH"]).toBeUndefined();
  });

  it("lets a server's own configured value win over the project's", () => {
    const config = toAdapterConfig(
      [stdio("override", { env: { PROJECT_DATABASE_URL: "postgres://explicit/db" } })],
      projectEnv,
    );
    expect(config.mcpServers["override"]!.env?.["PROJECT_DATABASE_URL"]).toBe("postgres://explicit/db");
  });

  it("does not touch an http server, which starts no process", () => {
    const config = toAdapterConfig(
      [{ config: { name: "remote", transport: { kind: "http", url: "https://example.test/mcp" } } as McpConfiguredServer }],
      projectEnv,
    );
    const entry = config.mcpServers["remote"]!;
    expect(entry.env).toBeUndefined();
    expect(entry.inheritEnv).toBeUndefined();
  });

  it("changes nothing at all when the project has no environment command", () => {
    const withHook = toAdapterConfig([stdio("plain")], undefined);
    expect(withHook.mcpServers["plain"]!.env).toBeUndefined();
    expect(withHook.mcpServers["plain"]!.inheritEnv).toBeUndefined();
  });
});
