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
import { ResourceService } from "../../src/resources/service.js";

const FAKE_WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
socket.write(JSON.stringify({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } }) + "\\n");
socket.on("data", () => {});
socket.on("end", () => process.exit(0));
`;

let dir: string;
let project: string;
let pool: WorkerPool | undefined;

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
  it("records a live worker's identity and drops it when the process exits", async () => {
    const resources = new ResourceService({ hostPid: process.pid, ancestorsOf: () => [] });
    pool = new WorkerPool({
      workerMain: join(dir, "fake-worker.mjs"),
      onNotification: () => {},
      onStatus: () => {},
      resources: {
        noteWorker: (cwd, pid) => resources.ownership.noteWorker(cwd, pid),
        noteExit: (pid) => resources.ownership.noteExit(pid),
      },
    });

    const client = await pool.get(project);
    const pid = client.pid!;
    const record = resources.ownership.roots().find((entry) => entry.pid === pid);
    expect(record).toMatchObject({ role: "project_worker", projectCwd: project });
    // An identity, not just a number: this is what a reused pid is checked against.
    if (process.platform === "linux") expect(record!.startToken).toMatch(/^linux:/);

    await pool.stop(project, "test");
    expect(resources.ownership.roots().some((entry) => entry.pid === pid)).toBe(false);
  });

  it("leaves a pool without diagnostics exactly as it was", async () => {
    pool = new WorkerPool({ workerMain: join(dir, "fake-worker.mjs"), onNotification: () => {}, onStatus: () => {} });
    const client = await pool.get(project);
    expect(client.pid).toBeDefined();
  });
});
