import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { ENV, envVar } from "@lasercode/protocol";
import type { McpConfiguredServer } from "../src/mcp/store.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyEnvironment } from "../src/environment.js";
import { McpInspector } from "../src/mcp/inspector.js";

let home: string;
let inspector: McpInspector;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "worker-env-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("SYNTHETIC_SHELL_EXPORT", undefined);
  vi.stubEnv("PATH", process.env.PATH);
  vi.stubEnv(ENV.npmCommand, undefined);
  vi.stubEnv(ENV.npmCli, undefined);
  inspector = new McpInspector(home);
});
afterEach(async () => {
  await inspector.dispose();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it("applies updates without changing app pins and restores bundled PATH precedence", () => {
  const keys = [...Object.values(ENV), envVar("FUTURE_PIN"), "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];
  for (const key of keys) vi.stubEnv(key, key === "PI_CODING_AGENT_DIR" ? home : undefined);
  const before = keys.map((key) => process.env[key]);
  expect(applyEnvironment({ variables: { ...Object.fromEntries(keys.map((key) => [key, "refused"])), PATH: "/shell/bin", SYNTHETIC_SHELL_EXPORT: "private-fixture" } })).toBe(2);
  expect(keys.map((key) => process.env[key])).toEqual(before);
  expect(process.env.PATH).toBe(`${dirname(process.execPath)}${delimiter}/shell/bin`);
  expect(applyEnvironment({ variables: { INVALID: "bad\0value" } })).toBe(0);
  const stdout = execFileSync(process.execPath, ["-e", 'process.stdout.write(String(Object.hasOwn(process.env, "SYNTHETIC_SHELL_EXPORT")))'], { encoding: "utf8" });
  expect(stdout).toBe("true");
});

it.skipIf(process.platform === "win32")("the command backend created before refresh sees the export on its next command", async () => {
  const bash = createLocalBashOperations({ shellPath: "/bin/bash" });
  const check = () => bash.exec('test -n "$SYNTHETIC_SHELL_EXPORT"', home, { onData: () => {} });
  expect((await check()).exitCode).toBe(1);
  applyEnvironment({ variables: { SYNTHETIC_SHELL_EXPORT: "private-fixture" } });
  expect((await check()).exitCode).toBe(0);
});

it("an updated environment reaches newly connected stdio servers; isolation and overrides still win", async () => {
  const config: McpConfiguredServer = { name: "environment", transport: { kind: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./environment-server.mjs", import.meta.url))] } };
  const presence = async (server = config) => {
    const result = await inspector.call("global", server, new Map(), "presence", {});
    expect(result.ok).toBe(true);
    const text = result.content.find((part) => part.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "null") as { present: boolean; overridden: boolean; shellPresent: boolean };
  };
  expect((await presence()).present).toBe(false);
  applyEnvironment({ variables: { SYNTHETIC_SHELL_EXPORT: "private-fixture" } });
  // An existing server keeps its startup environment until Reconnect.
  expect((await presence()).present).toBe(false);
  await inspector.closeServer("global", "environment");
  expect(await presence()).toMatchObject({ present: true, overridden: false, ...(process.platform !== "win32" ? { shellPresent: true } : {}) });
  await inspector.closeServer("global", "environment");
  expect((await presence({ ...config, transport: { ...config.transport, kind: "stdio", command: process.execPath, inheritEnv: false } })).present).toBe(false);
  await inspector.closeServer("global", "environment");
  expect(await presence({ ...config, transport: { ...config.transport, kind: "stdio", command: process.execPath, inheritEnv: false, env: { SYNTHETIC_SHELL_EXPORT: "explicit-fixture" } } })).toMatchObject({ present: true, overridden: true });
}, 60_000);
