/**
 * M14-T2 · Laser's server vocabulary onto the engine's. Every transport,
 * every sign-in, every startup mode and every exposure, plus the settings
 * Laser fixes so the engine never discovers configuration of its own.
 */
import type { McpServerConfig } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { prefixedToolName, secretFieldPaths, toAdapterConfig, toServerEntry } from "../../src/mcp/adapter-config.js";

const stdio = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "fixture",
  transport: { kind: "stdio", command: "node", args: ["server.mjs"] },
  ...extra,
});

describe("toServerEntry", () => {
  it("maps a stdio transport with environment, working directory and inheritance", () => {
    const entry = toServerEntry({
      name: "fixture",
      transport: {
        kind: "stdio",
        command: "node",
        args: ["server.mjs", "--headless"],
        env: { PLAIN: "value", TOKEN: { secret: true } },
        cwd: "/tmp/project",
        inheritEnv: false,
      },
    }, new Map([["transport.env.TOKEN", "resolved"]]));
    expect(entry).toMatchObject({
      command: "node",
      args: ["server.mjs", "--headless"],
      env: { PLAIN: "value", TOKEN: "resolved" },
      cwd: "/tmp/project",
      inheritEnv: false,
    });
    expect(entry.url).toBeUndefined();
  });

  it("leaves a secret with no stored value unset rather than inventing one", () => {
    const entry = toServerEntry({
      name: "fixture",
      transport: { kind: "stdio", command: "node", env: { TOKEN: { secret: true } } },
    });
    expect(entry.env).toBeUndefined();
  });

  it("maps HTTP with headers, a forced stream and a CA bundle", () => {
    const entry = toServerEntry({
      name: "remote",
      transport: { kind: "http", url: "https://example.test/mcp", headers: { "X-Key": { secret: true } }, stream: "sse", caFile: "/etc/ca.pem" },
    }, new Map([["transport.headers.X-Key", "value"]]));
    expect(entry).toMatchObject({ url: "https://example.test/mcp", headers: { "X-Key": "value" }, httpTransport: "sse", caFile: "/etc/ca.pem" });
  });

  it("negotiates when the stream is automatic or unset", () => {
    expect(toServerEntry({ name: "r", transport: { kind: "http", url: "u", stream: "auto" } }).httpTransport).toBeUndefined();
    expect(toServerEntry({ name: "r", transport: { kind: "http", url: "u" } }).httpTransport).toBeUndefined();
    expect(toServerEntry({ name: "r", transport: { kind: "http", url: "u", stream: "streamable-http" } }).httpTransport).toBe("streamable-http");
  });

  it("maps a socket transport", () => {
    expect(toServerEntry({ name: "muxed", transport: { kind: "socket", path: "/run/mcp.sock" } })).toMatchObject({ socket: "/run/mcp.sock" });
  });

  it("maps every kind of sign-in", () => {
    expect(toServerEntry({ name: "r", transport: { kind: "http", url: "u" }, auth: { kind: "none" } }).auth).toBe(false);
    const bearer = toServerEntry({ name: "r", transport: { kind: "http", url: "u" }, auth: { kind: "bearer", token: { secret: true } } }, new Map([["auth.token", "abc"]]));
    expect(bearer).toMatchObject({ auth: "bearer", bearerToken: "abc" });
    const oauth = toServerEntry({
      name: "r",
      transport: { kind: "http", url: "u" },
      auth: { kind: "oauth", clientId: "id", clientSecret: { secret: true }, scope: "read", redirectUri: "http://127.0.0.1/cb", authServerMetadataUrl: "https://issuer/.well-known", grantType: "client_credentials" },
    }, new Map([["auth.clientSecret", "sec"]]));
    expect(oauth).toMatchObject({
      auth: "oauth",
      oauth: { clientId: "id", clientSecret: "sec", scope: "read", redirectUri: "http://127.0.0.1/cb", authServerMetadataUrl: "https://issuer/.well-known", grantType: "client_credentials" },
    });
  });

  it("maps every startup mode", () => {
    expect(toServerEntry(stdio({ startup: "on-demand" })).lifecycle).toBe("lazy");
    expect(toServerEntry(stdio({ startup: "on-demand-keep" })).lifecycle).toBe("lazy-keep-alive");
    expect(toServerEntry(stdio({ startup: "at-start" })).lifecycle).toBe("eager");
    expect(toServerEntry(stdio({ startup: "always" })).lifecycle).toBe("keep-alive");
    expect(toServerEntry(stdio()).lifecycle).toBeUndefined();
  });

  it("maps every exposure and the tool lists", () => {
    expect(toServerEntry(stdio({ tools: { exposure: "direct" } })).directTools).toBe(true);
    expect(toServerEntry(stdio({ tools: { exposure: "direct", only: ["echo"] } })).directTools).toEqual(["echo"]);
    expect(toServerEntry(stdio({ tools: { exposure: "on-demand" } })).directTools).toBe(false);
    expect(toServerEntry(stdio({ tools: { exposure: "search" } })).directTools).toBe("search");
    expect(toServerEntry(stdio({ tools: { exposure: "direct", include: ["a*"], exclude: ["ab"], approve: ["danger*"] } }))).toMatchObject({
      includeTools: ["a*"],
      excludeTools: ["ab"],
      approveTools: ["danger*"],
    });
    expect(toServerEntry(stdio({ tools: { exposure: "direct", approve: true } })).approveTools).toBe(true);
    expect(toServerEntry(stdio({ tools: { exposure: "direct", approve: false } })).approveTools).toBeUndefined();
  });

  it("passes the remaining settings straight across", () => {
    expect(toServerEntry(stdio({ idleMinutes: 5, requestTimeoutMs: 1000, protocolVersion: "auto", resourcesAsTools: false, debug: true, disabled: true }))).toMatchObject({
      idleTimeout: 5,
      requestTimeoutMs: 1000,
      protocolVersion: "auto",
      exposeResources: false,
      debug: true,
      disabled: true,
    });
  });

  it("fixes the engine's own settings and never leaves discovery on", () => {
    const config = toAdapterConfig([{ config: stdio() }]);
    expect(config.settings).toEqual({
      toolPrefix: "server",
      showStatusIcon: false,
      mcpFooterStatus: "off",
      notifyOnStartupConnect: false,
      hostConfigDiscovery: "off",
      autoAuth: false,
      sampling: true,
      elicitation: true,
      scriptMode: true,
    });
    expect(Object.keys(config.mcpServers)).toEqual(["fixture"]);
    expect(config.imports).toBeUndefined();
    expect(config.claudePlugins).toBeUndefined();
  });

  it("names every field a secret can sit at", () => {
    expect(secretFieldPaths({
      name: "r",
      transport: { kind: "http", url: "u", headers: { "X-Key": { secret: true }, Accept: "json" } },
      auth: { kind: "oauth", clientSecret: { secret: true } },
    })).toEqual(["transport.headers.X-Key", "auth.clientSecret"]);
    expect(secretFieldPaths(stdio({ transport: { kind: "stdio", command: "node", env: { TOKEN: { secret: true }, HOME: "/tmp" } } }))).toEqual(["transport.env.TOKEN"]);
  });

  it("prefixes a tool name the way the engine does", () => {
    expect(prefixedToolName("playwright", "browser_navigate")).toBe("playwright_browser_navigate");
    // The engine keeps the server name verbatim and sanitises the tool's own
    // dots; the prefix is not invented here.
    expect(prefixedToolName("my-server", "do.thing")).toBe("my-server_do_thing");
  });
});
