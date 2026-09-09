/**
 * M13-T22 · Namer qualifies without a sign-in.
 *
 * The regression: qualification only ever ran from a `pi/providers/login/event`
 * of type `done`, so an installation whose providers were already connected —
 * credentials on disk, or connected under an earlier host process — never
 * qualified, `namer.model` stayed null, and nothing was ever named or
 * labelled. Any worker coming up is now enough.
 *
 * Against a fake worker (a real child process speaking the fd-3 protocol), so
 * the spawn, the priming and the request are the real ones and no engine is
 * involved.
 */
import { PRODUCT_NAME, type AgentsSnapshot } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer } from "../../src/index.js";

const READY_NAMER = { status: "ready", model: { provider: "stub", id: "stub-nano" }, candidates: [], qualifiedAt: "2026-01-01T00:00:00.000Z" };

/**
 * A worker that answers the three requests this path needs and logs every
 * method it saw. `configured` says whether the stub provider has credentials;
 * with `loginAfter` set it connects one and announces it, the way a sign-in
 * through the UI does.
 */
function fakeWorker(options: { log: string; configured: boolean; loginAfter?: string }): string {
  return `
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(options.log)};
const LOGIN_AFTER = ${JSON.stringify(options.loginAfter ?? null)};
let configured = ${options.configured ? "true" : "false"};
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
    appendFileSync(LOG, req.method + "\\n");
    let result = { ok: true };
    if (req.method === "pi/providers/list") result = { providers: [{ id: "stub", name: "Stub", configured, methods: [] }] };
    else if (req.method === "agents/namer/qualify") result = ${JSON.stringify(READY_NAMER)};
    else if (req.method === "agents/skills") result = { skills: [], roots: [] };
    send({ jsonrpc: "2.0", id: req.id, result });
    if (LOGIN_AFTER && req.method === LOGIN_AFTER) {
      configured = true;
      send({ jsonrpc: "2.0", method: "pi/providers/login/event", params: { cwd, id: "login-1", provider: "stub", event: { type: "done" } } });
    }
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
`;
}

class Client {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly inbound: JsonRpcMessage[] = [];
  async connect(url: string) {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.ws.on("message", (d) => this.inbound.push(JSON.parse(d.toString()) as JsonRpcMessage));
    await new Promise<void>((r) => this.ws.once("open", () => r()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20_000);
      const on = () => {
        const hit = this.inbound.find((m) => "id" in m && m.id === id) as { result?: R; error?: { message: string } } | undefined;
        if (!hit) return;
        clearTimeout(timer);
        this.ws.off("message", on);
        if (hit.error) reject(new Error(hit.error.message));
        else resolve(hit.result as R);
      };
      this.ws.on("message", on);
      on();
    });
  }
  close() {
    this.ws.close();
  }
}

let base: string;
let project: string;
let workerMain: string;
let log: string;
let host: HostServer | undefined;
let client: Client | undefined;

const methodsSeen = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []);

async function startHost(): Promise<Client> {
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerMain,
    workerIdleMs: 0,
    log: () => {},
  });
  const { url } = await host.listen();
  client = new Client();
  await client.connect(url);
  return client;
}

const namerOf = async (c: Client) => (await c.request<AgentsSnapshot>("agents/list", {})).namer;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-namer-qualify-`));
  project = join(base, "project");
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, dir), { recursive: true });
  workerMain = join(base, "fake-worker.mjs");
  log = join(base, "methods.log");
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await host?.close();
  host = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("Namer qualification", () => {
  it("qualifies from a worker that comes up, with no sign-in in this host run", async () => {
    writeFileSync(workerMain, fakeWorker({ log, configured: true }));
    const c = await startHost();
    expect((await namerOf(c)).status).toBe("unqualified");
    // Anything that needs this project's worker is enough; nothing waits on
    // the benchmark, so the request itself answers first.
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(async () => expect((await namerOf(c)).status).toBe("ready"), { timeout: 10_000, interval: 25 });
    expect((await namerOf(c)).model).toEqual({ provider: "stub", id: "stub-nano" });
    expect(methodsSeen().filter((m) => m === "agents/namer/qualify")).toHaveLength(1);
    // A second worker request does not benchmark again.
    await c.request("agents/skills", { cwd: project });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(methodsSeen().filter((m) => m === "agents/namer/qualify")).toHaveLength(1);
  });

  it("waits for a provider, then qualifies when one is connected", async () => {
    // The sign-in is announced from a second, separate request, so the state
    // before it is observable rather than a race with the worker's start.
    writeFileSync(workerMain, fakeWorker({ log, configured: false, loginAfter: "pi/keybindings/get" }));
    const c = await startHost();
    // The worker starts, the provider list has no credentials in it, and Namer
    // is left alone rather than benchmarking nothing.
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(() => expect(methodsSeen()).toContain("pi/providers/list"), { timeout: 10_000, interval: 25 });
    expect(methodsSeen()).not.toContain("agents/namer/qualify");
    expect((await namerOf(c)).status).toBe("unqualified");
    // A provider is connected: a new provider set is a new attempt.
    await c.request("pi/keybindings/get", { cwd: project });
    await vi.waitFor(async () => expect((await namerOf(c)).status).toBe("ready"), { timeout: 10_000, interval: 25 });
    expect(methodsSeen().filter((m) => m === "agents/namer/qualify")).toHaveLength(1);
  });

  it("never benchmarks over a model that is already chosen", async () => {
    // A model picked by a person (or by an earlier run's benchmark) is what
    // the store loads with; nothing may spend a completion over it.
    writeFileSync(join(base, "state", "agents.json"), JSON.stringify({ namer: { status: "ready", model: { provider: "stub", id: "picked-1" }, candidates: [] } }));
    writeFileSync(workerMain, fakeWorker({ log, configured: true }));
    const c = await startHost();
    await c.request("agents/skills", { cwd: project });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(methodsSeen()).not.toContain("agents/namer/qualify");
    expect(await namerOf(c)).toMatchObject({ status: "ready", model: { provider: "stub", id: "picked-1" } });
  });
});
