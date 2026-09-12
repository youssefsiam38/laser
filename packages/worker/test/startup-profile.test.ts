/** Opt-in real pinned-engine profile. No shared services or parallel opens. */
import { AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { fallbackDefaultAgent, fallbackPolicy } from "../src/agents/definitions.js";
import { rootRecord, rootRole } from "../src/agents/session-config.js";
import { startStubProvider, writeStubModels } from "./agents/stub-provider.js";

const trace = vi.hoisted(() => ({ sample: 0, rows: [] as Array<{ sample: number; stage: string; ms: number }> }));
vi.mock("../src/mcp/session.js", async importOriginal => {
  const module = await importOriginal<typeof import("../src/mcp/session.js")>();
  return { ...module, mcpSessionSetup: async (...args: Parameters<typeof module.mcpSessionSetup>) => {
    const start = performance.now();
    try { return await module.mcpSessionSetup(...args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "mcpSetup", ms: performance.now() - start }); }
  } };
});
let root: string | undefined;
let stub: Awaited<ReturnType<typeof startStubProvider>> | undefined;
const drivers: StableSdkDriver[] = [];
afterEach(async () => {
  for (const driver of drivers) await driver.dispose();
  await stub?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it.skipIf(process.env["PERF_STARTUP"] !== "1")("profiles cold and twenty sequential recovered runtimes with default features", async () => {
  root = mkdtempSync(join(tmpdir(), "startup-profile-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  for (const path of [cwd, agentDir, sessionDir, join(root, "home")]) mkdirSync(path, { recursive: true });
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  stub = await startStubProvider(() => ({ text: "fixture" }));
  writeStubModels(agentDir, stub.url);
  const paths = Array.from({ length: 21 }, () => {
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendModelChange("stub", "stub-1");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Saved startup fixture" }], timestamp: 1 });
    manager.flush(); return manager.getSessionFile()!;
  });
  const open = SessionManager.open;
  vi.spyOn(SessionManager, "open").mockImplementation(function(...args) {
    const start = performance.now();
    try { return open.apply(SessionManager, args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "sessionManagerLoad", ms: performance.now() - start }); }
  });
  const reload = DefaultResourceLoader.prototype.reload;
  vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function(...args) {
    const start = performance.now();
    try { return await reload.apply(this, args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "resourceDiscovery", ms: performance.now() - start }); }
  });
  const createModels = ModelRuntime.create;
  vi.spyOn(ModelRuntime, "create").mockImplementation(async function(...args) {
    const start = performance.now();
    try { return await createModels.apply(ModelRuntime, args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "modelAuthCreate", ms: performance.now() - start }); }
  });
  const refresh = ModelRuntime.prototype.refresh;
  vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async function(...args) {
    const start = performance.now();
    try { return await refresh.apply(this, args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "modelAuthRefresh", ms: performance.now() - start }); }
  });
  const bind = AgentSession.prototype.bindExtensions;
  vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function(...args) {
    const start = performance.now();
    try { return await bind.apply(this, args); }
    finally { trace.rows.push({ sample: trace.sample, stage: "extensionBinding", ms: performance.now() - start }); }
  });
  const totals: number[] = [];
  for (const [sample, path] of paths.entries()) {
    trace.sample = sample;
    const driver = new StableSdkDriver(); drivers.push(driver);
    const start = performance.now();
    const state = await driver.open({ cwd, agentDir, sessionDir, sessionPath: path, projectTrusted: true,
      features: ["subagents", "goals", "mcp"],
      agent: { definition: { ...fallbackDefaultAgent(), model: { provider: "stub", id: "stub-1" } }, role: rootRole("default"), record: rootRecord("default"), policy: fallbackPolicy() },
    });
    totals.push(performance.now() - start);
    expect(state.path).toBe(path);
    expect((await driver.listModels()).some(model => model.provider === "stub" && model.id === "stub-1")).toBe(true);
    await driver.dispose(); drivers.pop();
  }
  expect(stub.requests).toHaveLength(0);
  const report = { node: process.version, samples: 21, coldMs: totals[0], warmMedianMs: [...totals.slice(1)].sort((a, b) => a - b)[10], totals, stages: trace.rows };
  if (process.env["PERF_STARTUP_REPORT"]) writeFileSync(process.env["PERF_STARTUP_REPORT"], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}, 120_000);
