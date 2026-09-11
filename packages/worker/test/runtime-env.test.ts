import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extendRuntimePath, runtimeLauncher, runtimePathAdditions } from "../src/runtime-env.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-runtime-`)); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function bundled() {
  const runtime = join(root, "runtime with 'quotes' $and spaces");
  const agentDir = join(root, "agent");
  const execPath = join(runtime, "node");
  const npmCli = join(runtime, "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "");
  return { runtime, agentDir, execPath, npmCli, env: { PATH: "", PI_CODING_AGENT_DIR: agentDir, [ENV.npmCli]: npmCli } };
}

describe("runtime PATH", () => {
  it("never exposes npm's internal bin, including paths in the host command", () => {
    const { runtime, execPath, npmCli } = bundled();
    for (const env of [{ [ENV.npmCli]: npmCli }, { [ENV.npmCommand]: JSON.stringify([execPath, npmCli]) }]) {
      expect(runtimePathAdditions(env, execPath)).toEqual([runtime]);
    }
  });

  it("keeps the runtime ahead of competing commands without removing inherited entries", () => {
    const runtime = dirname(process.execPath);
    vi.stubEnv("PATH", ["/competing", runtime, "/other"].join(delimiter));
    vi.stubEnv(ENV.npmCli, undefined);
    vi.stubEnv(ENV.npmCommand, undefined);
    const original = process.env["PATH"]!;
    extendRuntimePath();
    expect(process.env["PATH"]).toBe(`${runtime}${delimiter}${original}`);
    extendRuntimePath();
    expect(process.env["PATH"]).toBe(`${runtime}${delimiter}${original}`);
  });

  it("creates launchers only when the runtime lacks npx, updating paths idempotently", () => {
    const { runtime, execPath, agentDir, npmCli, env } = bundled();
    const bin = join(agentDir, "bin");
    expect(runtimePathAdditions(env, execPath)).toEqual([runtime, bin]);
    for (const name of ["npm", "npx"]) {
      const path = join(bin, name + (process.platform === "win32" ? ".cmd" : ""));
      expect(readFileSync(path, "utf8")).toBe(runtimeLauncher(execPath, join(dirname(npmCli), `${name}-cli.js`)));
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
      const before = statSync(path).mtimeMs;
      runtimePathAdditions(env, execPath);
      expect(statSync(path).mtimeMs).toBe(before);
    }
    const newer = join(runtime, "new-node");
    runtimePathAdditions(env, newer);
    expect(readFileSync(join(bin, process.platform === "win32" ? "npm.cmd" : "npm"), "utf8")).toContain("new-node");
    writeFileSync(join(runtime, process.platform === "win32" ? "npx.cmd" : "npx"), "existing");
    expect(runtimePathAdditions(env, execPath)).toEqual([runtime]);
  });

  it("supports npm known only through the host's npmCommand", () => {
    const { runtime, execPath, agentDir, npmCli } = bundled();
    expect(runtimePathAdditions({ PI_CODING_AGENT_DIR: agentDir, [ENV.npmCommand]: JSON.stringify([execPath, npmCli, "--strict-allow-scripts"]) }, execPath))
      .toEqual([runtime, join(agentDir, "bin")]);
  });

  it("writes Windows launchers with delayed expansion disabled and literal percent paths", () => {
    expect(runtimeLauncher("C:\\App %home%!\\node.exe", "C:\\App\\npm\\bin\\npx-cli.js", "win32"))
      .toBe('@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\App %%home%%!\\node.exe" "C:\\App\\npm\\bin\\npx-cli.js" %*\r\n');
  });

  it.skipIf(process.platform === "win32")("runs real npm and npx in a bundled-style layout with no system PATH", () => {
    const { runtime, execPath, agentDir, npmCli, env } = bundled();
    const realNpm = dirname(dirname(realpathSync(join(dirname(process.execPath), "npm"))));
    expect(existsSync(join(realNpm, "bin", "npx-cli.js"))).toBe(true);
    rmSync(join(runtime, "npm"), { recursive: true });
    symlinkSync(realNpm, join(runtime, "npm"), "dir");
    copyFileSync(process.execPath, execPath);
    const additions = runtimePathAdditions(env, execPath);
    expect(additions).toEqual([runtime, join(agentDir, "bin")]);
    const childEnv = { ...process.env, PATH: additions.join(delimiter), HOME: root, npm_config_cache: join(root, "cache") };
    const version = execFileSync(execPath, [npmCli, "--version"], { env: childEnv, encoding: "utf8" }).trim();
    for (const command of ["npx", "npm"]) {
      expect(execFileSync(command, ["--version"], { env: childEnv, encoding: "utf8" }).trim()).toBe(version);
    }
  });
});
