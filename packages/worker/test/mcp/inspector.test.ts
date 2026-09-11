/**
 * M14-T2 · the inspector against the real MCP engine and a deterministic
 * fixture server: what the server is, what its tools are, a ping, a call with
 * an image in the result, a failing call, a failure a person can read, and a
 * disconnect that takes the child process with it.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpInspector } from "../../src/mcp/inspector.js";
import { startFixtureHttpServer, type FixtureHttpServer } from "./fixtures/http-server.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");

let base: string;
let inspector: McpInspector;
let http: FixtureHttpServer;

const stdioConfig = (args: string[] = []) => ({
  name: "fixture",
  transport: { kind: "stdio" as const, command: process.execPath, args: [FIXTURE, ...args] },
  tools: { exposure: "direct" as const },
});

beforeAll(async () => {
  http = await startFixtureHttpServer();
});
afterAll(async () => {
  await http.close();
});

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-inspect-`));
  process.env["PI_CODING_AGENT_DIR"] = base;
  inspector = new McpInspector(base);
});

afterEach(async () => {
  await inspector.dispose();
  rmSync(base, { recursive: true, force: true });
});

/** Only this test's own child: other files run fixtures of their own. */
function childProcesses(marker: string): string[] {
  try {
    return execFileSync("pgrep", ["-af", marker], { encoding: "utf8" }).split("\n").filter((line) => line.includes("stdio-server.mjs"));
  } catch {
    return [];
  }
}

describe("McpInspector", () => {
  it("describes a stdio server: identity, capabilities, instructions, tools, resources and prompts", async () => {
    const inspection = await inspector.inspect({ scope: "global", config: stdioConfig(), secrets: new Map() });
    expect(inspection.status).toBe("connected");
    expect(inspection.server).toMatchObject({ name: "fixture", version: "1.2.3", title: "Fixture server" });
    expect(inspection.capabilities).toMatchObject({ tools: true, resources: true, prompts: true, toolListChanged: true });
    expect(inspection.instructions).toContain("Call echo");
    expect(inspection.protocolVersion).toBeTypeOf("string");
    expect(inspection.latencyMs).toBeGreaterThanOrEqual(0);

    const echo = inspection.tools.find((tool) => tool.originalName === "echo");
    expect(echo).toMatchObject({ name: "fixture_echo", visibility: "direct", approval: false, title: "Echo" });
    expect(echo?.description).toContain("Return the text");
    expect((echo?.inputSchema as { properties?: Record<string, unknown> })?.properties).toHaveProperty("text");
    expect(echo?.annotations).toMatchObject({ readOnly: true });

    expect(inspection.resources.map((resource) => [resource.name, resource.template ?? false])).toEqual(
      expect.arrayContaining([["notes", false], ["note", true]]),
    );
    expect(inspection.prompts[0]).toMatchObject({ name: "greet", arguments: [{ name: "who", required: true }] });
    expect(inspector.inspecting("global", "fixture")).toBe(true);
  }, 60_000);

  it("applies the server's tool policy to what the model would see", async () => {
    const inspection = await inspector.inspect({
      scope: "global",
      config: { ...stdioConfig(), tools: { exposure: "direct", only: ["echo"], exclude: ["explode"], approve: ["snap*"] } },
      secrets: new Map(),
    });
    const byName = new Map(inspection.tools.map((tool) => [tool.originalName, tool]));
    expect(byName.get("echo")).toMatchObject({ visibility: "direct", approval: false });
    expect(byName.get("snapshot")).toMatchObject({ visibility: "on-demand", approval: true });
    expect(byName.get("explode")).toMatchObject({ visibility: "excluded" });
  }, 60_000);

  it("pings, calls a tool with an image in the result, and reports a tool's own error", async () => {
    const config = stdioConfig();
    const ping = await inspector.ping("global", config, new Map());
    expect(ping.status).toBe("connected");
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);

    const echo = await inspector.call("global", config, new Map(), "fixture_echo", { text: "hi" });
    expect(echo.ok).toBe(true);
    expect(echo.content[0]).toEqual({ type: "text", text: "echo: hi" });

    const snapshot = await inspector.call("global", config, new Map(), "snapshot", {});
    expect(snapshot.content.map((block) => block.type)).toEqual(["text", "image"]);
    const image = snapshot.content[1] as { type: "image"; data: string; mimeType: string };
    expect(image.mimeType).toBe("image/png");
    expect(image.data.length).toBeGreaterThan(20);

    const failure = await inspector.call("global", config, new Map(), "explode", {});
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain("the fixture refused");
  }, 60_000);

  it("connects over Streamable HTTP", async () => {
    const inspection = await inspector.inspect({
      scope: "global",
      config: { name: "remote", transport: { kind: "http", url: http.url }, tools: { exposure: "direct" } },
      secrets: new Map(),
    });
    expect(inspection.status).toBe("connected");
    expect(inspection.server).toMatchObject({ name: "fixture-http" });
    expect(inspection.tools.map((tool) => tool.name)).toContain("remote_echo");
    const call = await inspector.call("global", { name: "remote", transport: { kind: "http", url: http.url } }, new Map(), "echo", { text: "over http" });
    expect(call.content[0]).toEqual({ type: "text", text: "echo: over http" });
  }, 60_000);

  it("writes a failure for a person, with the server's own words and its stderr", async () => {
    const inspection = await inspector.inspect({
      scope: "global",
      config: { name: "broken", transport: { kind: "stdio", command: process.execPath, args: [FIXTURE, "--stderr", "could not open the database", "--exit-early"] } },
      secrets: new Map(),
    });
    expect(inspection.status).toBe("failed");
    expect(inspection.detail).toContain("\"broken\" could not be reached");
    expect(inspection.detail).not.toContain("    at ");
    expect(inspection.stderr?.join(" ")).toContain("could not open the database");
  }, 60_000);

  it("says a turned-off server is off instead of connecting to it", async () => {
    const inspection = await inspector.inspect({ scope: "global", config: { ...stdioConfig(), disabled: true }, secrets: new Map() });
    expect(inspection.status).toBe("off");
    expect(inspection.detail).toContain("turned off");
    expect(inspector.inspecting("global", "fixture")).toBe(false);
  }, 60_000);

  it("closes the child process on disconnect", async () => {
    const marker = `mcp-disconnect-${process.pid}-${Date.now()}`;
    expect(childProcesses(marker)).toEqual([]);
    await inspector.inspect({ scope: "global", config: stdioConfig(["--name", marker]), secrets: new Map() });
    expect(childProcesses(marker)).toHaveLength(1);
    await inspector.closeServer("global", "fixture");
    expect(inspector.inspecting("global", "fixture")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(childProcesses(marker)).toEqual([]);
  }, 60_000);

  it("keeps an unsaved definition's connection only for the answer", async () => {
    const inspection = await inspector.inspect({ scope: "project", config: stdioConfig(), secrets: new Map(), ephemeral: true });
    expect(inspection.status).toBe("connected");
    expect(inspector.inspecting("project", "fixture")).toBe(false);
  }, 60_000);
});
