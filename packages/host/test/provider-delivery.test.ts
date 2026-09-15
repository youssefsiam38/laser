import { afterEach, expect, it } from "vitest";
import { LOCAL_ACCESS } from "./actors.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { WIRE_NAMESPACE, type JsonRpcNotification, type LogPage, type ClientRequests } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";

/** One worker process's opaque identity, as the pool would supply it. */
const WORKER = { generation: "gen-test" };

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
    observe(cwd: string, n: JsonRpcNotification, source?: { generation: string }): void;
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
  const query = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s" } }, LOCAL_ACCESS);
  expect(query.error).toBeUndefined();
  const entry = (query.result as LogPage).entries[0]!;
  expect(entry.detailRef).toBeDefined();
  const content = await host.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/logs/content", params: { ref: entry.detailRef!.ref, maxBytes: 8 * 1024 * 1024 } }, LOCAL_ACCESS);
  expect(content.error).toBeUndefined();
  expect(JSON.parse((content.result as ClientRequests["pi/logs/content"]["result"]).text)).toEqual(payload);
  sockets.forEach(socket => socket.close());
}, 15_000);

it("keeps every chunked capture message inside the host, and still records the row", async () => {
  root = mkdtempSync(join(tmpdir(), "provider-delivery-chunked-"));
  host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state") });
  const { url } = await host.listen();
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
  const traffic: string[] = [];
  socket.on("message", data => traffic.push(data.toString()));
  await new Promise<void>(resolve => socket.once("open", resolve));
  const ingress = host as unknown as {
    observe(cwd: string, n: JsonRpcNotification, source?: { generation: string }): void;
    broadcast(n: JsonRpcNotification): void;
    notificationListeners: Set<(n: JsonRpcNotification) => void>;
  };
  const relay: JsonRpcNotification[] = [];
  ingress.notificationListeners.add(n => relay.push(n));

  // Exactly what the worker produces for a capture past the chunking
  // threshold: metadata, bounded pieces, and an end that proves the digest.
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "z".repeat(3 * 1024 * 1024) }] });
  const meta = {
    captureId: "c-0123456789abcdef",
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    chunks: 2,
    summary: { model: "m", messages: 1 },
  };
  const half = Math.floor(body.length / 2);
  const messages: unknown[] = [
    { type: `${WIRE_NAMESPACE}/provider/request/begin`, ...meta },
    { type: `${WIRE_NAMESPACE}/provider/request/chunk`, captureId: meta.captureId, index: 0, text: body.slice(0, half) },
    { type: `${WIRE_NAMESPACE}/provider/request/chunk`, captureId: meta.captureId, index: 1, text: body.slice(half) },
    { type: `${WIRE_NAMESPACE}/provider/request/end`, captureId: meta.captureId, chunks: 2, bytes: meta.bytes },
  ];
  for (const message of messages) {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method: "pi/extension/message", params: { path: "/s", message } };
    // Capture messages name the worker process they came from: the host only
    // accepts them with that identity (RP-7).
    ingress.observe(root, notification, WORKER);
    ingress.broadcast(notification);
  }
  host.notify("pi/project/updated", { projects: [] });
  await expect.poll(() => traffic.some(line => JSON.parse(line).method === "pi/project/updated")).toBe(true);
  expect(traffic.some(line => JSON.parse(line).method === "pi/extension/message")).toBe(false);
  expect(relay.some(n => n.method === "pi/extension/message")).toBe(false);
  expect(traffic.reduce((sum, line) => sum + Buffer.byteLength(line), 0)).toBeLessThan(20_000);

  const query = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s" } }, LOCAL_ACCESS);
  const entry = (query.result as LogPage).entries[0]!;
  expect(entry.detailRef?.ref).toBe(meta.sha256);
  const content = await host.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/logs/content", params: { ref: meta.sha256, maxBytes: 8 * 1024 * 1024 } }, LOCAL_ACCESS);
  expect((content.result as ClientRequests["pi/logs/content"]["result"]).text).toBe(body);
  socket.close();
}, 15_000);

it("records an aborted capture once, and keeps none of it", async () => {
  root = mkdtempSync(join(tmpdir(), "provider-delivery-abort-"));
  host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state") });
  const ingress = host as unknown as { observe(cwd: string, n: JsonRpcNotification, source?: { generation: string }): void };
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "z".repeat(2 * 1024 * 1024) }] });
  const meta = {
    captureId: "c-abababababababab",
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    chunks: 8,
    summary: { model: "m", messages: 1 },
  };
  const observe = (message: unknown) =>
    ingress.observe(root!, { jsonrpc: "2.0", method: "pi/extension/message", params: { path: "/s", message } }, WORKER);
  observe({ type: `${WIRE_NAMESPACE}/provider/request/begin`, ...meta });
  observe({ type: `${WIRE_NAMESPACE}/provider/request/chunk`, captureId: meta.captureId, index: 0, text: body.slice(0, 1000) });
  // The link filled while the worker was sending: it stops where it is.
  observe({ type: `${WIRE_NAMESPACE}/provider/request/abort`, captureId: meta.captureId, reason: "link-busy" });

  const query = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s" } }, LOCAL_ACCESS);
  const entries = (query.result as LogPage).entries;
  // Exactly one row for one request, and it says the body is not there.
  expect(entries).toHaveLength(1);
  const content = await host.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/logs/content", params: { ref: meta.sha256 } }, LOCAL_ACCESS);
  const result = content.result as ClientRequests["pi/logs/content"]["result"];
  expect(result.released).toMatchObject({ reason: "link-busy", bytes: meta.bytes, sha256: meta.sha256 });
  expect(result.text).toBe("");
}, 15_000);

it("records a capture the worker chose not to send, with its size, digest and reason", async () => {
  root = mkdtempSync(join(tmpdir(), "provider-delivery-omitted-"));
  host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state") });
  const ingress = host as unknown as { observe(cwd: string, n: JsonRpcNotification, source?: { generation: string }): void };
  const meta = {
    captureId: "c-fedcba9876543210",
    at: new Date().toISOString(),
    bytes: 20 * 1024 * 1024,
    sha256: "b".repeat(64),
    preview: '{"model":"m"',
    redactedFields: 2,
    summary: { model: "m", messages: 40 },
  };
  ingress.observe(
    root,
    {
      jsonrpc: "2.0",
      method: "pi/extension/message",
      params: { path: "/s", message: { type: `${WIRE_NAMESPACE}/provider/request/omitted`, ...meta, reason: "over-ceiling" } },
    },
    WORKER,
  );
  const content = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/content", params: { ref: meta.sha256 } }, LOCAL_ACCESS);
  const result = content.result as ClientRequests["pi/logs/content"]["result"];
  // No preview: the host keeps one only for text it defended itself (RP-7).
  expect(result.released).toMatchObject({ reason: "over-ceiling", bytes: meta.bytes, sha256: meta.sha256 });
  expect(result.released?.preview ?? "").toBe("");
  expect(result.text).toBe("");
}, 15_000);
