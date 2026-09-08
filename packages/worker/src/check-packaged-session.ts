/**
 * Packaged-session acceptance probe.
 *
 * Importing Pi proves its compiled core is present. Opening a real session is
 * the stronger boundary: it makes the resource loader resolve and transpile
 * every bundled feature entry point, including TypeScript-only extensions.
 * The desktop clean-machine test runs this file with the packaged Node and an
 * otherwise empty environment.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";

import { PRODUCT_NAME, type PiExtensionModuleName } from "@lasercode/protocol";
import { beamSkillPath, ensureBeamSkill } from "./agents/beam-skill.js";
import { DefinitionsCache } from "./agents/definitions.js";
import { AgentHarness } from "./agents/harness.js";
import { rootRecord, rootRole } from "./agents/session-config.js";
import { WorktreeManager } from "./agents/worktrees.js";
import { StableSdkDriver } from "./drivers/stable-sdk.js";
import type { DriverEvent } from "./driver.js";
import { WebSearchService } from "./web-search.js";

export type PackagedSessionReport =
  | { ok: true; sessionId: string; modelCount: number; modules: PiExtensionModuleName[]; beamSkillPath: string; beamSkillBytes: number }
  | { ok: false; error: string };

/** The companion modules a packaged build must activate for a project session with every feature on. */
const REQUIRED_MODULES: readonly PiExtensionModuleName[] = ["subagents", "background-work"];

export async function checkPackagedSession(): Promise<PackagedSessionReport> {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-packaged-session-`));
  const driver = new StableSdkDriver();
  const searchServer = createServer((_req, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: [{ title: "Packaged source", url: "https://example.com/source", content: "Search runtime verified" }] }));
  });
  try {
    for (const name of ["project", "agent", "sessions", "state"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    // The worker writes the Beam skill on start; the packaged build must be able to.
    const beamSkill = ensureBeamSkill({ agentDir: join(root, "agent"), stateDir: join(root, "state") });
    if (!existsSync(beamSkillPath(join(root, "agent")))) throw new Error("The Beam skill was not written under the agent directory.");
    // Measured here, inside the sandbox this check removes on exit: the gate
    // that reads the report cannot stat a directory that no longer exists.
    const beamSkillBytes = statSync(beamSkill).size;
    if (beamSkillBytes === 0) throw new Error("The Beam skill was written empty.");

    let active: PiExtensionModuleName[] = [];
    driver.subscribe((event: DriverEvent) => {
      if (event.type === "extension" && event.message.type === "lasercode/capabilities") active = event.message.active;
    });
    // Open the session the way the worker does: as the default agent, with a
    // harness bridge, so the companion's agent modules have something to bind.
    const definitions = new DefinitionsCache();
    const definition = definitions.defaultAgent();
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
      features: ["subagents", "goals", "web-search"],
      agent: { definition, role: handle.role, record: handle.record, bridge: handle.bridge, policy: definitions.policy(), backgroundWork: { cwd: join(root, "project"), foregroundCommandSeconds: definitions.policy().foregroundCommandSeconds } },
    });
    handle.attach(state.path, state.id);
    const missing = REQUIRED_MODULES.filter((name) => !active.includes(name));
    if (missing.length > 0) throw new Error(`The companion extension did not activate ${missing.join(", ")} (active: ${active.join(", ") || "none"}).`);
    const models = await driver.listModels();
    searchServer.listen(0, "127.0.0.1");
    await once(searchServer, "listening");
    const search = new WebSearchService(join(root, "agent"));
    await search.configure({ action: "configure", provider: "searxng", connection: { source: "none", baseUrl: `http://127.0.0.1:${(searchServer.address() as { port: number }).port}` } });
    await search.configure({ action: "select", provider: "searxng" });
    const result = await search.search("packaged capability probe");
    if (!result.includes("Search runtime verified")) throw new Error("The packaged search runtime did not return its source.");
    if (!driver.deliverExtensionCommand({ type: "lasercode/account-usage/refresh" })) {
      throw new Error("The bundled subscription allowance module did not accept refresh.");
    }
    return { ok: true, sessionId: state.id, modelCount: models.length, modules: active, beamSkillPath: beamSkill, beamSkillBytes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    searchServer.closeAllConnections();
    await new Promise<void>((done) => searchServer.close(() => done()));
    await driver.dispose().catch(() => undefined);
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
  const report = await checkPackagedSession();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
