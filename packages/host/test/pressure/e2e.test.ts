/**
 * The pressure boundary against a real host, a real socket and a real worker
 * process (RP-8, milestone E1).
 *
 * A worker proves which spawn it is with the private number the host minted for
 * it, and only then is a word of its report believed. What it said reaches the
 * host's own journal and summary; what a window is told is the summary, on a
 * local socket, with nothing private in it; and a listener standing exactly
 * where a paired device's relay client stands hears none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  MEMORY_PRESSURE_EVENT_ID,
  MEMORY_PRESSURE_PROJECT_ID,
  PRODUCT_NAME,
  PROJECT_DIR_NAME,
  parseMemoryPressurePublish,
  type JsonRpcMessage,
  type JsonRpcNotification,
} from "@lasercode/protocol";
import { HostServer } from "../../src/server.js";

/** A number nothing outside this host process may repeat. */
const MALFORMED_CANARY = 987_654_321;

/**
 * A worker that announces itself, then sends one truthful report stamped with
 * the generation its argv carries, and one message the contract would refuse.
 */
const WORKER = `
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const generation = Number(process.argv[process.argv.indexOf("--worker-generation") + 1]);
import { Socket } from "node:net";
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
    if (req.method === "pi/worker/retire") send({ jsonrpc: "2.0", id: req.id, result: { retiring: true } });
    else send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
send({
  jsonrpc: "2.0",
  method: "pi/resource/pressure",
  params: {
    generation,
    level: "warning",
    sampleAgeMs: 25,
    inputs: [
      { kind: "physical", value: { status: "available", value: 1400000000 }, warningBytes: 1342177280, criticalBytes: 2013265920 },
    ],
    ran: ["ephemeral_caches"],
    results: [{ action: "ephemeral_caches", outcome: "released", released: { count: 2, bytes: 4096 } }],
    stores: {},
  },
});
send({
  jsonrpc: "2.0",
  method: "pi/resource/pressure",
  params: { generation: ${MALFORMED_CANARY}, level: "enormous", secret: "/home/someone/private-project" },
});
`;

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private nextId = 1;
  /**
   * `origin` makes this socket a page: the boundary derives a `local_browser`
   * actor from the header a browser always sends, and its absence is the
   * command line or the shell itself (`access.ts`).
   */
  async connect(url: string, origin?: string): Promise<void> {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`, origin ? { origin } : {});
    this.ws.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.ws.once("open", () => resolve()));
  }
  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const listener = (data: unknown): void => {
        const message = JSON.parse(String(data)) as { id?: number; result?: R; error?: { message: string } };
        if (message.id !== id) return;
        this.ws.off("message", listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result as R);
      };
      this.ws.on("message", listener);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  notifications(method: string): JsonRpcNotification[] {
    return this.inbound.filter((message): message is JsonRpcNotification => "method" in message && message.method === method);
  }
  close(): void {
    this.ws.close();
  }
}

let base: string;
let host: HostServer;
let logs: string[];
let cwd: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pressure-e2e-`));
  for (const name of ["agent", "sessions", "state"]) mkdirSync(join(base, name), { recursive: true });
  const workerMain = join(base, "worker.mjs");
  writeFileSync(workerMain, WORKER);
  cwd = join(base, "project");
  mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, PROJECT_DIR_NAME, "settings.json"), "{}");
  logs = [];
  host = new HostServer({
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    workerMain,
    logFile: false,
    log: (line) => logs.push(line),
  });
});

afterEach(async () => {
  await host.close();
  rmSync(base, { recursive: true, force: true });
});

async function startWorker(client: Client): Promise<void> {
  await client.request("pi/project/add", { cwd });
  await client.request("pi/project/trust", { cwd, trusted: true });
  await client.request("pi/worker/restart", { cwd });
  // Long enough for both messages, sent before the worker answers anything.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe("a worker's report, end to end", () => {
  it("is believed on its own generation, recorded once, and answers for its worker", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    try {
      await startWorker(client);

      const counters = host.memoryPressure.counters();
      expect(counters.reportsAccepted).toBe(1);
      expect(counters.reportRows).toBe(1);
      // The second message is one the contract refuses, and it is refused.
      expect(counters.reportsMalformed).toBe(1);

      const page = host.memoryPressure.journalPage();
      expect(page.events).toHaveLength(1);
      const event = page.events[0]!;
      expect(event.id).toMatch(MEMORY_PRESSURE_EVENT_ID);
      expect(event).toMatchObject({ role: "project_worker", level: "warning", action: "ephemeral_caches", outcome: "released" });
      // The only identifier a row carries is the inventory's opaque project id.
      expect(event.project).toMatch(MEMORY_PRESSURE_PROJECT_ID);
      expect(JSON.stringify(page)).not.toContain(base);

      const summary = host.memoryPressure.summary();
      const workers = summary.roles.find((row) => row.role === "project_worker")!;
      expect(workers).toMatchObject({ level: "warning", coverage: { expected: 1, answered: 1, complete: true } });
      expect(summary.totals).toMatchObject({ events: 1, released: { count: 2, bytes: 4096 } });
    } finally {
      client.close();
    }
  });

  it("stops counting for that worker the moment the process goes", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    try {
      await startWorker(client);
      expect(host.memoryPressure.summary().roles.find((row) => row.role === "project_worker")!.level).toBe("warning");

      await client.request("pi/worker/stop", { cwd });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(host.memoryPressure.counters().workersForgotten).toBe(1);
      // No live worker at all: genuinely nothing to measure, and what that
      // worker actually did is still in the journal.
      expect(host.memoryPressure.summary().roles.find((row) => row.role === "project_worker")).toMatchObject({
        level: "normal",
        coverage: { expected: 0, answered: 0, complete: true },
      });
      expect(host.memoryPressure.journalPage().events).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});

