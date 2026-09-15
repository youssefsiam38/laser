#!/usr/bin/env node
/**
 * RP-4 scratch evidence: does a real worker's heap stop growing when a person
 * opens and leaves many conversations?
 *
 * Run by hand, never in CI:
 *
 *   node packages/worker/test/scratch/heap-convergence.mjs [--sessions 50] [--cap 4]
 *
 * It spawns the **built** worker (`packages/worker/dist/main.js`) exactly as the
 * host does — one fd-3 pipe, one scratch agent/session directory, one loopback
 * provider with a fake key and no credentials anywhere — opens that many
 * sessions with a real turn each, releases the ones nothing is following
 * through `pi/session/unload`, and reads the worker's own heap through the
 * inspector after forcing a collection. The comparison is between the heap
 * after the first few sessions and the heap after all of them: a bounded
 * lifetime means the second number is close to the first, not a multiple.
 *
 * The artifact it writes is deliberately thin: counts, bytes and a verdict. No
 * pid, no inspector URL, no path, no transcript text, no provider payload.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { identity } from "../../../../scripts/identity/identity.mjs";

const checkout = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const { values } = parseArgs({
  options: {
    sessions: { type: "string" },
    cap: { type: "string" },
    artifact: { type: "string" },
  },
});
const SESSIONS = Number(values.sessions ?? 50);
const CAP = Number(values.cap ?? 4);
const ARTIFACT = resolve(values.artifact ?? "/tmp/m18-t4-convergence.json");
/** Sessions to open before the first measurement, so startup is not the baseline. */
const WARMUP = 5;

function loopbackProvider() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (const piece of ["a ", "short ", "answer"]) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

/** One worker over its real pipe, with the host's own framing. */
function startWorker(root, inspectPort) {
  const child = spawn(
    process.execPath,
    [`--inspect=${inspectPort}`, join(checkout, "packages/worker/dist/main.js"), "--cwd", join(root, "project"), "--agent-dir", join(root, "agent"), "--session-dir", join(root, "sessions"), "--state-dir", join(root, "state")],
    { stdio: ["ignore", "ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test" } },
  );
  const pipe = child.stdio[3];
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let inspectorUrl;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    const match = /ws:\/\/[^\s]+/.exec(text);
    if (match && !inspectorUrl) inspectorUrl = match[0];
  });
  pipe.setEncoding("utf8");
  pipe.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveRequest, reject });
      pipe.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    child,
    request,
    inspector: async () => {
      for (let attempt = 0; attempt < 100 && !inspectorUrl; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      if (!inspectorUrl) throw new Error("the worker did not open an inspector");
      return inspectorUrl;
    },
    stop: async () => {
      pipe.end();
      await new Promise((done) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); done(); });
      });
    },
  };
}

/** Node 24 has WebSocket built in; the inspector speaks CDP over it. */
async function inspectorSession(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => fail(new Error("the inspector refused the connection")), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++;
      pending.set(id, { resolve: done, reject: fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

/** Collect, then read the heap the worker is actually holding. */
async function settledHeap(cdp) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await new Promise((done) => setTimeout(done, 250));
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return Math.round(usage.usedSize);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), `${identity.name}-convergence-`));
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(root, dir), { recursive: true });
  const provider = await loopbackProvider();
  writeFileSync(
    join(root, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: provider.url, api: "openai-completions", apiKey: "scratch", models: [{ id: "stub-1", contextWindow: 8000, maxTokens: 500 }] } } }),
  );
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }));

  // The revision this evidence belongs to, so a report can never be quoted
  // against a head it was not produced from.
  const implementationSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const report = { implementationSha, sessions: SESSIONS, cap: CAP, warmup: WARMUP };
  // Phase one: a corpus of real conversations, written by a worker that is then
  // stopped. Measuring the worker that *created* them would measure a first
  // prompt waiting to be named (RP-4's `naming` pin), which is a different
  // claim; what a person does every day is open conversations that already
  // exist, and that is what phase two does.
  const builder = startWorker(root, 0);
  const paths = [];
  try {
    for (let index = 0; index < SESSIONS; index += 1) {
      const { state } = await builder.request("session/new", { cwd: join(root, "project") });
      await builder.request("session/prompt", { path: state.path, content: [{ type: "text", text: `hello ${index}` }] });
      paths.push(state.path);
    }
  } finally {
    await builder.stop();
  }

  const worker = startWorker(root, 0);
  let cdp;
  try {
    cdp = await inspectorSession(await worker.inspector());
    const visited = [];
    const release = async () => {
      // Everything except the most recent `CAP`, which stands in for what a
      // person is actually looking at.
      for (const path of visited.slice(0, Math.max(0, visited.length - CAP))) {
        const answer = await worker.request("pi/session/unload", { path, reason: "idle" });
        if (!answer.unloaded) {
          const kinds = (answer.pins ?? []).map((pin) => pin.kind);
          if (kinds.length > 0) {
            report.refusals = (report.refusals ?? 0) + 1;
            report.refusedBy = { ...(report.refusedBy ?? {}) };
            const key = kinds.join("+");
            report.refusedBy[key] = (report.refusedBy[key] ?? 0) + 1;
          }
        }
      }
      // Released sessions are no longer visits to reconsider.
      while (visited.length > CAP) visited.shift();
    };
    let seen = 0;
    const visit = async (count) => {
      for (let index = 0; index < count; index += 1) {
        const path = paths[seen];
        await worker.request("session/load", { path });
        visited.push(path);
        seen += 1;
        await release();
      }
    };

    await visit(WARMUP);
    report.afterWarmup = { heapBytes: await settledHeap(cdp), ...(await worker.request("pi/worker/retained-stores", {})).stores };
    await visit(SESSIONS - WARMUP);
    report.afterAll = { heapBytes: await settledHeap(cdp), ...(await worker.request("pi/worker/retained-stores", {})).stores };

    const growth = report.afterAll.heapBytes - report.afterWarmup.heapBytes;
    report.growthBytes = growth;
    report.growthPerSessionBytes = Math.round(growth / (SESSIONS - WARMUP));
    report.loadedSessions = report.afterAll.workerSessions?.count ?? null;
    report.replayBytes = report.afterAll.workerReplay?.bytes ?? null;
    report.verdict = {
      bounded: (report.loadedSessions ?? Infinity) <= CAP,
      // A conversation's runtime is megabytes; convergence means the marginal
      // cost of one more opened-and-left session is a small fraction of that.
      heapConverged: report.growthPerSessionBytes < 1_000_000,
    };
    report.ok = report.verdict.bounded && report.verdict.heapConverged;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    cdp?.close();
    await worker.stop();
    await new Promise((done) => provider.server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
  writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

await main();
