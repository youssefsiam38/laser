/**
 * The pool's part of the inventory: a worker's pid is registered at spawn and
 * forgotten at exit.
 *
 * Spawn is the only moment a worker's identity can be captured — read it later
 * and the pid may already belong to somebody else — so this runs a real child
 * process through the real pool rather than asserting on a mock's call order.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "../../src/worker-pool.js";
import { RuntimeRepairLedger } from "../../src/runtime-repair.js";
import { ResourceService } from "../../src/resources/service.js";

const FAKE_WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
socket.write(JSON.stringify({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } }) + "\\n");
socket.write(JSON.stringify({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } }) + "\\n");
// RP-4: retirement is the worker's own transition, so a worker that is asked
// answers. This one holds nothing, so it always agrees.
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    const result = req.method === "pi/worker/retire" ? { retiring: true } : { ok: true };
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
  }
});
socket.on("end", () => process.exit(0));
`;

let dir: string;
let project: string;
let pool: WorkerPool | undefined;
const repair = () => new RuntimeRepairLedger(join(dir, "runtime-repair.json"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-resource-pool-`));
  project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(dir, "fake-worker.mjs"), FAKE_WORKER);
});

afterEach(async () => {
  await pool?.stopAll();
  pool = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("worker registration", () => {
  it("records a live worker, proves its identity from the real machine, and forgets it on exit", async () => {
    const resources = new ResourceService({ hostPid: process.pid, minIntervalMs: 0 });
    pool = new WorkerPool({
      workerMain: join(dir, "fake-worker.mjs"),
      repair: repair(),
      onNotification: () => {},
      onStatus: () => {},
      resources: {
        noteWorker: (cwd, pid) => resources.ownership.noteWorker(cwd, pid),
        noteExit: (pid, generation) => resources.ownership.noteExit(pid, generation),
      },
    });

    const client = await pool.get(project);
    const pid = client.pid!;
    expect(resources.ownership.size()).toBe(1);

    // Registration reads nothing; the identity comes from the first collected
    // table, which on this machine is the real one.
    const { snapshot } = await resources.snapshot();
    const row = snapshot.processes.find((entry) => entry.pid === pid);
    if (process.platform === "linux") {
      expect(row).toBeDefined();
      expect(row!.role).toBe("project_worker");
      expect(row!.project?.label).toBe("project");
      expect(row!.startToken).toMatch(/^linux:/);
    }

    await pool.stop(project, "test");
    expect(resources.ownership.size()).toBe(0);
  });

  it("ignores a late exit that quotes a generation the pid no longer belongs to", async () => {
    const resources = new ResourceService({ hostPid: process.pid, minIntervalMs: 0 });
    const stale = resources.ownership.noteWorker(project, 4242);
    const current = resources.ownership.noteWorker(project, 4242);
    resources.ownership.noteExit(4242, stale);
    expect(resources.ownership.size()).toBe(1);
    resources.ownership.noteExit(4242, current);
    expect(resources.ownership.size()).toBe(0);
  });

  it("leaves a pool without diagnostics exactly as it was", async () => {
    pool = new WorkerPool({ workerMain: join(dir, "fake-worker.mjs"), repair: repair(), onNotification: () => {}, onStatus: () => {} });
    const client = await pool.get(project);
    expect(client.pid).toBeDefined();
  });
});
