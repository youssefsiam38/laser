/**
 * M22-T5 · the host runs the one-way migration onto Model Profiles behind the
 * first worker, and offers the seeded profiles for review when a provider is
 * connected (`docs/model-profiles.md`, "Migration").
 *
 * Against a fake worker (a real child process speaking the fd-3 protocol), so
 * the spawn, the priming and the request are the real ones and no engine is
 * involved. The worker is the only writer of the settings file, so what it
 * answers is what the host has to believe.
 */
import { PRODUCT_NAME, type AgentsSnapshot } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage } from "@lasercode/protocol";
import { HostServer } from "../../src/index.js";

const BALANCED = "mp_testbalanced000000000";
const FAST = "mp_testfast00000000000000";
const MIGRATION_REPORT = {
  ran: true,
  profiles: [
    { id: BALANCED, name: "Balanced", models: [{ provider: "stub", id: "stub-1" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: FAST, name: "Fast", models: [{ provider: "stub", id: "stub-nano" }], origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
  assignments: { defaultProfileId: BALANCED, namingProfileId: FAST, oracleProfileId: BALANCED, designIndexProfileId: BALANCED },
  notes: ["Created Balanced and Fast from the models you have connected."],
};

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
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
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
    else if (req.method === "models/profiles/migrate") result = { report: ${JSON.stringify(MIGRATION_REPORT)} };
    else if (req.method === "agents/skills") result = { skills: [], roots: [] };
    send({ jsonrpc: "2.0", id: req.id, result });
    if (LOGIN_AFTER && req.method === LOGIN_AFTER) {
      configured = true;
      send({ jsonrpc: "2.0", method: "pi/providers/login/event", params: { cwd, id: "login-1", provider: "stub", event: { type: "done" } } });
    }
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
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
  notifications(method: string): unknown[] {
    return this.inbound.filter((m) => "method" in m && m.method === method).map((m) => (m as { params: unknown }).params);
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

const builtinProfilesOf = async (c: Client) => (await c.request<AgentsSnapshot>("agents/list", {})).builtinProfiles;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-profiles-migration-`));
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

describe("the model-profile migration at host start", () => {
  it("runs once behind the first worker and gives every built-in a profile", async () => {
    writeFileSync(workerMain, fakeWorker({ log, configured: true }));
    const c = await startHost();
    expect(await builtinProfilesOf(c)).toEqual({ beam: null, chat: null, namer: null });
    // Anything that needs this project's worker is enough; nothing waits on
    // the migration, so the request itself answers first.
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(async () => expect((await builtinProfilesOf(c)).beam).toBe(BALANCED), { timeout: 10_000, interval: 25 });
    // Naming takes the naming assignment; the conversational built-ins take
    // the profile new conversations use.
    expect(await builtinProfilesOf(c)).toEqual({ beam: BALANCED, chat: BALANCED, namer: FAST });
    expect(methodsSeen().filter((m) => m === "models/profiles/migrate")).toHaveLength(1);

    // The preview a person reads is written under the state directory, once.
    const record = JSON.parse(readFileSync(join(base, "state", "model-profiles-migration.json"), "utf8")) as {
      version: number;
      settings: { ran: boolean; notes: string[] };
      builtins?: Array<{ name: string; to: string | null }>;
    };
    expect(record.version).toBe(1);
    expect(record.settings.ran).toBe(true);
    expect(record.settings.notes.join(" ")).toContain("Balanced");
    expect(record.builtins?.some((entry) => entry.name === "namer")).toBe(true);
  });

  it("offers the seeded profiles for review when a provider is connected, once", async () => {
    writeFileSync(workerMain, fakeWorker({ log, configured: false, loginAfter: "pi/keybindings/get" }));
    const c = await startHost();
    await c.request("pi/keybindings/get", { cwd: project });
    await vi.waitFor(async () => expect((await builtinProfilesOf(c)).beam).toBe(BALANCED), { timeout: 10_000, interval: 25 });
    // The seeded set is offered, never applied silently.
    expect(c.notifications("models/profiles/seeded")).toHaveLength(1);
    expect(c.notifications("models/profiles/seeded")[0]).toMatchObject({ profiles: [{ name: "Balanced" }, { name: "Fast" }] });
  });

  it("never overrules a built-in profile a person already chose", async () => {
    writeFileSync(join(base, "state", "agents.json"), JSON.stringify({ builtinProfiles: { beam: null, chat: null, namer: "mp_testpicked00000000000" } }));
    writeFileSync(workerMain, fakeWorker({ log, configured: true }));
    const c = await startHost();
    await c.request("agents/skills", { cwd: project });
    await vi.waitFor(async () => expect((await builtinProfilesOf(c)).beam).toBe(BALANCED), { timeout: 10_000, interval: 25 });
    expect((await builtinProfilesOf(c)).namer).toBe("mp_testpicked00000000000");
  });
});
