import { beforeEach, expect, it, vi } from "vitest";
import { detectImportSources } from "../../src/mcp/import.js";

const state = vi.hoisted(() => ({
  reads: new Map<string, (body: string) => void>(),
  discovered: [] as Array<{ kind: string; path: string }>,
}));
vi.mock("node:fs", () => ({ existsSync: (path: string) => path === "/synthetic-home/.config/mcp/mcp.json" }));
vi.mock("node:os", () => ({ homedir: () => "/synthetic-home" }));
vi.mock("node:fs/promises", () => ({ readFile: (path: string) => new Promise<string>(resolve => state.reads.set(path, resolve)) }));
vi.mock("pi-mcp-adapter/config", () => ({ findAvailableImportConfigs: () => state.discovered }));

const body = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "node", args: [] } } });
const openCodeBody = (name: string) => JSON.stringify({ mcp: { [name]: { type: "local", command: ["node"] } } });

beforeEach(() => {
  state.reads.clear();
  state.discovered = [];
});

it("reads independent Project candidates together but returns declared precedence order", async () => {
  const pending = detectImportSources("/synthetic-project", "project");
  expect([...state.reads.keys()]).toEqual(["/synthetic-project/.mcp.json", "/synthetic-home/.config/mcp/mcp.json"]);
  state.reads.get("/synthetic-home/.config/mcp/mcp.json")!(body("global"));
  await Promise.resolve();
  state.reads.get("/synthetic-project/.mcp.json")!(body("project"));
  expect((await pending).map(source => [source.id, source.servers[0]?.name])).toEqual([
    ["project-mcp-json", "project"],
    ["shared-global", "global"],
  ]);
});

it("omits project-relative sources from Global but includes them for Project", async () => {
  state.discovered = [
    { kind: "vscode", path: "/synthetic-project/.vscode/mcp.json" },
    { kind: "opencode", path: "/synthetic-project/opencode.json" },
  ];
  const globalPending = detectImportSources("/synthetic-project", "global");
  expect([...state.reads.keys()]).toEqual(["/synthetic-home/.config/mcp/mcp.json"]);
  state.reads.get("/synthetic-home/.config/mcp/mcp.json")!(body("global"));
  expect((await globalPending).map(source => source.id)).toEqual(["shared-global"]);

  state.reads.clear();
  const projectPending = detectImportSources("/synthetic-project", "project");
  expect([...state.reads.keys()]).toEqual([
    "/synthetic-project/.mcp.json",
    "/synthetic-home/.config/mcp/mcp.json",
    "/synthetic-project/.vscode/mcp.json",
    "/synthetic-project/opencode.json",
  ]);
  for (const [path, resolve] of state.reads) {
    resolve(path.endsWith("opencode.json") ? openCodeBody("open-code") : body(path.split("/").at(-2) ?? "source"));
  }
  expect((await projectPending).map(source => source.id)).toEqual(["project-mcp-json", "shared-global", "vscode", "opencode"]);
});

it("preserves upstream machine-global OpenCode precedence in both scopes", async () => {
  state.discovered = [{ kind: "opencode", path: "/synthetic-home/.config/opencode/opencode.json" }];
  for (const scope of ["global", "project"] as const) {
    state.reads.clear();
    const pending = detectImportSources("/synthetic-project", scope);
    expect([...state.reads.keys()]).toContain("/synthetic-home/.config/opencode/opencode.json");
    expect([...state.reads.keys()]).not.toContain("/synthetic-project/opencode.json");
    for (const [path, resolve] of state.reads) {
      resolve(path.endsWith("opencode.json") ? openCodeBody("machine-open-code") : body("other"));
    }
    const source = (await pending).find(candidate => candidate.id === "opencode");
    expect(source?.path).toBe("/synthetic-home/.config/opencode/opencode.json");
  }
});
