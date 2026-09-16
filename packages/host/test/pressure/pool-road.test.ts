/**
 * The private road a worker's pressure report travels (RP-8), at the pool.
 *
 * Three things are decided here, before the controller sees anything: a report
 * never joins the general notification stream, it carries the exact identity of
 * the process whose pipe delivered it — both the opaque one and that spawn's
 * private number — and a process the pool has already replaced cannot describe
 * the one that took its place.
 */
import { PRODUCT_NAME, type JsonRpcNotification } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "../../src/worker-pool.js";
import { WorkerClient } from "../../src/worker-client.js";

/** A worker that reports once, stamped with the generation its argv carries. */
const FAKE_WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const generation = Number(process.argv[process.argv.indexOf("--worker-generation") + 1]);
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
send({
  jsonrpc: "2.0",
  method: "pi/resource/pressure",
  params: {
    generation,
    level: "warning",
    inputs: [{ kind: "physical", value: { status: "available", value: 1 } }],
    ran: [],
    results: [],
    stores: {},
  },
});
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
    send({ jsonrpc: "2.0", id: req.id, result: req.method === "pi/worker/retire" ? { retiring: true } : { ok: true } });
  }
});
socket.on("end", () => process.exit(0));
`;

let dir: string;
let project: string;
let pool: WorkerPool | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pressure-road-`));
  project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(dir, "fake-worker.mjs"), FAKE_WORKER);
});

afterEach(async () => {
  await pool?.stopAll();
  pool = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("a worker's pressure report at the pool", () => {
  it("takes its own road, with the exact identity of the process that sent it", async () => {
    const general: JsonRpcNotification[] = [];
    const pressure: Array<{ cwd: string; source: { generation: string; workerGeneration: number | undefined } }> = [];
    pool = new WorkerPool({
      workerMain: join(dir, "fake-worker.mjs"),
      sweepMs: 0,
      onNotification: (_cwd, notification) => general.push(notification),
      onWorkerPressure: (cwd, _notification, source) => pressure.push({ cwd, source }),
    });

    const client = await pool.get(project);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(pressure).toHaveLength(1);
    expect(pressure[0]!.cwd).toBe(project);
    expect(pressure[0]!.source.generation).toBe(client.generation);
    expect(pressure[0]!.source.workerGeneration).toBe(client.workerGeneration);
    expect(typeof pressure[0]!.source.workerGeneration).toBe("number");
    // Not on the road every other notification takes.
    expect(general.some((notification) => notification.method === "pi/resource/pressure")).toBe(false);
    expect(general.some((notification) => notification.method === "pi/worker/status")).toBe(true);
  });

  it("is dropped when it comes from a process this directory has already replaced", async () => {
    const pressure: Array<{ generation: string }> = [];
    pool = new WorkerPool({
      workerMain: join(dir, "fake-worker.mjs"),
      sweepMs: 0,
      onNotification: () => undefined,
      onWorkerPressure: (_cwd, _notification, source) => pressure.push({ generation: source.generation }),
    });

    await pool.get(project);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const delivered = pressure.length;

    // A process the pool no longer serves, delivering on the pipe it still owns.
    const entry = (pool as unknown as { entries: Map<string, { cwd: string; client: WorkerClient; warm: boolean }> }).entries.get(project)!;
    const superseded = entry.client;
    entry.client = { generation: "gone", workerGeneration: 4242 } as unknown as WorkerClient;
    (pool as unknown as {
      onWorkerNotification: (entry: unknown, client: WorkerClient, notification: JsonRpcNotification) => void;
    }).onWorkerNotification.call(pool, entry, superseded, {
      jsonrpc: "2.0",
      method: "pi/resource/pressure",
      params: { generation: 1, level: "warning", inputs: [], ran: [], results: [], stores: {} },
    });

    expect(pressure).toHaveLength(delivered);
    entry.client = superseded;
  });

  it("counts only the workers a report can answer for", async () => {
    pool = new WorkerPool({
      workerMain: join(dir, "fake-worker.mjs"),
      workerOldSpaceMiB: 1792,
      sweepMs: 0,
      onNotification: () => undefined,
      onWorkerPressure: () => undefined,
    });

    expect(pool.pressureWorkers()).toEqual([]);
    const client = await pool.get(project);
    const workers = pool.pressureWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0]).toEqual({
      cwd: project,
      clientGeneration: client.generation,
      workerGeneration: client.workerGeneration,
      configuredOldSpaceBytes: 1792 * 1024 * 1024,
    });

    await pool.stop(project, "done");
    expect(pool.pressureWorkers()).toEqual([]);
  });
});