describe("which sockets count as a window", () => {
  it("does not call the command line a renderer", async () => {
    // No `Origin`: the CLI, a script, the desktop shell's own process.
    const cli = new Client();
    await cli.connect((await host.listen()).url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const row = host.memoryPressure.summary().roles.find((entry) => entry.role === "desktop_renderer")!;
      // Genuinely nothing to measure: there is no window on this machine.
      expect(row).toMatchObject({ level: "normal", coverage: { expected: 0, answered: 0, complete: true } });
    } finally {
      cli.close();
    }
  });

  it("calls a page a window, and waits for its own evidence", async () => {
    const url = (await host.listen()).url;
    const page = new Client();
    await page.connect(url, url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const row = host.memoryPressure.summary().roles.find((entry) => entry.role === "desktop_renderer")!;
      // Connected, and has told this host nothing about its own memory yet.
      expect(row).toMatchObject({
        level: "unknown",
        coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" },
      });
    } finally {
      page.close();
    }
  });

  it("never counts a paired device, which is not on this machine at all", async () => {
    await host.listen();
    const relay: JsonRpcNotification[] = [];
    (host as unknown as { notificationListeners: Set<(n: JsonRpcNotification) => void> }).notificationListeners.add((n) => relay.push(n));
    const row = host.memoryPressure.summary().roles.find((entry) => entry.role === "desktop_renderer")!;
    expect(row).toMatchObject({ level: "normal", coverage: { expected: 0, answered: 0 } });
  });
});

describe("what a window is told, and what a paired device is not", () => {
  it("publishes the summary to a local socket and to nothing else", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    // Where a paired device's relay client subscribes (RP-13): the same set
    // `broadcast` writes to, reached through the established test seam.
    const relay: JsonRpcNotification[] = [];
    (host as unknown as { notificationListeners: Set<(n: JsonRpcNotification) => void> }).notificationListeners.add((n) => relay.push(n));
    try {
      await startWorker(client);
      // Startup now publishes its immediate host probe first; the worker row is
      // the coalesced next state, delivered within the fixed five-second window.
      await expect.poll(
        () => {
          const latest = client.notifications("resource/pressure").at(-1);
          return latest ? parseMemoryPressurePublish(latest.params).summary.roles.find((row) => row.role === "project_worker")?.level : undefined;
        },
        { timeout: 6_000 },
      ).toBe("warning");

      const published = client.notifications("resource/pressure");
      expect(published.length).toBeGreaterThan(0);
      const publication = parseMemoryPressurePublish(published.at(-1)!.params);
      expect(publication.epoch).toBeGreaterThan(0);
      expect(publication.summary.roles).toHaveLength(4);
      expect(publication.summary.roles.find((row) => row.role === "project_worker")!.level).toBe("warning");

      // Nothing private travels with it: not the spawn's number, not a path,
      // not the worker's own message.
      const seen = JSON.stringify(client.inbound);
      expect(seen).not.toContain("pi/resource/pressure");
      expect(seen).not.toContain(String(MALFORMED_CANARY));
      expect(seen).not.toContain("/home/someone/private-project");
      // The publications themselves name no directory at all. (A project row a
      // client asked for is another matter: `pi/project/updated` is a person's
      // own list of folders, and it is not this notification.)
      expect(JSON.stringify(published)).not.toContain(base);

      // The relay listener is live — it hears what a device may hear — and it
      // hears neither the private report nor the local publication.
      expect(relay.length).toBeGreaterThan(0);
      expect(relay.some((notification) => notification.method === "pi/worker/status")).toBe(true);
      expect(relay.some((notification) => notification.method === "pi/resource/pressure")).toBe(false);
      expect(relay.some((notification) => notification.method === "resource/pressure")).toBe(false);
      const relayed = JSON.stringify(relay);
      expect(relayed).not.toContain(String(MALFORMED_CANARY));
      expect(relayed).not.toContain("/home/someone/private-project");

      // And nothing of either message is in the host's own log.
      expect(logs.join("\n")).not.toContain(String(MALFORMED_CANARY));
      expect(logs.join("\n")).not.toContain("/home/someone/private-project");
      expect(logs.some((line) => line.includes("did not match the contract"))).toBe(true);
    } finally {
      client.close();
    }
  }, 10_000);

  it("carries the same summary on `resource/snapshot`, without the journal", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    try {
      await startWorker(client);
      const answer = await client.request<{ snapshot: { pressure?: { level: string; roles: unknown[] } } }>("resource/snapshot", {});
      expect(answer.snapshot.pressure).toBeDefined();
      expect(answer.snapshot.pressure!.roles).toHaveLength(4);
      // The summary joins to the journal by id; it does not carry it. No event
      // row, no retention block, no page.
      const carried = answer.snapshot.pressure as unknown as Record<string, unknown>;
      expect(carried).not.toHaveProperty("events");
      expect(carried).not.toHaveProperty("retention");
      expect(JSON.stringify(carried)).not.toContain("ephemeral_caches");
      expect(carried.latestEventId).toBe("mp_1");

      const exported = await client.request<{ document: string }>("resource/export", {});
      const document = JSON.parse(exported.document) as { pressure?: { journal: { events: Array<{ id: string }> } } };
      expect(document.pressure!.journal.events[0]!.id).toBe("mp_1");
      expect(exported.document).not.toContain(base);
    } finally {
      client.close();
    }
  });
});
