import { ENV } from "@lasercode/protocol";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentHome, desktopEnv, laserDataDir } from "../src/agent-home.js";

/**
 * This is the whole "laser never touches your own agent" guarantee, and it is
 * one function. The failure it prevents is silent in both directions: laser
 * quietly writing another program's settings file, or a person's shell variable
 * quietly deciding where the app keeps its credentials.
 */
describe("desktopEnv", () => {
  const home = "/home/example";

  it("removes the variables that name another agent installation", () => {
    const env = desktopEnv({
      HOME: home,
      PI_CODING_AGENT_DIR: "/home/example/.pi/agent",
      PI_CODING_AGENT_SESSION_DIR: "/home/example/.pi/agent/sessions",
    });
    expect(env["PI_CODING_AGENT_DIR"]).toBeUndefined();
    expect(env["PI_CODING_AGENT_SESSION_DIR"]).toBeUndefined();
    expect(env[ENV.agentDir]).toBe(join(laserDataDir({ HOME: home }), "agent"));
    expect(env[ENV.stateDir]).toBe(join(laserDataDir({ HOME: home }), "state"));
  });

  it(`honours ${ENV.agentDir}, which is the deliberate lever`, () => {
    const env = desktopEnv({ HOME: home, [ENV.agentDir]: "/home/example/.pi/agent" });
    expect(env[ENV.agentDir]).toBe("/home/example/.pi/agent");
    expect(agentHome({ HOME: home, [ENV.agentDir]: "/home/example/.pi/agent" }).chosenByPerson).toBe(true);
  });

  it("reports what it ignored, so a log can say so instead of a person guessing", () => {
    expect(agentHome({ HOME: home, PI_CODING_AGENT_DIR: "/elsewhere" }).ignored).toEqual(["PI_CODING_AGENT_DIR"]);
    expect(agentHome({ HOME: home, PI_CODING_AGENT_DIR: "  " }).ignored).toEqual([]);
    expect(agentHome({ HOME: home }).ignored).toEqual([]);
  });
});
