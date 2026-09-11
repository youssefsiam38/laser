/**
 * M14-T2 · the real thing, opt-in: a real MCP server from the network, in a
 * real session (docs/mcp.md "Verification"). Skipped unless the environment
 * asks for it, because CI has neither a network nor a browser:
 *
 *   LASERCODE_MCP_LIVE=1 pnpm -F @lasercode/worker exec vitest run test/mcp/live-playwright.test.ts
 *
 * (the variable is `ENV.mcpLive`; nothing in this file spells the product.)
 */
import { DATA_DIR_NAME, ENV, PRODUCT_NAME, type McpInspection, type McpServerConfig } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { McpService } from "../../src/mcp/service.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubProvider } from "../agents/stub-provider.js";

const live = process.env[ENV.mcpLive] === "1";

const PLAYWRIGHT: McpServerConfig = {
  name: "playwright",
  transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.80", "--headless", "--isolated"] },
  tools: { exposure: "direct" },
  startup: "on-demand",
};

let base: string;
let stub: StubProvider | undefined;
let driver: StableSdkDriver | undefined;
let service: McpService | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-live-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent", DATA_DIR_NAME), { recursive: true });
  process.env["PI_CODING_AGENT_DIR"] = join(base, "agent");
  writeFileSync(join(base, "agent", DATA_DIR_NAME, "mcp.json"), JSON.stringify({ version: 1, servers: [PLAYWRIGHT] }));
});

afterEach(async () => {
  await driver?.dispose().catch(() => {});
  await service?.dispose().catch(() => {});
  await stub?.close();
  driver = undefined;
  service = undefined;
  stub = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!live)("a real MCP server", () => {
  it("puts its tools in the model's request", async () => {
    stub = await startStubProvider(() => ({ text: "ok" }));
    writeStubModels(join(base, "agent"), stub.url);
    driver = new StableSdkDriver();
    const settled = new Promise<void>((resolve) => driver!.subscribe((event) => {
      if (event.type === "update" && event.update.kind === "agent_settled") resolve();
    }));
    await driver.open({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      projectTrusted: true,
      features: ["mcp"],
      agent: { definition: { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } }, role: rootRole("default"), record: rootRecord("default"), policy: fallbackPolicy() },
    });
    await driver.prompt([{ type: "text", text: "hello" }]);
    await settled;
    expect(toolNamesOf(stub.requests[0]!)).toContain("playwright_browser_navigate");
  }, 180_000);

  it("lists its tools with their input schemas through the inspector", async () => {
    service = new McpService({ cwd: join(base, "project"), agentDir: join(base, "agent"), projectTrusted: true, changed: () => {} });
    const inspection: McpInspection = await service.inspect({ cwd: join(base, "project"), scope: "global", name: "playwright" });
    expect(inspection.status).toBe("connected");
    expect(inspection.tools.length).toBeGreaterThanOrEqual(20);
    expect(inspection.tools.map((tool) => tool.name)).toContain("playwright_browser_navigate");
    expect(inspection.tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
    await service.disconnect({ cwd: join(base, "project"), scope: "global", name: "playwright" });
  }, 180_000);
});
