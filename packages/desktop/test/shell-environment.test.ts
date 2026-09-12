import { ENV, environmentOverlay, envVar } from "@lasercode/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveShellEnvironment } from "../src/shell-environment.js";

let home: string;
let logs: string[];
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shell-env-"));
  logs = [];
  // An allowlist, not the person's credentials or engine environment.
  env = { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" };
  writeFileSync(join(home, ".bash_profile"), 'source "$HOME/.bashrc"\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const resolve = (extra: Partial<Parameters<typeof resolveShellEnvironment>[0]> = {}) =>
  resolveShellEnvironment({ env, log: (line) => logs.push(line), ...extra });

describe.skipIf(process.platform === "win32")("login shell environment", () => {
  it("passes the interactive guard, ignores noise, preserves multiline exports and uses the shell PATH", async () => {
    writeFileSync(join(home, ".bashrc"), `case $- in *i*) ;; *) return;; esac
printf 'startup noise\\n'
export SYNTHETIC_SHELL_EXPORT='private-fixture'
export SYNTHETIC_MULTILINE='first
second=part'
export PATH='/shell/tools:/usr/bin:/bin'
export NODE_OPTIONS='do-not-import'
export ELECTRON_RUN_AS_NODE=1
export PI_CODING_AGENT_DIR='/other-agent'
export ${ENV.agentDir}='/other-app'
`);
    const resolved = await resolve();
    expect(resolved["SYNTHETIC_SHELL_EXPORT"] === "private-fixture").toBe(true);
    expect(resolved["SYNTHETIC_MULTILINE"] === "first\nsecond=part").toBe(true);
    const inherited = { ...env, NODE_OPTIONS: "owned", [ENV.agentDir]: "/owned" };
    const combined = { ...inherited, ...resolved };
    expect(combined.PATH).toBe("/shell/tools:/usr/bin:/bin");
    expect(combined.NODE_OPTIONS).toBe("owned");
    expect(combined[ENV.agentDir]).toBe("/owned");
    expect(resolved).not.toHaveProperty("PI_CODING_AGENT_DIR");
    expect(resolved).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(logs).toHaveLength(1);
    expect(logs.join("\n").includes("private-fixture")).toBe(false);
    expect(logs.join("\n")).not.toContain("startup noise");
  });

  it("scrubs runtime and engine pins before startup scripts run", async () => {
    env = { ...env, NODE_OPTIONS: "do-not-run", ELECTRON_RUN_AS_NODE: "1", PI_CODING_AGENT_DIR: "/not-ours", [ENV.stateDir]: "/not-ours" };
    writeFileSync(join(home, ".bashrc"), `if [[ -v NODE_OPTIONS || -v ELECTRON_RUN_AS_NODE || -v PI_CODING_AGENT_DIR || -v ${ENV.stateDir} ]]; then exit 4; fi\nexport SYNTHETIC_SCRUBBED=yes\n`);
    expect((await resolve())["SYNTHETIC_SCRUBBED"] === "yes").toBe(true);
  });

  it("times out a hanging startup and retains the inherited environment", async () => {
    writeFileSync(join(home, ".bashrc"), "sleep 30\n");
    const started = Date.now();
    expect(await resolve({ timeoutMs: 150 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(logs).toEqual(["Shell environment unavailable; keeping the current environment."]);
  });

  it.each(["exit 7\n", "while :; do printf 'lots of startup output'; done\n"])("fails safely for failed or unbounded startup", async (script) => {
    writeFileSync(join(home, ".bashrc"), script);
    expect(await resolve({ timeoutMs: 2000 })).toEqual({});
    expect(logs).toHaveLength(1);
  });

  it("handles a missing shell without exposing its error or environment", async () => {
    env.SHELL = join(home, "missing");
    expect(await resolve()).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(home);
  });
});

it("skips Windows and the explicit opt-out without spawning", async () => {
  env.SHELL = "/does-not-exist";
  expect(await resolve({ platform: "win32" })).toEqual({});
  env[envVar("RESOLVE_SHELL_ENV")] = "0";
  expect(await resolve()).toEqual({});
  expect(logs).toEqual([]);
});

it("protects every app pin, including future names and mixed case", () => {
  const protectedNames = [...Object.values(ENV), envVar("FUTURE_PIN"), "ELECTRON_FUTURE_PIN", "NODE_OPTIONS", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];
  for (const name of protectedNames) expect(environmentOverlay({ [name]: "ignored", [name.toLowerCase()]: "ignored" })).toEqual({});
});
