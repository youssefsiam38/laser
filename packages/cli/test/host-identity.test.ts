import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV } from "@lasercode/protocol";
import type { LaserPaths } from "../src/config.js";
import { runDaemon } from "../src/daemon.js";
import { prepareInstalledRuntime, startHost } from "../src/host-control.js";
import { inspectHost, probeHealth, writeHostFile } from "../src/hostfile.js";

const launchId = "0123456789abcdef0123456789abcdef";
const generationId = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(legacy = false): Promise<{ paths: LaserPaths; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "host-identity-"));
  roots.push(root);
  const server = createServer((_req, res) => {
    if (legacy) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", launchId, generationId }));
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
      expect(await probeHealth(`http://${paths.host}:${paths.port}`, 500, launchId, generationId)).toBe(true);
      expect(await probeHealth(`http://${paths.host}:${paths.port}`, 500, launchId, "b".repeat(64))).toBe(false);
      expect(await probeHealth(`http://${paths.host}:${paths.port}`, 500, "fedcba9876543210fedcba9876543210")).toBe(false);
    } finally {
      await close();
    }
  });

  it("adopts a legacy record only when its process and health endpoint validate", async () => {
    const { paths, close } = await fixture(true);
    try {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(paths.hostFile, JSON.stringify({
        pid: process.pid,
        host: paths.host,
        port: paths.port,
        url: `http://${paths.host}:${paths.port}`,
        agentDir: paths.agentDir,
        sessionDir: paths.sessionDir,
        stateDir: paths.stateDir,
        startedAt: new Date().toISOString(),
        cliVersion: "legacy",
      }));
      await expect(inspectHost(paths, 500)).resolves.toMatchObject({
        state: "running",
        record: { legacy: true, state: "ready", launchId: "" },
      });
    } finally {
      await close();
    }
  });

  it("does not use a modern health identity to upgrade an unclaimed legacy record", async () => {
    const { paths, close } = await fixture();
    try {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(paths.hostFile, JSON.stringify({
        pid: process.pid,
        host: paths.host,
        port: paths.port,
        url: `http://${paths.host}:${paths.port}`,
        agentDir: paths.agentDir,
        sessionDir: paths.sessionDir,
        stateDir: paths.stateDir,
        startedAt: new Date().toISOString(),
        cliVersion: "legacy",
      }));
      await expect(inspectHost(paths, 500)).resolves.toMatchObject({ state: "unreachable", record: { legacy: true } });
    } finally {
      await close();
    }
  });

  it("a competing daemon fails without replacing a live host record", async () => {
    const { paths, close } = await fixture();
    const original = {
      pid: process.pid,
      state: "ready" as const,
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
    const previous = process.env[ENV.hostLaunchId];
    try {
      writeHostFile(paths.hostFile, original);
      process.env[ENV.hostLaunchId] = "fedcba9876543210fedcba9876543210";
      const runtimeGeneration = prepareInstalledRuntime(paths).reference;
      await expect(runDaemon({ paths, runtimeGeneration, log: () => undefined })).rejects.toThrow(/already running/);
      expect(JSON.parse(readFileSync(paths.hostFile, "utf8"))).toMatchObject({ launchId, state: "ready" });
      await expect(inspectHost(paths, 500)).resolves.toMatchObject({ state: "running", record: { launchId } });
    } finally {
      if (previous === undefined) delete process.env[ENV.hostLaunchId];
      else process.env[ENV.hostLaunchId] = previous;
      await close();
    }
  });

  it("startHost refuses a responder whose claimed launch differs from the one it minted", async () => {
    const { paths, close } = await fixture();
    await close();
    const mismatch = "fedcba9876543210fedcba9876543210";
    const responder = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", launchId: mismatch }));
    });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnProcess = vi.fn(() => {
      responder.listen(paths.port, paths.host, () => {
        writeHostFile(paths.hostFile, {
          pid: process.pid,
          state: "ready",
          launchId: mismatch,
          host: paths.host,
          port: paths.port,
          url: `http://${paths.host}:${paths.port}`,
          agentDir: paths.agentDir,
          sessionDir: paths.sessionDir,
          stateDir: paths.stateDir,
          startedAt: new Date().toISOString(),
          cliVersion: "fixture",
        });
      });
      return child;
    });
    try {
      await expect(startHost(paths, 2_000, { spawnProcess: spawnProcess as never })).rejects.toThrow(/not the process this command started/);
      expect(spawnProcess).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => responder.close(() => resolve()));
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
