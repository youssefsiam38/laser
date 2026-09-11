import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectionDefinition, McpService } from "../../src/mcp/service.js";
import { startFixtureOAuthServer } from "./fixtures/oauth-server.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");
const fixture = { name: "fixture", transport: { kind: "stdio" as const, command: process.execPath, args: [FIXTURE] }, tools: { exposure: "direct" as const } };
let root: string;
let cwd: string;
let service: McpService;
const changed = vi.fn();
const named = () => ({ cwd, scope: "project" as const, name: "fixture" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mcp-service-`));
  cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  vi.stubEnv("PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", "1");
  changed.mockClear();
  service = new McpService({ cwd, agentDir: join(root, "agent"), projectTrusted: true, changed });
});
afterEach(async () => { await service.dispose(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("inspection status in the saved list", () => {
  it("remembers Test → Add, including counts under the policy chosen after Test", async () => {
    const result = await service.inspect({ cwd, scope: "project", server: fixture });
    expect(result.status).toBe("connected");
    expect(changed).not.toHaveBeenCalled();
    const saved = await service.save({ cwd, scope: "project", server: { ...fixture, tools: { exposure: "on-demand" } } });
    expect(saved.servers[0]).toMatchObject({ status: "ready", toolCount: 3, directToolCount: 0, resourceCount: 1, promptCount: 1 });
    expect(saved.servers[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(saved.servers[0]?.inspecting).toBeUndefined();
  }, 60_000);

  it("notifies once for inspection, not again for identical status, then on disconnect", async () => {
    await service.save({ cwd, scope: "project", server: fixture });
    changed.mockClear();
    await service.inspect(named());
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await service.list()).servers[0]).toMatchObject({ status: "connected", inspecting: true, toolCount: 3 });
    await service.inspect(named());
    await service.ping(named());
    expect(changed).toHaveBeenCalledTimes(1);
    await service.disconnect(named());
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await service.list()).servers[0]).toMatchObject({ status: "ready", toolCount: 3 });
    await service.disconnect(named());
    expect(changed).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("closes a failed ping's held connection and reports failure with detail", async () => {
    await service.save({ cwd, scope: "project", server: { ...fixture, transport: { ...fixture.transport, args: [FIXTURE, "--fail-ping"] } } });
    await service.inspect(named());
    changed.mockClear();
    expect(await service.ping(named())).toMatchObject({ status: "failed", detail: expect.stringContaining("the fixture refused the ping") });
    expect(changed).toHaveBeenCalledTimes(1);
    const row = (await service.list()).servers[0];
    expect(row).toMatchObject({ status: "failed", toolCount: 3, detail: expect.stringContaining("the fixture refused the ping") });
    expect(row?.inspecting).toBeUndefined();
    await service.inspect(named());
    expect((await service.list()).servers[0]).toMatchObject({ status: "connected" });
    expect((await service.list()).servers[0]?.detail).toBeUndefined();
  }, 60_000);

  it("uses held connection → session snapshot → remembered inspection", async () => {
    await service.save({ cwd, scope: "project", server: fixture });
    await service.inspect(named());
    service.observeSnapshot("session", { servers: [{ name: "fixture", status: "ready", toolCount: 7, directToolCount: 2 }], totalTools: 7, connectedCount: 0 });
    expect((await service.list()).servers[0]).toMatchObject({ status: "connected", toolCount: 3 });
    await service.disconnect(named());
    expect((await service.list()).servers[0]).toMatchObject({ status: "ready", toolCount: 7 });
    service.sessionClosed("session");
    expect((await service.list()).servers[0]).toMatchObject({ status: "ready", toolCount: 3 });
  }, 60_000);

  it("does not inherit a Test for a different transport, nor keep memory across removal", async () => {
    await service.inspect({ cwd, scope: "project", server: fixture });
    await service.save({ cwd, scope: "project", server: { ...fixture, transport: { kind: "stdio", command: "different-command" } } });
    expect((await service.list()).servers[0]?.status).toBe("unknown");
    await service.inspect(named());
    expect((await service.list()).servers[0]?.status).toBe("failed");
    await service.remove(named());
    await service.save({ cwd, scope: "project", server: { ...fixture, transport: { kind: "stdio", command: "different-command" } } });
    expect((await service.list()).servers[0]?.status).toBe("unknown");
  }, 60_000);

  it("reports needs-auth honestly, and notifies after sign-in completion and logout", async () => {
    const oauth = await startFixtureOAuthServer();
    try {
      const config = { name: "fixture", transport: { kind: "http" as const, url: oauth.url }, auth: { kind: "oauth" as const } };
      await service.save({ cwd, scope: "project", server: config });
      changed.mockClear();
      await service.inspect(named());
      expect((await service.list()).servers[0]).toMatchObject({ status: "needs-auth" });
      expect((await service.list()).servers[0]?.inspecting).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(1);
      const started = await service.authStart(named());
      expect(started.callbackListening).toBe(true);
      const authorization = new URL(started.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "code-1");
      const complete = await service.authComplete({ ...named(), redirectUrl: callback.toString() });
      expect(complete.status).toBe("ready");
      expect(changed).toHaveBeenCalledTimes(2);
      expect((await service.list()).servers[0]?.status).toBe("ready");
      await service.inspect(named());
      expect(changed).toHaveBeenCalledTimes(3);
      await service.authLogout(named());
      expect(changed).toHaveBeenCalledTimes(4);
      expect((await service.list()).servers[0]).toMatchObject({ status: "needs-auth", toolCount: 1 });
      await service.authLogout(named());
      expect(changed).toHaveBeenCalledTimes(4);
    } finally { await oauth.close(); }
  }, 60_000);

  it("keys drafts deterministically without secret values, names or tool policy", () => {
    const first = { name: "a", transport: { kind: "http" as const, url: "https://example.test/mcp", headers: { Token: { secret: true as const, value: "one" }, X: "plain" } } };
    const second = { name: "b", transport: { headers: { X: "plain", Token: { secret: true as const, value: "two", present: true } }, url: "https://example.test/mcp", kind: "http" as const } };
    expect(inspectionDefinition(first)).toBe(inspectionDefinition(second));
    expect(inspectionDefinition({ ...first, transport: { ...first.transport, url: "https://other.test/mcp" } })).not.toBe(inspectionDefinition(first));
  });
});
