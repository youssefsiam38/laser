import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { WIRE_NAMESPACE, type JsonRpcNotification, type LogPage, type ClientRequests } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";

let host: HostServer | undefined;
let root: string | undefined;
afterEach(async () => { await host?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

it("delivers log references, not raw captures, while retaining the complete inspector payload", async () => {
  root = mkdtempSync(join(tmpdir(), "provider-delivery-"));
  host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state") });
  const { url } = await host.listen();
  const sockets = [new WebSocket(`${url.replace("http", "ws")}/ws`), new WebSocket(`${url.replace("http", "ws")}/ws`)];
  const traffic: string[][] = [[], []];
  await Promise.all(sockets.map((socket, i) => {
    socket.on("message", data => traffic[i]!.push(data.toString()));
    return new Promise<void>(resolve => socket.once("open", resolve));
  }));
  // Same observation/broadcast boundary as the worker-pool callback; no engine
  // or paid provider is needed to inject an exact multi-megabyte capture.
  const ingress = host as unknown as {
    observe(cwd: string, n: JsonRpcNotification): void;
    broadcast(n: JsonRpcNotification): void;
    notificationListeners: Set<(n: JsonRpcNotification) => void>;
  };
  const relay: JsonRpcNotification[] = [];
  ingress.notificationListeners.add(n => relay.push(n));
  const payload = { messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) + " retained end" }] };
  const request: JsonRpcNotification = { jsonrpc: "2.0", method: "pi/extension/message", params: { path: "/s", message: { type: `${WIRE_NAMESPACE}/provider/request`, at: new Date().toISOString(), payload } } };
  const beforeBytes = Buffer.byteLength(JSON.stringify(request)) * sockets.length;
  ingress.observe(root, request); ingress.broadcast(request);
  const response: JsonRpcNotification = { jsonrpc: "2.0", method: "pi/extension/message", params: { path: "/s", message: { type: `${WIRE_NAMESPACE}/provider/response`, at: new Date().toISOString(), status: 200, headers: {} } } };
  ingress.observe(root, response); ingress.broadcast(response);
  host.notify("pi/ui/request", { path: "/s", id: "question", method: "confirm", title: "Continue?" });
  await expect.poll(() => traffic.every(lines => lines.some(line => JSON.parse(line).method === "pi/logs/append"))).toBe(true);
  for (const lines of traffic) {
    expect(lines.some(line => JSON.parse(line).method === "pi/extension/message")).toBe(false);
    expect(lines.some(line => JSON.parse(line).method === "pi/ui/request")).toBe(true);
  }
  expect(relay.some(n => n.method === "pi/extension/message")).toBe(false);
  expect(relay.some(n => n.method === "pi/ui/request")).toBe(true);
  const afterBytes = traffic.flat().reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  expect(afterBytes).toBeLessThan(20_000);
  console.log(JSON.stringify({ finding: "F03", beforeBytes, afterBytes }));
  const query = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s" } });
  expect(query.error).toBeUndefined();
  const entry = (query.result as LogPage).entries[0]!;
  expect(entry.detailRef).toBeDefined();
  const content = await host.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/logs/content", params: { ref: entry.detailRef!.ref, maxBytes: 8 * 1024 * 1024 } });
  expect(content.error).toBeUndefined();
  expect(JSON.parse((content.result as ClientRequests["pi/logs/content"]["result"]).text)).toEqual(payload);
  sockets.forEach(socket => socket.close());
}, 15_000);
