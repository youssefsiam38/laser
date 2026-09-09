/**
 * "The URL of the running app" has one answer (M13-T54). A host record whose
 * process is alive is the address; the configured port is where to start one
 * and where to look when nothing is recorded. `new` once printed the default
 * port for a host it had just reached on 41493.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV } from "@lasercode/protocol";
import { HOST_DEFAULT_PORT } from "@lasercode/host";
import type { ParsedArgs } from "../src/args.js";
import { appAddress, appUrl, hostUrl, resolvePaths } from "../src/config.js";
import { processIdentity, writeHostFile, type HostRecord } from "../src/hostfile.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-url-"));
  dirs.push(dir);
  return dir;
}

function args(flags: Record<string, string | number | boolean> = {}): ParsedArgs {
  return { flags, positionals: [], rest: [], hasRest: false };
}

function paths(flags: Record<string, string | number | boolean> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = stateDir();
  return resolvePaths(args({ "state-dir": dir, ...flags }), { HOME: dir, ...env });
}

/** A record for a process that is alive right now: this one. */
function liveRecord(port: number, over: Partial<HostRecord> = {}): HostRecord {
  const identity = processIdentity(process.pid);
  return {
    pid: process.pid,
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
    agentDir: "",
    sessionDir: "",
    stateDir: "",
    startedAt: new Date().toISOString(),
    cliVersion: "test",
    ...(identity !== undefined ? { identity } : {}),
    ...over,
  };
}

/** A pid that has already exited, so nothing is at it. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("could not spawn a child to take a pid");
  return child.pid;
}

describe("appAddress", () => {
  it("uses the recorded host's port when its process is alive, not the configured one", () => {
    const p = paths();
    writeHostFile(p.hostFile, liveRecord(41493));
    expect(appAddress(p)).toEqual({ host: "127.0.0.1", port: 41493, url: "http://127.0.0.1:41493", source: "record" });
    expect(appUrl(p)).toBe("http://127.0.0.1:41493");
    expect(appUrl(p)).not.toBe(hostUrl(p));
  });

  it("falls back to the configured default port when nothing is recorded", () => {
    const p = paths();
    expect(appAddress(p)).toEqual({ host: p.host, port: HOST_DEFAULT_PORT, url: hostUrl(p), source: "configured" });
    expect(appUrl(p)).toBe(`http://127.0.0.1:${HOST_DEFAULT_PORT}`);
  });

  it("uses --port when nothing is recorded", () => {
    const p = paths({ port: 41500 });
    expect(appAddress(p)).toMatchObject({ port: 41500, url: "http://127.0.0.1:41500", source: "configured" });
  });

  it("uses the environment's port when nothing is recorded", () => {
    const p = paths({}, { [ENV.port]: "41501" });
    expect(appAddress(p)).toMatchObject({ port: 41501, source: "configured" });
  });

  it("lets a live record win over --port, as status and every session verb already do to reach it", () => {
    // `inspectHost` reads the record whatever `--port` says, so a command given
    // `--port 41500` connects to 41493 here; the URL it prints must be the one
    // it used. `--port` chooses where a host starts, not which one is running.
    const p = paths({ port: 41500 });
    writeHostFile(p.hostFile, liveRecord(41493));
    expect(appAddress(p)).toMatchObject({ port: 41493, source: "record" });
  });

  it("ignores a record whose process is gone", () => {
    const p = paths();
    writeHostFile(p.hostFile, liveRecord(41493, { pid: deadPid(), identity: "linux:gone:1" }));
    expect(appAddress(p)).toMatchObject({ port: HOST_DEFAULT_PORT, source: "configured" });
  });

  it("ignores a record whose pid now belongs to a different process", () => {
    const p = paths();
    // Alive pid, but the identity says the record was written for another run of it.
    writeHostFile(p.hostFile, liveRecord(41493, { identity: "linux:another-boot:1" }));
    if (processIdentity(process.pid) === undefined) return; // platform cannot compare; nothing to assert
    expect(appAddress(p)).toMatchObject({ port: HOST_DEFAULT_PORT, source: "configured" });
  });

  it("does not delete a stale record: reading an address is not a lifecycle action", () => {
    const p = paths();
    writeHostFile(p.hostFile, liveRecord(41493, { pid: deadPid() }));
    appAddress(p);
    expect(() => appAddress(p)).not.toThrow();
    expect(existsSync(p.hostFile)).toBe(true);
  });
});
