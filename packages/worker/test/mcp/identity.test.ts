import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PRODUCT_VERSION } from "@lasercode/protocol";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { adapterRoot } from "../../src/mcp/engine.js";
import { mcpClientIdentity } from "../../src/mcp/identity.js";
import { McpInspector } from "../../src/mcp/inspector.js";
import { IDENTITY_TRANSPORTS, identityFixture } from "./fixtures/client-identity.js";
import { startFixtureHttpServer } from "./fixtures/http-server.js";

const expected = (name?: string) => ({
  name: `${PRODUCT_NAME}-mcp${name ? `-${name}` : ""}`,
  title: PRODUCT_DISPLAY_NAME,
  version: PRODUCT_VERSION,
});

describe("MCP client identity on the wire", () => {
  it.each(IDENTITY_TRANSPORTS)("inspector: two server names over %s", async (transport) => {
    const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-identity-`));
    process.env["PI_CODING_AGENT_DIR"] = base;
    const fixture = await identityFixture(transport, base);
    const inspector = new McpInspector(base);
    try {
      for (const name of ["browser-one", "docs-two"]) {
        const result = await inspector.inspect({ scope: "global", config: fixture.config(name), secrets: new Map() });
        expect(result.status, result.detail).toBe("connected");
        await inspector.closeServer("global", name);
      }
      expect(fixture.received()).toEqual([expected("browser-one"), expected("docs-two")]);
      console.log(`received inspector ${transport}: ${JSON.stringify(fixture.received())}`);
    } finally {
      await inspector.dispose();
      await fixture.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("legacy endpoint probe sends the base identity after modern discovery is refused", async () => {
    const server = await startFixtureHttpServer();
    try {
      const jiti = createJiti(import.meta.url, { fsCache: false });
      const { probeMcpEndpoint } = await jiti.import<{ probeMcpEndpoint: (url: string, identity?: ReturnType<typeof mcpClientIdentity>) => Promise<{ isMcp: boolean }> }>(join(adapterRoot(), "mcp-probe.ts"));
      expect(await probeMcpEndpoint(server.url, mcpClientIdentity())).toMatchObject({ isMcp: true });
      expect(server.clientInfos).toEqual([expected()]);
      console.log(`received probe HTTP: ${JSON.stringify(server.clientInfos)}`);
      // Existing native consumers retain the adapter's historical default.
      await probeMcpEndpoint(server.url);
      expect(server.clientInfos[1]).toEqual({ name: "pi-mcp-probe", version: "2.1.2" });
    } finally {
      await server.close();
    }
  });

  it("installed adapter has no engine literal at any clientInfo or new Client site", () => {
    const sites: string[] = [];
    for (const file of readdirSync(adapterRoot()).filter((file) => file.endsWith(".ts"))) {
      const source = ts.createSourceFile(file, readFileSync(join(adapterRoot(), file), "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const isClient = ts.isNewExpression(node) && node.expression.getText(source) === "Client";
        const isInfo = ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === "clientInfo";
        if (isClient || isInfo) {
          const value = isClient ? (node as ts.NewExpression).arguments?.[0] : (node as ts.PropertyAssignment).initializer;
          const text = value?.getText(source) ?? "";
          expect(text, `${file}: ${text}`).not.toMatch(/pi-mcp/);
          sites.push(file);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(sites).toEqual(expect.arrayContaining(["server-manager.ts", "mcp-probe.ts", "mcp-auth-flow.ts"]));
  });
});
