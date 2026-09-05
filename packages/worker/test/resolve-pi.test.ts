import { PRODUCT_NAME } from "@piorbit/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PACKAGE,
  AgentResolutionError,
  assertBundledAgent,
  pinnedAgentVersion,
  resolveBundledAgent,
} from "../src/resolve-pi.js";

/**
 * The pin is the promise that two installs run the same agent, and every way it
 * can quietly stop being a pin is silent: a caret creeps into the manifest, a
 * reinstall lands a different version, a packager drops the entry file. None of
 * those raise an error on their own — they just change what the app runs — so
 * each one is asserted here against a manifest we build on the spot.
 */
const roots: string[] = [];

function fakeWorker(pin: string | undefined, agent?: { version?: string; bin?: string | null; writeBin?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pin-`));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@piorbit/worker", dependencies: pin === undefined ? {} : { [AGENT_PACKAGE]: pin } }),
  );
  if (agent) {
    const dir = join(root, "node_modules", ...AGENT_PACKAGE.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: AGENT_PACKAGE,
        version: agent.version ?? "0.85.0",
        ...(agent.bin === null ? {} : { bin: { pi: agent.bin ?? "cli.js" } }),
      }),
    );
    if (agent.writeBin !== false) writeFileSync(join(dir, agent.bin ?? "cli.js"), "");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the agent pin", () => {
  it("is an exact version or it is not a pin", () => {
    expect(pinnedAgentVersion(fakeWorker("0.85.0"))).toBe("0.85.0");
    expect(pinnedAgentVersion(fakeWorker("1.0.0-rc.2"))).toBe("1.0.0-rc.2");
    for (const range of ["^0.85.0", "~0.85.0", ">=0.85.0", "0.85.x", "*", "latest"]) {
      expect(() => pinnedAgentVersion(fakeWorker(range))).toThrow(/range rather than a version/);
    }
  });

  it("refuses a manifest that pins nothing at all", () => {
    expect(() => pinnedAgentVersion(fakeWorker(undefined))).toThrow(/does not pin/);
  });

  it("fails when the installed agent is not the pinned one", () => {
    const root = fakeWorker("0.85.0", { version: "0.86.0" });
    expect(() => assertBundledAgent(root)).toThrow(/ships agent 0\.85\.0, but the copy in this install is 0\.86\.0/);
  });

  it("passes when they match, and reports where it looked", () => {
    const agent = assertBundledAgent(fakeWorker("0.85.0", { version: "0.85.0" }));
    expect(agent.version).toBe("0.85.0");
    expect(agent.bin.endsWith("cli.js")).toBe(true);
    // The search never leaves the tree the worker itself lives in.
    expect(agent.searched.every((path) => path.includes("node_modules"))).toBe(true);
  });

  it("says the install is incomplete when the program file is missing", () => {
    const root = fakeWorker("0.85.0", { writeBin: false });
    expect(() => resolveBundledAgent(root)).toThrow(/program file is missing/);
  });

  it("carries a fix on every failure, because a person reads it", () => {
    try {
      assertBundledAgent(fakeWorker("0.85.0", { version: "0.86.0" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentResolutionError);
      expect((error as AgentResolutionError).fix).toMatch(new RegExp(`Reinstall ${PRODUCT_NAME}`));
    }
  });
});
