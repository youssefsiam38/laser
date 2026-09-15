/**
 * RP-7: the host's link to one worker.
 *
 * Two things are under test, against a real child process speaking the real
 * fd-3 protocol: a large frame is decoded linearly and completely, and a frame
 * past the transport ceiling ends that worker generation instead of being
 * skipped — because skipping a response would leave the request that is
 * waiting for it waiting for ever.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_MAX_BYTES } from "@lasercode/protocol";
import { WorkerClient } from "../src/worker-client.js";

/**
 * A worker that answers with a payload of the size it is asked for, in one
 * frame, and can be told to send one past the ceiling.
 */
const WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === "pi/test/big") { send({ jsonrpc: "2.0", id: req.id, result: { text: "x".repeat(req.params.bytes) } }); continue; }
    if (req.method === "pi/test/overflow") {
      // Written straight to the pipe, so it is one frame with no newline in it
      // until the very end: exactly the shape the ceiling exists for.
      socket.write("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":" + req.id + ",\\"result\\":{\\"text\\":\\"");
      const chunk = "y".repeat(1024 * 1024);
      for (let n = 0; n < req.params.megabytes; n++) socket.write(chunk);
      socket.write("\\"}}\\n");
      continue;
    }
    if (req.method === "pi/test/utf8") { send({ jsonrpc: "2.0", id: req.id, result: { text: "日本語🚀".repeat(req.params.times) } }); continue; }
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
`;

let dir: string;
let workerMain: string;
let project: string;
let client: WorkerClient | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-frames-"));
  workerMain = join(dir, "worker.mjs");
  writeFileSync(workerMain, WORKER);
  project = join(dir, "project");
  mkdirSync(project, { recursive: true });
});

afterEach(async () => {
  await client?.stop().catch(() => {});
  client = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function connect(onExit: (code: number | null) => void = () => {}): WorkerClient {
  client = new WorkerClient({
    cwd: project,
    workerMain,
    onNotification: () => {},
    onExit: (code) => onExit(code),
  });
  return client;
}

it("decodes a 16 MiB frame completely, and holds no more than that frame", async () => {
  const worker = connect();
  await worker.ready;
  const bytes = 16 * 1024 * 1024;
  const result = await worker.request<{ text: string }>("pi/test/big", { bytes });
  expect(result.text.length).toBe(bytes);
  const pressure = worker.transportPressure();
  expect(pressure.decoder?.largestFrame).toBeGreaterThan(bytes);
  // The frame was copied once, not once per chunk that carried it.
  expect(pressure.decoder!.joins).toBeLessThanOrEqual(pressure.decoder!.frames);
  expect(pressure.decoder!.bytesCopied).toBeLessThanOrEqual(pressure.decoder!.bytesScanned);
  expect(pressure.decoder!.retained).toBe(0);
}, 30_000);

it("decodes multi-byte text split across pipe chunks", async () => {
  const worker = connect();
  await worker.ready;
  const times = 200_000;
  const result = await worker.request<{ text: string }>("pi/test/utf8", { times });
  expect(result.text).toBe("日本語🚀".repeat(times));
  expect(result.text).not.toContain("\ufffd");
}, 30_000);

it("ends the worker generation on a frame past the ceiling, failing what was in flight", async () => {
  const exits: Array<number | null> = [];
  const worker = connect((code) => exits.push(code));
  await worker.ready;
  // Two requests: one asks for the impossible frame, one is simply in flight
  // behind it. Neither may be left hanging.
  const overflowing = worker.request("pi/test/overflow", { megabytes: FRAME_MAX_BYTES / (1024 * 1024) + 2 });
  const innocent = worker.request("pi/test/echo", {});
  await expect(overflowing).rejects.toThrow(/past the .* limit for one message|worker/i);
  await expect(innocent).rejects.toThrow();
  expect(worker.alive).toBe(false);
  await expect.poll(() => exits.length).toBe(1);
  // A request after the fault is refused immediately rather than queued into
  // a link nobody is reading.
  await expect(worker.request("pi/test/echo", {})).rejects.toThrow(/worker exited/);
}, 60_000);
