/**
 * Fill `laserToolRegistry()` the only honest way: by letting the real session
 * register the real tools.
 *
 * The measures read a tool's registered spec — its closed schema and its
 * annotations — and a unit test that handed them a spec written by hand would
 * be testing its own fixture. So a test that needs the registry opens two
 * sessions that say nothing: one root session (the parent tools, the
 * background tools and `web_search`) and one child session
 * (`complete_agent_run`), each answering with one recorded sentence and no
 * tool call at all. Two turns, once per test file.
 */
import { parseFixture } from "../../src/tool-eval/fixture.js";
import { runFixture } from "../../src/tool-eval/run.js";

const PROFILE = { id: "mp_registry00000000000000", name: "Registry", model: "recorded-registry", provider: "recorded" };

let done: Promise<void> | undefined;

export function ensureToolsRegistered(): Promise<void> {
  done ??= register();
  return done;
}

async function register(): Promise<void> {
  for (const role of ["root", "child"] as const) {
    const fixture = parseFixture(
      {
        tool: "inspect_fleet",
        task: "Say nothing and stop.",
        expectedTool: "inspect_fleet",
        allowedTools: ["inspect_fleet"],
        budget: { calls: 0, inputTokens: 1_000_000, outputTokens: 1_000 },
        world: { role, ...(role === "root" ? { search: "unconnected" } : {}) },
        steps: [{ text: "Nothing to do." }],
      },
      `<registry:${role}>`,
    );
    await runFixture({ fixture, profile: PROFILE, timeoutMs: 60_000 });
  }
}
