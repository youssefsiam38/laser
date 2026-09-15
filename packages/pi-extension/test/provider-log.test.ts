import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { CAPTURE_CHUNK_BYTES, CAPTURE_MAX_BYTES, WORKER_PIPE_SOFT_BYTES, type ProviderCaptureLink } from "@lasercode/protocol";
import { chunkBody, encodeCapture, providerLogModule, summarize } from "../src/modules/provider-log.js";

const ctx = {
  model: { provider: "openai", id: "test", api: "openai-responses" },
  sessionManager: {
    getBranch: () => [
      { type: "message", id: "earlier", message: { role: "user" } },
      { type: "message", id: "current", message: { role: "user" } },
      { type: "message", id: "tool", message: { role: "toolResult" } },
    ],
  },
} as unknown as ExtensionContext;

async function activate(link?: ProviderCaptureLink) {
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown>>();
  const send = vi.fn();
  await providerLogModule.activate({
    pi: { on: (name: string, handler: never) => handlers.set(name, handler) } as unknown as ExtensionAPI,
    send,
    ...(link ? { captureLink: link } : {}),
  });
  return { handlers, send };
}

/** A payload whose serialized size is comfortably above `bytes`. */
function payloadOf(bytes: number) {
  return { model: "test", messages: [{ role: "user", content: "x".repeat(bytes) }], tools: [{ name: "bash" }], stream: true };
}

it("records the last user on the active branch without rewriting the provider payload", async () => {
  const { handlers, send } = await activate();
  const payload = { model: "test", input: [{ role: "user", content: "question" }] };
  const result = await handlers.get("before_provider_request")!({ payload }, ctx);
  expect(result).toBeUndefined();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ payload, context: { promptEntryId: "current", provider: "openai", model: "test", api: "openai-responses" } }),
  );
  // The small path is unchanged in shape, including handing the payload over
  // by reference: the app redacts and stores it exactly as it always has.
  expect(send.mock.calls[0]?.[0].payload).toBe(payload);
});

it("chunks a large capture and proves it with a digest over the redacted bytes", async () => {
  const { handlers, send } = await activate();
  const payload = payloadOf(3 * 1024 * 1024);
  await handlers.get("before_provider_request")!({ payload }, ctx);
  const messages = send.mock.calls.map((call) => call[0]);
  const begin = messages[0];
  const chunks = messages.filter((message) => message.type === "lasercode/provider/request/chunk");
  const end = messages[messages.length - 1];

  expect(begin.type).toBe("lasercode/provider/request/begin");
  expect(end.type).toBe("lasercode/provider/request/end");
  expect(chunks).toHaveLength(begin.chunks);
  expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_chunk, index) => index));
  // No single frame is large, whatever the capture weighs.
  for (const chunk of chunks) expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(256 * 1024);

  const body = chunks.map((chunk) => chunk.text).join("");
  expect(Buffer.byteLength(body, "utf8")).toBe(begin.bytes);
  expect(end.bytes).toBe(begin.bytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(begin.sha256);
  expect(JSON.parse(body)).toEqual(payload);
  expect(begin.summary).toEqual({ model: "test", messages: 1, tools: 1, stream: true });
  expect(begin.context.promptEntryId).toBe("current");
});

it("redacts before anything crosses, on both paths", async () => {
  const { handlers, send } = await activate();
  const secret = { model: "test", authorization: "Bearer sk-live", messages: [{ role: "user", content: "y".repeat(3 * 1024 * 1024) }] };
  await handlers.get("before_provider_request")!({ payload: secret }, ctx);
  const body = send.mock.calls
    .map((call) => call[0])
    .filter((message) => message.type === "lasercode/provider/request/chunk")
    .map((message) => message.text)
    .join("");
  expect(body).not.toContain("sk-live");
  expect(JSON.parse(body).authorization).toBe("[redacted]");
  expect(JSON.parse(body).laserRedactedFields).toBe(1);
  expect(send.mock.calls[0]?.[0].redactedFields).toBe(1);
});

it("records a capture past the ceiling without its body, with size, digest and reason", async () => {
  const { handlers, send } = await activate();
  const payload = payloadOf(CAPTURE_MAX_BYTES + 1024);
  await handlers.get("before_provider_request")!({ payload }, ctx);
  expect(send).toHaveBeenCalledTimes(1);
  const message = send.mock.calls[0]![0];
  expect(message.type).toBe("lasercode/provider/request/omitted");
  expect(message.reason).toBe("over-ceiling");
  expect(message.bytes).toBeGreaterThan(CAPTURE_MAX_BYTES);
  expect(message.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(message.preview.length).toBeGreaterThan(0);
  expect(message.summary.model).toBe("test");
});

it("skips the body while the link to the app is backed up, and still records the request", async () => {
  const { handlers, send } = await activate({ pendingBytes: () => WORKER_PIPE_SOFT_BYTES + 1, retainBodies: () => true });
  await handlers.get("before_provider_request")!({ payload: payloadOf(2 * 1024 * 1024) }, ctx);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: "lasercode/provider/request/omitted", reason: "link-busy" });
});

