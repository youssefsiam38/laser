#!/usr/bin/env node
/**
 * Finite old-space runaway proof for RP-8.
 *
 * Linux only: the gate protects the machine with a preflight and a continuous
 * MemAvailable floor, drives one real protocol worker into its test-only heap
 * ceiling, then requires its successor to reopen identical canonical state.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "../../../packages/host/node_modules/ws/wrapper.mjs";
import { HostServer, defaultWorkerMain } from "../../../packages/host/dist/index.js";

const MIB = 1024 * 1024;
const CEILING_MIB = 384;
const CEILING_BYTES = CEILING_MIB * MIB;
const MINIMUM_AVAILABLE_BYTES = 2 * 1024 * MIB;
const START_MARGIN_BYTES = 1024 * MIB;
const START_MINIMUM_BYTES = MINIMUM_AVAILABLE_BYTES + START_MARGIN_BYTES;
const DEADLINE_MS = 90_000;
const POLL_MS = 50;
const EVIDENCE_PATH = "/tmp/m18-t8-g-containment.json";
const OOM_MARKER = /Reached heap limit|heap out of memory|Allocation failed/i;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function memAvailableBytes() {
  const text = await readFile("/proc/meminfo", "utf8");
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  const value = match ? Number(match[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MemAvailable is unreadable");
  return value;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const stat = requireStat(pid);
    return stat.state !== "Z";
  } catch {
    return false;
  }
}

function requireStat(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], ppid: Number(fields[1]) };
}

async function descendantsOf(rootPid) {
  const entries = await (await import("node:fs/promises")).readdir("/proc", { withFileTypes: true });
  const children = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const pid = Number(entry.name);
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      const rows = children.get(ppid) ?? [];
      rows.push(pid);
      children.set(ppid, rows);
    } catch {
      // A process can leave while /proc is being walked.
    }
  }
  const found = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (found.includes(pid)) continue;
    found.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return found;
}

class RpcClient {
  constructor() {
    this.nextId = 1;
    this.inbound = [];
    this.pending = new Map();
  }

  async connect(url) {
    this.socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.inbound.push(message);
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    await new Promise((done, fail) => {
      this.socket.once("open", done);
      this.socket.once("error", fail);
    });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async waitFor(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.inbound.find(predicate);
      if (found) return found;
      await sleep(20);
    }
    throw new Error("host notification timed out");
  }

  close() {
    this.socket?.close();
  }
}

async function fakeProvider() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "containment", object: "chat.completion.chunk", created: 1, model: "scratch" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "state ready" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

async function writeEvidence(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.doesNotMatch(text, /\/home\/|sessionId|runId|projectCwd|credential|transcript|Fatal error|native stack/i);
  await writeFile(EVIDENCE_PATH, text, { mode: 0o600 });
}

async function main() {
  if (process.platform !== "linux") throw new Error("heap containment requires Linux /proc accounting");
  if (!existsSync(defaultWorkerMain())) throw new Error("build the protocol worker before running containment");

  const startedAt = Date.now();
  const startAvailableBytes = await memAvailableBytes();
  if (startAvailableBytes < START_MINIMUM_BYTES) {
    await writeEvidence({
      schemaVersion: 1,
      pass: false,
      refused: true,
      ceilingBytes: CEILING_BYTES,
      minimumRequiredStartBytes: START_MINIMUM_BYTES,
      startAvailableBytes,
      minimumAvailableBytes: startAvailableBytes,
      endAvailableBytes: startAvailableBytes,
      durationMs: 0,
      exitCategory: "not_started",
      restartCount: 0,
      canonicalRevisionConverged: false,
      canonicalLeafConverged: false,
      canonicalEntriesConverged: false,
      survivorCount: 0,
    });
    throw new Error("starting MemAvailable is below the containment preflight margin");
  }

  const root = await mkdtemp(join(tmpdir(), "heap-ceiling-containment-"));
  const trackedPids = new Set();
  let minimumAvailableBytes = startAvailableBytes;
  let host;
  let client;
  let provider;
  let oomMarker = false;
  let abnormalExit = false;
  let restartCount = 0;
  let canonicalRevisionConverged = false;
  let canonicalLeafConverged = false;
  let canonicalEntriesConverged = false;
  let forcedCleanup = false;
  let survivorCount = 0;
  let completed = false;

  try {
    for (const name of ["agent", "sessions", "state", "project"]) await mkdir(join(root, name), { recursive: true });
    provider = await fakeProvider();
    await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: {
      scratch: { baseUrl: provider.url, api: "openai-completions", apiKey: "scratch", models: [
        { id: "scratch", name: "Scratch", contextWindow: 8192, maxTokens: 256 },
      ] },
    } }));
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
      defaultProvider: "scratch", defaultModel: "scratch", enabledModels: ["scratch/scratch"],
    }));

    const trigger = join(root, "trigger");
    const consumed = join(root, "consumed");
    const wrapper = join(root, "worker-wrapper.mjs");
    // 191 rows × 8 MiB of logical array storage is finite and below 4×384 MiB.
    await writeFile(wrapper, `
import { existsSync, writeFileSync } from "node:fs";
import ${JSON.stringify(pathToFileURL(defaultWorkerMain()).href)};
const trigger = ${JSON.stringify(trigger)};
const consumed = ${JSON.stringify(consumed)};
const timer = setInterval(() => {
  if (!existsSync(trigger) || existsSync(consumed)) return;
  clearInterval(timer);
  writeFileSync(consumed, "once");
  const retained = [];
  for (let index = 0; index < 191; index += 1) retained.push(new Array(1024 * 1024).fill(index));
}, 25);
`);

    host = new HostServer({
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      stateDir: join(root, "state"),
      workerMain: wrapper,
      workerOldSpaceMiB: CEILING_MIB,
      workerIdleMs: 600_000,
      workerSweepMs: 0,
      log: (line) => { if (OOM_MARKER.test(line)) oomMarker = true; },
    });
    client = new RpcClient();
    await client.connect((await host.listen()).url);
    const cwd = join(root, "project");
    const created = await client.request("session/new", { cwd });
    await client.request("session/prompt", { path: created.state.path, content: [{ type: "text", text: "write durable state" }] });
    await client.waitFor((message) => message.method === "session/update"
      && message.params?.sessionPath === created.state.path && message.params?.update?.kind === "agent_settled", 45_000);

    const beforeRevision = await client.request("session/revision", { path: created.state.path });
    const beforeEntries = await client.request("pi/session/entries", { path: created.state.path });
    const initialPid = host.pool.workerInfo(cwd)?.pid;
    assert.ok(initialPid, "the protocol worker pid was not reported");
    trackedPids.add(initialPid);
    await writeFile(trigger, "go");

    const deadline = Date.now() + DEADLINE_MS;
    let sawOomStatus = false;
    let successorPid;
    while (Date.now() < deadline) {
      minimumAvailableBytes = Math.min(minimumAvailableBytes, await memAvailableBytes());
      for (const pid of await descendantsOf(process.pid)) trackedPids.add(pid);
      sawOomStatus ||= client.inbound.some((message) => message.method === "pi/worker/status"
        && message.params?.status === "crashed" && /ran out of memory/i.test(message.params?.message ?? ""));
      successorPid = host.pool.workerInfo(cwd)?.pid;
      const reopened = successorPid && successorPid !== initialPid && host.pool.openSessions(cwd).includes(created.state.path);
      if (sawOomStatus && reopened) break;
      await sleep(POLL_MS);
    }
    abnormalExit = sawOomStatus && !processAlive(initialPid);
    assert.ok(oomMarker, "the bounded worker stderr tail did not contain the OOM marker");
    assert.ok(abnormalExit, "the worker did not terminate abnormally as a classified OOM");
    assert.ok(successorPid && successorPid !== initialPid, "the successor worker did not start");
    trackedPids.add(successorPid);
    restartCount = 1;

    const afterRevision = await client.request("session/revision", { path: created.state.path });
    const afterEntries = await client.request("pi/session/entries", { path: created.state.path });
    canonicalRevisionConverged = afterRevision.revision === beforeRevision.revision;
    canonicalLeafConverged = afterEntries.leafId === beforeEntries.leafId;
    canonicalEntriesConverged = JSON.stringify(afterEntries.entries) === JSON.stringify(beforeEntries.entries);
    assert.ok(canonicalRevisionConverged && canonicalLeafConverged && canonicalEntriesConverged,
      "the successor did not reopen identical canonical state");
    assert.ok(minimumAvailableBytes >= MINIMUM_AVAILABLE_BYTES, "MemAvailable crossed the 2 GiB containment floor");
    completed = true;
  } finally {
    client?.close();
    await host?.close().catch(() => undefined);
    await provider?.close().catch(() => undefined);
    for (const pid of await descendantsOf(process.pid).catch(() => [])) trackedPids.add(pid);
    const alive = [...trackedPids].filter(processAlive);
    forcedCleanup = alive.length > 0;
    for (const pid of alive.reverse()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    for (let attempt = 0; attempt < 200 && [...trackedPids].some(processAlive); attempt += 1) await sleep(25);
    survivorCount = [...trackedPids].filter(processAlive).length;
    const endAvailableBytes = await memAvailableBytes().catch(() => minimumAvailableBytes);
    const pass = completed && oomMarker && abnormalExit && restartCount === 1
      && canonicalRevisionConverged && canonicalLeafConverged && canonicalEntriesConverged
      && minimumAvailableBytes >= MINIMUM_AVAILABLE_BYTES && !forcedCleanup && survivorCount === 0;
    await writeEvidence({
      schemaVersion: 1,
      pass,
      refused: false,
      ceilingBytes: CEILING_BYTES,
      startAvailableBytes,
      minimumAvailableBytes,
      endAvailableBytes,
      durationMs: Date.now() - startedAt,
      exitCategory: oomMarker && abnormalExit ? "heap_oom_abnormal" : "not_proven",
      restartCount,
      canonicalRevisionConverged,
      canonicalLeafConverged,
      canonicalEntriesConverged,
      survivorCount,
    });
    await rm(root, { recursive: true, force: true });
    if (!pass && completed) throw new Error("containment cleanup did not satisfy the final gate");
  }
}

try {
  await main();
  process.stdout.write(`${JSON.stringify({ pass: true, evidence: EVIDENCE_PATH })}\n`);
} catch (error) {
  process.stderr.write(`heap containment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
