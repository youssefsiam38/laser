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
import { PRODUCT_NAME, type McpServerConfig } from "@lasercode/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpInspector } from "../../src/mcp/inspector.js";
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

    // Signing out removes what signing in stored, so the next connection is
    // refused again rather than silently reusing a credential.
    await inspector.authLogout("global", server_);
    const afterLogout = await inspector.inspect({ scope: "global", config: server_, secrets: new Map() });
    expect(afterLogout.status).toBe("needs-auth");
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
