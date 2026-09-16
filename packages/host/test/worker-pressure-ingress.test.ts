/**
 * RP-8: a worker's own pressure report is the app talking to itself.
 *
 * It carries the private generation that spawn was given, and it is meant for
 * the host and nobody else. This proves the boundary against a real host, a
 * real socket and a real client: a worker sends a real-shaped report, and the
 * client — which is authorized for everything a local page is — never sees it,
 * nor the canary number inside it, and neither does a listener standing where a
 * paired device's relay client stands.
 *
 * The report the fake worker sends is a *valid* one, so this proves the
 * boundary against a legitimate producer rather than against a message the
 * contract would have refused anyway. The filtering itself is by method, not by
 * shape: a malformed report must be kept private too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PRODUCT_NAME, PROJECT_DIR_NAME, memoryPressureReportSchema, type JsonRpcMessage, type JsonRpcNotification } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";

/** The canary: a generation nothing outside the host process may repeat. */
const CANARY = 987_654_321;

/**
 * A worker that announces itself and then sends one pressure report, exactly
 * as `WorkerServer` does, before answering anything else.
 */
const WORKER = `
import { Socket } from "node:net";
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
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
send({
  jsonrpc: "2.0",
  method: "pi/resource/pressure",
  params: {
    generation: ${CANARY},
    level: "warning",
    inputs: [{ kind: "physical", value: { status: "available", value: 1 } }],
    ran: [],
    results: [],
    stores: {},
  },
});
`;

class Client {
  private ws!: WebSocket;
  readonly inbound: JsonRpcMessage[] = [];
  private nextId = 1;
  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
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
  close(): void {
    this.ws.close();
  }
}

let base: string;
let host: HostServer;
let logs: string[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pressure-ingress-`));
  mkdirSync(join(base, "agent"), { recursive: true });
  mkdirSync(join(base, "sessions"), { recursive: true });
  mkdirSync(join(base, "state"), { recursive: true });
  const workerMain = join(base, "worker.mjs");
  writeFileSync(workerMain, WORKER);
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

describe("a worker's pressure report at the host boundary", () => {
  it("reaches no client, no relay listener and no log", async () => {
    const client = new Client();
    await client.connect((await host.listen()).url);
    // Where a paired device's relay client subscribes (RP-13): the same set
    // `broadcast` writes to, reached through the established test seam.
    const relay: JsonRpcNotification[] = [];
    (host as unknown as { notificationListeners: Set<(n: JsonRpcNotification) => void> }).notificationListeners.add((n) => relay.push(n));
    const cwd = join(base, "project");
    mkdirSync(join(cwd, PROJECT_DIR_NAME), { recursive: true });
    writeFileSync(join(cwd, PROJECT_DIR_NAME, "settings.json"), "{}");
    try {
      await client.request("pi/project/add", { cwd });
      await client.request("pi/project/trust", { cwd, trusted: true });
      // A real, non-speculative worker: its notifications are the ones a client
      // is served from.
      await client.request("pi/worker/restart", { cwd });
      // Long enough for the report — sent before the worker answers anything —
      // to have been delivered if it were ever going to be.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The producer's own message is one the contract accepts …
      expect(memoryPressureReportSchema.safeParse({
        generation: CANARY,
        level: "warning",
        inputs: [{ kind: "physical", value: { status: "available", value: 1 } }],
        ran: [],
        results: [],
        stores: {},
      }).success).toBe(true);

      const seen = JSON.stringify(client.inbound);
      const relayed = JSON.stringify(relay);
      // Non-vacuous: this listener is live and does receive what a device may
      // hear, such as the worker's own status.
      expect(relay.length).toBeGreaterThan(0);
      expect(relay.some((notification) => notification.method === "pi/worker/status")).toBe(true);
      expect(relay.some((notification) => notification.method === "pi/resource/pressure")).toBe(false);
      expect(relayed).not.toContain(String(CANARY));
      expect(relayed).not.toContain("pi/resource/pressure");
      expect(client.inbound.some((message) => "method" in message && message.method === "pi/resource/pressure")).toBe(false);
      expect(seen).not.toContain(String(CANARY));
      expect(seen).not.toContain("pi/resource/pressure");
      // Not in the host's own log either: a private number is not a line.
      expect(logs.join("\n")).not.toContain(String(CANARY));
      // The worker is genuinely up, so the absence above is a decision rather
      // than a worker that never spoke.
      expect(host.pool.cwds()).toContain(cwd);
    } finally {
      client.close();
    }
  });
});
