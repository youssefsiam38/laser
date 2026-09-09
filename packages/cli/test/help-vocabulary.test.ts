/**
 * The person configuring this product should never have to learn another
 * product's variable to do it.
 *
 * The engine's own `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` are
 * still *written* to the engine we spawn (`piEnv`) — that is the engine's input
 * contract and it has to keep working. They are not read when resolving paths,
 * and they are not named in help, so nobody is told to set them.
 */
import { describe, expect, it } from "vitest";
import { ENV } from "@lasercode/protocol";

import { resolvePaths } from "../src/config.js";
import { TOPICS } from "../src/help.js";

const ENGINE_VARS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;

describe("the vocabulary a person is asked to learn", () => {
  it("never names the engine's environment variables in help", () => {
    // Every help topic, not just the one that used to carry them.
    const surfaces = TOPICS.map((topic) => `${topic.title}\n${topic.body}`).join("\n");
    for (const name of ENGINE_VARS) expect(surfaces).not.toContain(name);
    // The product's own names are still there, so this is not passing by
    // rendering nothing.
    expect(surfaces).toContain(ENV.agentDir);
  });

  it("does not resolve paths from them, however they are set", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/someone",
      PI_CODING_AGENT_DIR: "/somewhere/else/agent",
      PI_CODING_AGENT_SESSION_DIR: "/somewhere/else/sessions",
    };
    const paths = resolvePaths({ flags: {}, positional: [] } as never, env);
    expect(paths.agentDir).not.toContain("/somewhere/else");
    expect(paths.sessionDir).not.toContain("/somewhere/else");
  });
});
