import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { McpStore } from "../../src/mcp/store.js";
import { McpService } from "../../src/mcp/service.js";
import { mcpSessionSetup } from "../../src/mcp/session.js";

// Capture the real guard passed at the adapter boundary. Configuration writes,
// registry transactions and session construction are real; no server is started.
interface Guard {
  authorization(name: string): Promise<string | undefined>;
  commitCredentials(name: string, save: () => void): Promise<string>;
}
const adapter = vi.hoisted(() => ({ create: vi.fn((_options: unknown) => () => {}) }));
vi.mock("../../src/mcp/engine.js", () => ({ loadMcpEngine: async () => ({ createMcpAdapter: adapter.create, statusEvent: "fixture-status" }) }));
let root: string, agentDir: string, a: string, b: string, store: McpStore;
const services: McpService[] = [];
const config = { name: "docs", transport: { kind: "stdio" as const, command: process.execPath, args: ["fixture-not-started.mjs"] } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), `${PRODUCT_NAME}-mcp-scopes-`));
  agentDir = join(root, "agent"); a = join(root, "a"); b = join(root, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  store = new McpStore(agentDir);
  await store.save("global", a, config);
  adapter.create.mockClear();
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  await rm(root, { recursive: true, force: true });
});
async function runtime(cwd: string): Promise<Guard> {
  await mcpSessionSetup({ cwd, agentDir, projectTrusted: true });
  return adapter.create.mock.calls.at(-1)![0] as Guard;
}
function settings(cwd: string): McpService {
  const service = new McpService({ cwd, agentDir, projectTrusted: true, changed: () => {} });
  services.push(service); return service;
}

it("revokes global stdio instances in different launch directories through either worker", async () => {
  const first = await runtime(a), second = await runtime(b);
  expect(await first.authorization("docs")).toBeUndefined();
  expect(await second.authorization("docs")).toBeUndefined();
  await settings(b).save({ cwd: b, scope: "global", server: { ...config, disabled: true } });
  expect(await first.authorization("docs")).toContain("Access to docs changed");
  expect(await second.authorization("docs")).toContain("Access to docs changed");
});

it("isolates project override/removal from another project and a local account at the same target", async () => {
  await store.save("project", a, { ...config, name: "local" });
  const first = await runtime(a), second = await runtime(b);
  const service = settings(a);
  await service.save({ cwd: a, scope: "project", server: { name: "docs", disabled: true } });
  expect(await first.authorization("docs")).toContain("changed");
  expect(await first.authorization("local")).toBeUndefined();
  expect(await second.authorization("docs")).toBeUndefined();
  await service.remove({ cwd: a, scope: "project", name: "docs" });
  expect(await first.authorization("docs")).toContain("changed");
  expect(await (await runtime(a)).authorization("docs")).toBeUndefined();
  expect(await second.authorization("docs")).toBeUndefined();
});

it("keeps a project replacement authorized when the shadowed global definition changes", async () => {
  const inherited = await runtime(a), other = await runtime(b);
  await settings(a).save({ cwd: a, scope: "project", server: { ...config, transport: { ...config.transport, args: ["replacement.mjs"] } } });
  expect(await inherited.authorization("docs")).toContain("changed");
  const replacement = await runtime(a);
  await settings(b).remove({ cwd: b, scope: "global", name: "docs" });
  expect(await other.authorization("docs")).toContain("changed");
  expect(await replacement.authorization("docs")).toBeUndefined();
});

it("advances only the credential target, not configuration guards or a distinct project's target", async () => {
  await store.save("project", a, { ...config, name: "local" });
  const initiating = await runtime(a), peer = await runtime(a), otherTarget = await runtime(b);
  let saves = 0;
  await initiating.commitCredentials("docs", () => { saves++; });
  expect(saves).toBe(1);
  expect(await initiating.authorization("docs")).toBeUndefined();
  expect(await peer.authorization("docs")).toContain("changed");
  expect(await peer.authorization("local")).toBeUndefined();
  expect(await otherTarget.authorization("docs")).toBeUndefined();
  await settings(b).save({ cwd: b, scope: "global", server: { ...config, disabled: true } });
  await expect(initiating.commitCredentials("docs", () => { saves++; })).rejects.toThrow("access changed");
  expect(saves).toBe(1);
});
