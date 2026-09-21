/**
 * M21-T17: the host answering a request *from* a worker.
 *
 * Against a real child process on the real fd-3 protocol, because the thing
 * under test is the link itself: a request the worker sends is routed to the
 * host's one hook, its answer comes back on the same id, a handler that
 * throws becomes an error response rather than a worker waiting for ever,
 * and a host with no hook says so instead of dropping the frame.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCodes, PROJECT_WORK_BRIDGE_METHOD, ProtocolError } from "@lasercode/protocol";
import { WorkerClient } from "../src/worker-client.js";

/**
 * A worker that asks the host one question and reports the answer back as a
 * notification, so the test can read what the host really sent.
 */
const WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const flag = process.argv.indexOf("--project-work");
const projectWork = flag < 0 ? undefined : process.argv[flag + 1];
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
    const message = JSON.parse(line);
    if (message.method === undefined && typeof message.id === "string") {
      send({ jsonrpc: "2.0", method: "pi/test/answer", params: { id: message.id, result: message.result ?? null, error: message.error ?? null } });
      continue;
    }
    if (message.method === "pi/test/ask") {
      send({ jsonrpc: "2.0", id: "w1", method: message.params.ask, params: message.params.params });
      send({ jsonrpc: "2.0", id: message.id, result: { asked: true } });
      continue;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal", projectWork } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
`;

let dir: string;
let workerMain: string;
let project: string;
let client: WorkerClient | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-bridge-"));
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

interface Answer {
  id: string;
  result: unknown;
  error: { code: number; message: string; data?: unknown } | null;
}

function connect(onRequest?: (method: string, params: unknown) => Promise<unknown>): { worker: WorkerClient; answers: Answer[]; argv: string[] } {
  const answers: Answer[] = [];
  const argv: string[] = [];
  client = new WorkerClient({
    cwd: project,
    workerMain,
    onNotification: (notification) => {
      const params = notification.params as Record<string, unknown>;
      if (notification.method === "pi/test/answer") answers.push(params as unknown as Answer);
      if (notification.method === "pi/worker/status" && typeof params["projectWork"] === "string") argv.push(params["projectWork"] as string);
    },
    onExit: () => {},
    ...(onRequest ? { onRequest } : {}),
  });
  return { worker: client, answers, argv };
}

async function settle(answers: Answer[]): Promise<Answer> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (answers.length > 0) return answers[0]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the host never answered the worker");
}

it("tells a worker whether this host answers the project-work bridge", async () => {
  const withHook = connect(async () => ({ ok: true }));
  await withHook.worker.ready;
  expect(withHook.argv, "a host that answers the bridge says so in argv").toEqual(["yes"]);
  await withHook.worker.stop();

  const without = connect();
  await without.worker.ready;
  expect(without.argv, "a host that does not answers no flag at all").toEqual([]);
}, 20_000);

it("routes a worker's request to the hook and answers on the same id", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  const { worker, answers } = connect(async (method, params) => {
    seen.push({ method, params });
    return { projectId: "prj_1" };
  });
  await worker.ready;
  await worker.request("pi/test/ask", { ask: PROJECT_WORK_BRIDGE_METHOD, params: { agent: { label: "Builder" } } });
  const answer = await settle(answers);
  expect(seen).toEqual([{ method: PROJECT_WORK_BRIDGE_METHOD, params: { agent: { label: "Builder" } } }]);
  expect(answer).toMatchObject({ id: "w1", result: { projectId: "prj_1" }, error: null });
}, 20_000);

it("answers a refusal with its code, message and data, so the tool can act on it", async () => {
  const { worker, answers } = connect(async () => {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That work belongs to beta.", { refused: "wrong_project", owningProjectName: "beta" });
  });
  await worker.ready;
  await worker.request("pi/test/ask", { ask: PROJECT_WORK_BRIDGE_METHOD, params: {} });
  const answer = await settle(answers);
  expect(answer.error).toMatchObject({ code: ErrorCodes.InvalidParams, message: "That work belongs to beta." });
  expect((answer.error?.data as { refused?: string }).refused).toBe("wrong_project");
}, 20_000);

it("answers a host that has no hook rather than leaving the worker waiting", async () => {
  const { worker, answers } = connect();
  await worker.ready;
  await worker.request("pi/test/ask", { ask: PROJECT_WORK_BRIDGE_METHOD, params: {} });
  const answer = await settle(answers);
  expect(answer.error?.code).toBe(ErrorCodes.Unsupported);
}, 20_000);
