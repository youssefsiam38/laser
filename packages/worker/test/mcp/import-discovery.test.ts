import { expect, it, vi } from "vitest";
import { detectImportSources } from "../../src/mcp/import.js";
const reads = vi.hoisted(() => new Map<string, (body: string) => void>());
vi.mock("node:fs", () => ({ existsSync: (path: string) => path === "/synthetic-home/.config/mcp/mcp.json" }));
vi.mock("node:os", () => ({ homedir: () => "/synthetic-home" }));
vi.mock("node:fs/promises", () => ({ readFile: (path: string) => new Promise<string>(resolve => reads.set(path, resolve)) }));
vi.mock("pi-mcp-adapter/config", () => ({ findAvailableImportConfigs: () => [] }));
it("reads independent candidates together but merges in declared precedence order", async () => {
  const pending = detectImportSources("/synthetic-project");
  expect([...reads.keys()]).toEqual(["/synthetic-project/.mcp.json", "/synthetic-home/.config/mcp/mcp.json"]);
  const body = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "node", args: [] } } });
  reads.get("/synthetic-home/.config/mcp/mcp.json")!(body("global"));
  await Promise.resolve();
  reads.get("/synthetic-project/.mcp.json")!(body("project"));
  expect((await pending).map(source => [source.id, source.servers[0]?.name])).toEqual([["project-mcp-json", "project"], ["shared-global", "global"]]);
});
