/**
 * Packaged-session acceptance probe.
 *
 * Importing Pi proves its compiled core is present. Opening a real session is
 * the stronger boundary: it makes the resource loader resolve and transpile
 * every bundled feature entry point, including TypeScript-only extensions.
 * The desktop clean-machine test runs this file with the packaged Node and an
 * otherwise empty environment.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";

import { DATA_DIR_NAME, PRODUCT_NAME, type PiExtensionModuleName } from "@lasercode/protocol";
import { DefinitionsCache } from "./agents/definitions.js";
import { AgentHarness } from "./agents/harness.js";
import { rootRecord, rootRole } from "./agents/session-config.js";
import { WorktreeManager } from "./agents/worktrees.js";
import { StableSdkDriver } from "./drivers/stable-sdk.js";
import type { DriverEvent } from "./driver.js";
import { WebSearchService } from "./web-search.js";
import { McpService } from "./mcp/service.js";
import { alignEngineAgentDir, extendRuntimePath } from "./runtime-env.js";

export type PackagedSessionReport =
  | { ok: true; sessionId: string; modelCount: number; modules: PiExtensionModuleName[]; mcp: { modelTool: string; inspectedTool: string; runtime: string; npxVersion: string } }
  | { ok: false; error: string };

/** The companion modules a packaged build must activate for a project session with every feature on. */
const REQUIRED_MODULES: readonly PiExtensionModuleName[] = ["subagents", "background-work", "file-freshness", "mcp"];

