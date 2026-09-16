import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LaserPaths } from "../src/config.js";
import { inspectHost, probeHealth, writeHostFile } from "../src/hostfile.js";

const launchId = "0123456789abcdef0123456789abcdef";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ paths: LaserPaths; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "host-identity-"));
  roots.push(root);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", launchId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const paths: LaserPaths = {
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    stateDir: join(root, "state"),
    hostFile: join(root, "state", "host.json"),
    logFile: join(root, "state", "host.log"),
    host: "127.0.0.1",
    port,
    portIsExplicit: true,
  };
  return { paths, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("host launch identity", () => {
  it("accepts only the exact identity echoed by health", async () => {
    const { paths, close } = await fixture();
    try {
      expect(await probeHealth(`http://${paths.host}:${paths.port}`, 500, launchId)).toBe(true);
      expect(await probeHealth(`http://${paths.host}:${paths.port}`, 500, "fedcba9876543210fedcba9876543210")).toBe(false);
    } finally {
      await close();
    }
  });

  it("never adopts starting or mismatched records even when the endpoint answers", async () => {
    const { paths, close } = await fixture();
    const base = {
      pid: process.pid,
      launchId,
      host: paths.host,
      port: paths.port,
      url: `http://${paths.host}:${paths.port}`,
      agentDir: paths.agentDir,
      sessionDir: paths.sessionDir,
      stateDir: paths.stateDir,
      startedAt: new Date().toISOString(),
      cliVersion: "fixture",
    };
    try {
      writeHostFile(paths.hostFile, { ...base, state: "starting" });
      await expect(inspectHost(paths, 500)).resolves.toMatchObject({ state: "unreachable" });

      writeHostFile(paths.hostFile, {
        ...base,
        state: "ready",
        launchId: "fedcba9876543210fedcba9876543210",
      });
      await expect(inspectHost(paths, 500)).resolves.toMatchObject({ state: "unreachable" });
    } finally {
      await close();
    }
  });
});
