/**
 * M14-T2 · signing in to an MCP server, offline, through the real engine.
 *
 * The whole flow runs for real — protected-resource discovery, dynamic client
 * registration, the authorization URL, the code exchange, the credential store
 * — against a fixture server that demands a bearer token. Only the credential
 * store is swapped for the engine's in-memory one, so no OS keyring is touched.
 *
 * This is the test that pins the defect it was written for: the credential is
 * accounted under the *server's name*, so the inspector must connect the engine
 * manager under that same name. Connecting under anything else (a scoped key,
 * say) leaves a signed-in server stuck on `needs-auth` and makes sign-out
 * remove nothing.
 */
import { HOMEPAGE, PRODUCT_DISPLAY_NAME, PRODUCT_NAME, type McpServerConfig } from "@lasercode/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJiti } from "jiti";
import { McpInspector } from "../../src/mcp/inspector.js";
import * as engineModule from "../../src/mcp/engine.js";
import type { McpAuthFlow } from "../../src/mcp/engine.js";
import { expectedClientInfo } from "./fixtures/client-identity.js";
import { mcpClientIdentity } from "../../src/mcp/identity.js";
import { startFixtureOAuthServer, type FixtureOAuthServer } from "./fixtures/oauth-server.js";

let base: string;
let server: FixtureOAuthServer;
let inspector: McpInspector;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-oauth-`));
  process.env["PI_CODING_AGENT_DIR"] = base;
  // The engine's own test store: credentials live in this process only.
  process.env["PI_MCP_ADAPTER_TEST_AUTH_STORE"] = "memory";
  process.env["PI_MCP_ADAPTER_DISABLE_AUTH_CACHE"] = "1";
  server = await startFixtureOAuthServer();
  inspector = new McpInspector(base);
});

afterEach(async () => {
  await inspector.dispose();
  await server.close();
  delete process.env["PI_MCP_ADAPTER_TEST_AUTH_STORE"];
  delete process.env["PI_MCP_ADAPTER_DISABLE_AUTH_CACHE"];
  rmSync(base, { recursive: true, force: true });
});

function config(): McpServerConfig & { transport: { kind: "http"; url: string } } {
  return {
    name: "gated",
    transport: { kind: "http", url: server.url },
    auth: { kind: "oauth" },
    tools: { exposure: "direct" },
  };
}

/** The redirect the browser would land on, built from the authorization URL. */
function callbackUrl(authorizationUrl: string, code: string): string {
  const authorization = new URL(authorizationUrl);
  const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("code", code);
  const state = authorization.searchParams.get("state");
  if (state) redirect.searchParams.set("state", state);
  return redirect.toString();
}

describe("signing in to an MCP server", () => {
  it("says a server needs sign-in, signs it in, connects, and forgets it again", async () => {
    const server_ = config();

    // Before sign-in the server answers nothing; the person is told what to do.
    const before = await inspector.inspect({ scope: "global", config: server_, secrets: new Map() });
    expect(before.status).toBe("needs-auth");
    expect(before.detail).toContain("needs you to sign in");

    // Start: an authorization URL for the app to open, and the engine's own
    // loopback listener waiting for the callback. Nothing opened a browser.
    const started = await inspector.authStart("global", server_, new Map(), () => {});
    expect(started.alreadyAuthorized).toBeUndefined();
    expect(started.authorizationUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    expect(started.callbackListening).toBe(true);

    // Finish it the way a remote or headless person does: paste the address.
    const completed = await inspector.authComplete("global", server_, callbackUrl(started.authorizationUrl, "code-1"));
    expect(completed.status).toBe("ready");
    expect(completed.detail).toContain("Conversations already running keep the servers they started with");
    expect(server.tokenGrants).toBeGreaterThan(0);

    // The credential the flow stored is the one the connection finds: this is
    // the whole point of keying the engine manager by the server's own name.
    const after = await inspector.inspect({ scope: "global", config: server_, secrets: new Map() });
    expect(after.status).toBe("connected");
    expect(after.server).toMatchObject({ name: "fixture-oauth" });
    expect(after.tools.map((tool) => tool.name)).toEqual(["gated_whoami"]);

    const called = await inspector.call("global", server_, new Map(), "gated_whoami", {});
    expect(called.ok).toBe(true);

    expect(server.registrations.length).toBeGreaterThan(0);
    for (const registration of server.registrations) {
      expect(registration).toMatchObject({ client_name: PRODUCT_DISPLAY_NAME, client_uri: HOMEPAGE });
    }
    const expected = [expectedClientInfo(), expectedClientInfo("gated")];
    expect(server.clientInfos).toEqual(expect.arrayContaining(expected));
    for (const info of server.clientInfos) expect(expected).toContainEqual(info);
    console.log(`received OAuth discovery/connections: ${JSON.stringify(server.clientInfos)}`);
    console.log(`received OAuth registration: ${JSON.stringify(server.registrations.map(({ client_name, client_uri }) => ({ client_name, client_uri })))}`);

    // Signing out removes what signing in stored, so the next connection is
    // refused again rather than silently reusing a credential.
    await inspector.authLogout("global", server_);
    const afterLogout = await inspector.inspect({ scope: "global", config: server_, secrets: new Map() });
    expect(afterLogout.status).toBe("needs-auth");
  }, 60_000);

  it("owns an identity-bearing runtime even when logout is the first operation", async () => {
    const engine = await engineModule.loadMcpEngine();
    // jiti's live export proxy cannot be spied on directly. Wrap only this
    // boundary while still delegating to the actual OAuth implementation.
    const removeAuth = vi.fn(engine.auth.removeAuth);
    const load = vi.spyOn(engineModule, "loadMcpEngine").mockResolvedValue({ ...engine, auth: { ...engine.auth, removeAuth } });
    try {
      await inspector.authLogout("global", config());
      expect(removeAuth).toHaveBeenCalledOnce();
      expect(removeAuth.mock.calls[0]?.[1]?.runtime).toMatchObject({ clientIdentity: mcpClientIdentity() });
      expect(server.clientInfos).toEqual([]);
      expect(inspector.inspecting("global", "gated")).toBe(false);
    } finally {
      load.mockRestore();
    }
  });

  it("preserves native OAuth discovery defaults when no identity is supplied", async () => {
    const jiti = createJiti(import.meta.url, { fsCache: false });
    type NativeAuth = Omit<McpAuthFlow, "createOAuthRuntime"> & { createOAuthRuntime(signal?: AbortSignal): unknown };
    const auth = await jiti.import<NativeAuth>(join(engineModule.adapterRoot(), "mcp-auth-flow.ts"));
    const runtime = auth.createOAuthRuntime();
    try {
      await auth.startAuth("native-discovery", server.url, { url: server.url, auth: "oauth" }, {
        runtime, openAuthorizationUrl: () => {}, onAuthorizationUrl: () => {},
      });
      expect(server.clientInfos).toEqual([{ name: "pi-mcp-adapter", version: "2.11.0" }]);
      console.log(`received native OAuth discovery: ${JSON.stringify(server.clientInfos)}`);
    } finally {
      await auth.shutdownOAuth(runtime);
    }
  }, 60_000);

  it.each(["GET", "DELETE"])("challenges unauthenticated %s requests before checking the method", async (method) => {
    const response = await fetch(server.url, { method });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${new URL(server.url).origin}/.well-known/oauth-protected-resource"`);
    await response.arrayBuffer();
  });

  it("honours explicit server OAuth registration metadata over the application defaults", async () => {
    const engine = await engineModule.loadMcpEngine();
    const runtime = engine.auth.createOAuthRuntime(undefined, mcpClientIdentity());
    try {
      await engine.auth.startAuth("custom-registration", server.url, {
        url: server.url, auth: "oauth", oauth: { clientName: "Custom application", clientUri: "https://custom.example/app" },
      }, { runtime, openAuthorizationUrl: () => {}, onAuthorizationUrl: () => {} });
      expect(server.registrations.length).toBeGreaterThan(0);
      for (const registration of server.registrations) {
        expect(registration).toMatchObject({ client_name: "Custom application", client_uri: "https://custom.example/app" });
      }
    } finally {
      await engine.auth.shutdownOAuth(runtime);
    }
  }, 60_000);

  it("refuses sign-in for a server that does not sign in, and closes a draft that needs it", async () => {
    await expect(
      inspector.authStart("global", { name: "local", transport: { kind: "stdio", command: process.execPath } }, new Map(), () => {}),
    ).rejects.toThrow(/does not sign in with OAuth/);

    const draft = await inspector.inspect({ scope: "project", config: config(), secrets: new Map(), ephemeral: true });
    expect(draft.status).toBe("needs-auth");
    // A draft never outlives its answer, sign-in or no sign-in.
    expect(inspector.inspecting("project", "gated")).toBe(false);
  }, 60_000);
});
