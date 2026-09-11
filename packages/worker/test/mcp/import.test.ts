/**
 * M14-T2 · reading what other tools left on this machine: each source's own
 * shape in Laser's vocabulary, inline credentials named rather than copied,
 * and a sentence for anything Laser cannot represent.
 */
import { describe, expect, it } from "vitest";
import { inlineSecretValues, translate } from "../../src/mcp/import.js";

describe("translate", () => {
  it("maps a command entry, marking the values that are credentials", () => {
    const server = translate("playwright", { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: { API_TOKEN: "abc", LOG: "debug" } }, "claude-code");
    expect(server?.config.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: { API_TOKEN: { secret: true }, LOG: "debug" },
    });
    expect(server?.inlineSecrets).toEqual(["transport.env.API_TOKEN"]);
    expect(server?.config.tools).toEqual({ exposure: "direct" });
    expect(inlineSecretValues({ command: "npx", env: { API_TOKEN: "abc" } }, "claude-code").get("transport.env.API_TOKEN")).toBe("abc");
  });

  it("maps a URL entry with an authorization header as a secret", () => {
    const server = translate("remote", { url: "https://example.test/mcp", headers: { Authorization: "Bearer abc", Accept: "application/json" }, type: "sse" }, "cursor");
    expect(server?.config.transport).toEqual({
      kind: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: { secret: true }, Accept: "application/json" },
      stream: "sse",
    });
    expect(server?.inlineSecrets).toEqual(["transport.headers.Authorization"]);
  });

  it("maps OpenCode's own shape", () => {
    const local = translate("local", { type: "local", command: ["node", "server.js"], environment: { SECRET_KEY: "s" } }, "opencode");
    expect(local?.config.transport).toMatchObject({ kind: "stdio", command: "node", args: ["server.js"] });
    const remote = translate("remote", { type: "remote", url: "https://example.test/mcp", oauth: { clientId: "id", clientSecret: "s" } }, "opencode");
    expect(remote?.config.auth).toMatchObject({ kind: "oauth", clientId: "id", clientSecret: { secret: true } });
    expect(remote?.inlineSecrets).toContain("auth.clientSecret");
    const off = translate("off", { type: "local", command: ["node"], enabled: false }, "opencode");
    expect(off?.config.disabled).toBe(true);
  });

  it("says what it could not bring across instead of importing something else", () => {
    const envToken = translate("codex", { url: "https://example.test/mcp", bearer_token_env_var: "MY_TOKEN" }, "codex");
    expect(envToken?.unsupported).toContain("environment variable");
    const signing = translate("signed", { url: "https://example.test/mcp", requestHeadersCommand: { command: "sign" } }, "vscode");
    expect(signing?.unsupported).toContain("external command");
    const authOnCommand = translate("weird", { command: "node", auth: "oauth" }, "cursor");
    expect(authOnCommand?.config.auth).toBeUndefined();
    expect(authOnCommand?.unsupported).toContain("HTTP servers only");
    const empty = translate("nothing", { note: "hi" }, "cursor");
    expect(empty?.unsupported).toContain("nothing to connect to");
  });

  it("makes a foreign name usable and refuses one that cannot be", () => {
    expect(translate("my server!", { command: "node" }, "cursor")?.name).toBe("my-server-");
    expect(translate("***", { command: "node" }, "cursor")).toBeUndefined();
  });
});
