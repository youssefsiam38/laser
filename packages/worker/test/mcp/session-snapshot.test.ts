import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore } from "../../src/mcp/store.js";
import { mcpSessionSetup } from "../../src/mcp/session.js";

const adapter = vi.hoisted(() => ({ create: vi.fn((_options: unknown) => () => {}) }));
vi.mock("../../src/mcp/engine.js", () => ({ loadMcpEngine: async () => ({ createMcpAdapter: adapter.create, statusEvent: "fixture-status" }) }));
let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); adapter.create.mockClear(); if (root) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  root = mkdtempSync(join(tmpdir(), "mcp-snapshot-"));
  const options = { cwd: join(root, "project"), agentDir: join(root, "agent"), projectTrusted: true };
  mkdirSync(options.cwd);
  const store = new McpStore(options.agentDir);
  await store.save("global", options.cwd, { name: "docs", label: "Before", transport: { kind: "http", url: "https://before.example/mcp" } });
  return { options, store };
}
it("uses one validated snapshot for engine configuration and command attribution during a save", async () => {
  const { options } = await fixture();
  const original = McpStore.prototype.enabled;
  const reads = vi.spyOn(McpStore.prototype, "enabled").mockImplementationOnce(async function(this: McpStore, cwd, trust) {
    const snapshot = await original.call(this, cwd, trust);
    await this.save("global", cwd, { name: "docs", label: "After", transport: { kind: "http", url: "https://after.example/mcp" } });
    return snapshot;
  });
  const setup = await mcpSessionSetup(options);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(setup?.servers).toEqual([{ name: "docs", label: "Before" }]);
  expect(adapter.create.mock.calls[0]?.[0]).toMatchObject({ config: { mcpServers: { docs: { url: "https://before.example/mcp" } } } });
  const next = await mcpSessionSetup(options);
  expect(next?.servers).toEqual([{ name: "docs", label: "After" }]);
  expect(adapter.create.mock.calls[1]?.[0]).toMatchObject({ config: { mcpServers: { docs: { url: "https://after.example/mcp" } } } });
});
it("measures eliminating the redundant discovery before per-session adapter setup", async () => {
  const { options, store } = await fixture();
  const before: number[] = [], after: number[] = [];
  for (let i = 0; i < 20; i++) {
    let start = performance.now();
    await store.enabled(options.cwd, options.projectTrusted); // the previous duplicate discovery
    await mcpSessionSetup(options);
    before.push(performance.now() - start);
    start = performance.now(); await mcpSessionSetup(options); after.push(performance.now() - start);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[10];
  console.log(JSON.stringify({ finding: "F18", samples: 20, beforeMedianMs: median(before), afterMedianMs: median(after), before, after }));
});