it("stops a capture the moment the link fills, and says so once", async () => {
  // A clear pipe at the first chunk says nothing about the tenth: this loop
  // does not yield, so the link is re-read before every piece.
  let pending = 0;
  const { handlers, send } = await activate({
    pendingBytes: () => pending,
    retainBodies: () => true,
  });
  const sent: unknown[] = [];
  send.mockImplementation((message: unknown) => {
    sent.push(message);
    const type = (message as { type: string }).type;
    // The pipe fills while the capture is going out.
    if (type === "lasercode/provider/request/chunk") pending = WORKER_PIPE_SOFT_BYTES + 1;
  });
  await handlers.get("before_provider_request")!({ payload: payloadOf(3 * 1024 * 1024) }, ctx);

  const types = sent.map((message) => (message as { type: string }).type);
  expect(types[0]).toBe("lasercode/provider/request/begin");
  expect(types.filter((type) => type === "lasercode/provider/request/chunk")).toHaveLength(1);
  expect(types).not.toContain("lasercode/provider/request/end");
  // Exactly one terminal message, and it names the reason.
  const aborts = sent.filter((message) => (message as { type: string }).type === "lasercode/provider/request/abort");
  expect(aborts).toHaveLength(1);
  expect(aborts[0]).toMatchObject({ reason: "link-busy", captureId: (sent[0] as { captureId: string }).captureId });
  expect(types).not.toContain("lasercode/provider/request/omitted");

  // What it handed the link before stopping is bounded: the metadata, one
  // chunk, and the small terminal frame.
  const bytes = sent.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"), 0);
  expect(bytes).toBeLessThan(CAPTURE_CHUNK_BYTES * 2);
});

it("sends the whole capture while the link stays clear", async () => {
  const { handlers, send } = await activate({ pendingBytes: () => 0, retainBodies: () => true });
  await handlers.get("before_provider_request")!({ payload: payloadOf(2 * 1024 * 1024) }, ctx);
  const types = send.mock.calls.map((call) => call[0].type);
  expect(types).not.toContain("lasercode/provider/request/abort");
  expect(types[types.length - 1]).toBe("lasercode/provider/request/end");
});

it("sends nothing but a summary when this installation keeps no bodies", async () => {
  const { handlers, send } = await activate({ pendingBytes: () => 0, retainBodies: () => false });
  await handlers.get("before_provider_request")!({ payload: { model: "test", messages: [] } }, ctx);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: "lasercode/provider/request/omitted", reason: "summary-mode" });
});

it("keeps the small path when the link is idle and bodies are kept", async () => {
  const { handlers, send } = await activate({ pendingBytes: () => 0, retainBodies: () => true });
  await handlers.get("before_provider_request")!({ payload: { model: "test", messages: [] } }, ctx);
  expect(send.mock.calls[0]![0].type).toBe("lasercode/provider/request");
});

it("still reports responses", async () => {
  const { handlers, send } = await activate();
  await handlers.get("after_provider_response")!({ status: 200, headers: { "content-type": "application/json" } }, ctx);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: "lasercode/provider/response", status: 200 });
});

it("splits chunks on UTF-8 boundaries", () => {
  const text = "日本語".repeat(1000);
  const chunks = chunkBody(text, 100);
  expect(chunks.join("")).toBe(text);
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(100);
    // A chunk that was cut mid-character would decode with a replacement.
    expect(chunk).not.toContain("\ufffd");
  }
});

it("measures the stored representation, not the original payload", () => {
  const encoded = encodeCapture({ authorization: "Bearer x", a: 1 });
  expect(encoded.bytes).toBe(Buffer.byteLength(encoded.body, "utf8"));
  expect(createHash("sha256").update(encoded.body).digest("hex")).toBe(encoded.sha256);
  expect(encoded.body).toContain("[redacted]");
});

it("summarizes without a body", () => {
  expect(summarize({ model: "m", contents: [{}, {}], tools: [], reasoning_effort: "high" })).toEqual({ model: "m", messages: 2, tools: 0, thinking: true });
  expect(summarize(null)).toEqual({});
});
