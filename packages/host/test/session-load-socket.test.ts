import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { JsonRpcMessage, JsonRpcResponse } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";

let root: string;
let host: HostServer;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for socket messages");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-load-order-"));
  for (const name of ["agent", "sessions", "state", "ui"]) mkdirSync(join(root, name), { recursive: true });
  host = new HostServer({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    stateDir: join(root, "state"),
    uiDir: join(root, "ui"),
    logFile: false,
  });
});

afterEach(async () => {
  await host.close();
  rmSync(root, { recursive: true, force: true });
});

describe("HostServer session/load question ordering", () => {
  it("keeps updates before responses, questions after, and closes immediate across concurrent loads", async () => {
    const first = deferred();
    const second = deferred();
    let entered = 0;
    (host.router as unknown as { handle(raw: unknown): Promise<JsonRpcResponse> }).handle = async (raw) => {
      const request = raw as { id: number };
      entered++;
      await (request.id === 1 ? first.promise : second.promise);
      return { jsonrpc: "2.0", id: request.id, result: { state: { path: "/s/a" } } };
    };

    const { url } = await host.listen();
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const messages: JsonRpcMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => socket.once("open", resolve));

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { path: "/s/a", fromSeq: 0 } }));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { path: "/s/a", fromSeq: 0 } }));
    await until(() => entered === 2);
    host.notify("session/update", { sessionPath: "/s/a", seq: 1, at: new Date(0).toISOString(), update: { kind: "agent_start" } });
    host.notify("pi/ui/request", { path: "/s/a", id: "q", method: "confirm", title: "Continue?" });
    await until(() => messages.some((message) => "method" in message && message.method === "session/update"));
    expect(messages.some((message) => "method" in message && message.method === "pi/ui/request")).toBe(false);

    first.resolve();
    await until(() => messages.some((message) => "id" in message && message.id === 1));
    await until(() => messages.some((message) => "method" in message && message.method === "pi/ui/request"));
    const updateAt = messages.findIndex((message) => "method" in message && message.method === "session/update");
    const responseAt = messages.findIndex((message) => "id" in message && message.id === 1);
    const questionAt = messages.findIndex((message) => "method" in message && message.method === "pi/ui/request");
    expect(updateAt).toBeLessThan(responseAt);
    expect(responseAt).toBeLessThan(questionAt);

    host.notify("pi/ui/event", { path: "/s/a", method: "dialogResolved", id: "q" });
    await until(() => messages.some((message) => "method" in message && message.method === "pi/ui/event"));
    second.resolve();
    await until(() => messages.some((message) => "id" in message && message.id === 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages.filter((message) => "method" in message && message.method === "pi/ui/request")).toHaveLength(1);
    expect(messages.findIndex((message) => "method" in message && message.method === "pi/ui/event")).toBeLessThan(
      messages.findIndex((message) => "id" in message && message.id === 2),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
  }, 10_000);
});