/** Offline model and search routes; expose only facts observed on the wire. */
async function startProbeServer() {
  let modelTools: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/v1/chat/completions") {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        const payload = JSON.parse(body) as { tools?: Array<{ function: { name: string } }> };
        modelTools = (payload.tools ?? []).map((tool) => tool.function.name);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const base = { id: "packaged-probe", object: "chat.completion.chunk", created: 1, model: "probe" };
        for (const choice of [
          { index: 0, delta: { role: "assistant", content: "Offline probe complete." }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: "stop" },
        ]) response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    if (new URL(request.url ?? "/", "http://localhost").pathname === "/search") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [{ title: "Packaged source", url: "https://example.com/source", content: "Search runtime verified" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    modelTools: () => modelTools,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export async function checkPackagedSession(fixture: string): Promise<PackagedSessionReport> {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-packaged-session-`));
  const driver = new StableSdkDriver();
  const mcp = new McpService({ cwd: join(root, "project"), agentDir: join(root, "agent"), changed: () => undefined });
  let probe: Awaited<ReturnType<typeof startProbeServer>> | undefined;
  try {
    for (const name of ["project", "agent", "sessions", "state"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    if (!fixture || !existsSync(fixture)) throw new Error("The packaged MCP fixture is missing.");
    // Exactly the worker startup path: no system Node is used for stdio.
    alignEngineAgentDir(join(root, "agent"), join(root, "sessions"));
    extendRuntimePath();
    // Offline: exercise the same bare command the gallery gives the worker.
    const npxVersion = (process.platform === "win32"
      ? execFileSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", "npx --version"], { encoding: "utf8", timeout: 20_000 })
      : execFileSync("npx", ["--version"], { encoding: "utf8", timeout: 20_000 })).trim();
    if (!/^\d+\.\d+\.\d+/.test(npxVersion)) throw new Error("The bundled package runner did not report its version.");
    mkdirSync(join(root, "agent", DATA_DIR_NAME), { recursive: true });
    writeFileSync(join(root, "agent", DATA_DIR_NAME, "mcp.json"), JSON.stringify({ version: 1, servers: [{
      name: "packaged", transport: { kind: "stdio", command: "node", args: [fixture] },
      tools: { exposure: "direct" }, startup: "at-start",
    }] }));
    probe = await startProbeServer();
    const { baseUrl } = probe;
    writeFileSync(join(root, "agent", "models.json"), JSON.stringify({ providers: {
      probe: { baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "offline-probe", models: [{ id: "probe", name: "Offline probe", contextWindow: 32000, maxTokens: 1000 }] },
    } }));
    let active: PiExtensionModuleName[] = [];
    driver.subscribe((event: DriverEvent) => {
      if (event.type === "extension" && event.message.type === "lasercode/capabilities") active = event.message.active;
    });
    // Open the session the way the worker does: as the default agent, with a
    // harness bridge, so the companion's agent modules have something to bind.
    const definitions = new DefinitionsCache();
    const definition = { ...definitions.defaultAgent(), model: { provider: "probe", id: "probe" } };
    const harness = new AgentHarness({
      host: { openChild: () => Promise.reject(new Error("no children in the probe")), driver: () => undefined, notify: () => undefined, modelAvailable: async () => false },
      definitions,
      worktrees: new WorktreeManager(),
    });
    const handle = harness.prepareSession({ role: rootRole(definition.name), definition, record: rootRecord(definition.name), projectCwd: join(root, "project") });
    const state = await driver.open({
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      projectTrusted: false,
      features: ["subagents", "goals", "web-search", "mcp"],
      agent: { definition, role: handle.role, record: handle.record, bridge: handle.bridge, policy: definitions.policy(), backgroundWork: { cwd: join(root, "project"), foregroundCommandSeconds: definitions.policy().foregroundCommandSeconds } },
    });
    handle.attach(state.path, state.id);
    const missing = REQUIRED_MODULES.filter((name) => !active.includes(name));
    if (missing.length > 0) throw new Error(`The companion extension did not activate ${missing.join(", ")} (active: ${active.join(", ") || "none"}).`);
    const models = await driver.listModels();
    // Inspect through the same service as mcp/inspect, then actually call the
    // tool: it reports the child executable, proving PATH selected our Node.
    const inspection = await mcp.inspect({ cwd: join(root, "project"), scope: "global", name: "packaged" });
    const inspectedTool = inspection.tools.find((tool) => tool.name === "packaged_runtime" && tool.originalName === "runtime");
    if (inspection.status !== "connected" || !inspectedTool) {
      throw new Error(`Packaged MCP inspection failed: ${JSON.stringify(inspection)}`);
    }
    const called = await mcp.call({ cwd: join(root, "project"), scope: "global", name: "packaged", tool: "runtime", args: {} });
    const runtime = called.content.find((block) => block.type === "text");
    if (runtime?.type !== "text" || runtime.text !== process.execPath) throw new Error("The MCP fixture did not run with the bundled Node.");
    // Capture the real provider request, not just a cached adapter catalogue.
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((done, fail) => {
      unsubscribe = driver.subscribe((event) => {
        if (event.type === "update" && event.update.kind === "agent_settled") done();
      });
      timer = setTimeout(() => fail(new Error("The offline model probe did not settle.")), 45_000);
    });
    try {
      await Promise.all([driver.prompt([{ type: "text", text: "Verify the packaged tools." }]), settled]);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    const modelTool = probe.modelTools().find((name) => name === inspectedTool.name);
    if (!modelTool) throw new Error(`The model did not receive ${inspectedTool.name} (tools: ${probe.modelTools().join(", ")}).`);
    const search = new WebSearchService(join(root, "agent"));
    await search.configure({ action: "configure", provider: "searxng", connection: { source: "none", baseUrl } });
    await search.configure({ action: "select", provider: "searxng" });
    const result = await search.search("packaged capability probe");
    if (!result.includes("Search runtime verified")) throw new Error("The packaged search runtime did not return its source.");
    if (!driver.deliverExtensionCommand({ type: "lasercode/account-usage/refresh" })) {
      throw new Error("The bundled subscription allowance module did not accept refresh.");
    }
    return { ok: true, sessionId: state.id, modelCount: models.length, modules: active, mcp: { modelTool, inspectedTool: inspectedTool.name, runtime: runtime.text, npxVersion } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await probe?.close();
    await driver.dispose().catch(() => undefined);
    await mcp.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => {
  const argv = process.argv[1];
  if (!argv) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(argv) === real(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) {
  const report = await checkPackagedSession(process.argv[2] ?? "");
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
