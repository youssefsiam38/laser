import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  CAPTURE_CHUNK_BYTES,
  CAPTURE_MAX_BYTES,
  CAPTURE_RESPONSE_WAIT_MS,
  CAPTURE_STALL_DEADLINE_MS,
  WORKER_PIPE_SOFT_BYTES,
  type ProviderCaptureLink,
} from "@lasercode/protocol";
import { chunkBody, countUtf8Chunks, encodeCapture, estimateRequestComposition, providerLogModule, summarize, utf8Chunks } from "../src/modules/provider-log.js";
import { CaptureReservations } from "../../worker/src/capture-reservations.js";

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
  expect(begin.summary).toMatchObject({ model: "test", messages: 1, tools: 1, stream: true });
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

it("stops a capture when the link stalls, and says so once", async () => {
  // A stalled link: the backlog is over the mark and never moves, whatever the
  // capture does. The raw backlog is what is read — a capture is not exempt
  // from the mark because the bytes there are its own — and the decision is
  // made on a clock, so this test drives that clock rather than waiting.
  let pending = 0;
  let clock = 0;
  let drains = 0;
  const { handlers, send } = await activate({
    pendingBytes: () => pending,
    retainBodies: () => true,
    now: () => clock,
    drain: async () => {
      drains += 1;
      // Time passes and the app reads nothing.
      clock += 50;
    },
  });
  const sent: Array<{ type: string; text?: string }> = [];
  send.mockImplementation((message: unknown) => {
    const entry = message as { type: string; text?: string };
    sent.push(entry);
    if (entry.type !== "lasercode/provider/request/chunk") return;
    pending += Buffer.byteLength(entry.text ?? "", "utf8");
    // The session's own updates arrive behind the first piece and nothing
    // reads them: from here the link is over its mark and stays there.
    pending = Math.max(pending, WORKER_PIPE_SOFT_BYTES + 1);
  });
  await handlers.get("before_provider_request")!({ payload: payloadOf(3 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const types = sent.map((message) => message.type);
  expect(types[0]).toBe("lasercode/provider/request/begin");
  expect(types.at(-1)).toBe("lasercode/provider/request/abort");
  expect(sent.at(-1)).toMatchObject({ reason: "link-busy", captureId: (sent[0] as unknown as { captureId: string }).captureId });
  expect(types).not.toContain("lasercode/provider/request/end");
  expect(types.filter((type) => type === "lasercode/provider/request/abort")).toHaveLength(1);
  expect(drains).toBeGreaterThan(0);
  // It gave up inside its own deadline, not before it and not for ever.
  expect(clock).toBeGreaterThanOrEqual(CAPTURE_STALL_DEADLINE_MS);
  expect(clock).toBeLessThan(CAPTURE_STALL_DEADLINE_MS * 2);

  // What a stalled link is left holding: the mark, the chunk in flight, and
  // the small terminal frame. Never the whole capture.
  expect(pending).toBeLessThanOrEqual(WORKER_PIPE_SOFT_BYTES + CAPTURE_CHUNK_BYTES + 1);
});

it("keeps sending while a busy link is doing bounded work for what it already took", async () => {
  // The case that failed the real end-to-end gate: a healthy fd-3 link that
  // sits above its mark for a while because the app is writing the pieces it
  // has taken. Counting turns called that stalled; a deadline does not.
  let pending = 0;
  let clock = 0;
  let drains = 0;
  const { handlers, send } = await activate({
    pendingBytes: () => pending,
    retainBodies: () => true,
    now: () => clock,
    drain: async () => {
      drains += 1;
      clock += 20;
      // The app takes a while per piece, and then takes it.
      if (drains % 20 === 0) pending = 0;
    },
  });
  const sent: string[] = [];
  send.mockImplementation((message: unknown) => {
    const entry = message as { type: string; text?: string };
    sent.push(entry.type);
    if (entry.type === "lasercode/provider/request/chunk") pending += Buffer.byteLength(entry.text ?? "", "utf8") + WORKER_PIPE_SOFT_BYTES;
  });
  await handlers.get("before_provider_request")!({ payload: payloadOf(4 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(sent).not.toContain("lasercode/provider/request/abort");
  expect(sent.at(-1)).toBe("lasercode/provider/request/end");
});

it("finishes a near-ceiling capture when the link keeps draining", async () => {
  // A healthy link: the backlog rises as chunks go and falls when the app
  // reads. The capture completes, chunk after chunk.
  let pending = 0;
  const { handlers, send } = await activate({
    pendingBytes: () => pending,
    retainBodies: () => true,
    drain: async () => {
      // The app read what was waiting.
      pending = 0;
    },
  });
  const sent: Array<{ type: string; text?: string }> = [];
  let maxPending = 0;
  send.mockImplementation((message: unknown) => {
    const entry = message as { type: string; text?: string };
    sent.push(entry);
    if (entry.type !== "lasercode/provider/request/chunk") return;
    pending += Buffer.byteLength(entry.text ?? "", "utf8");
    maxPending = Math.max(maxPending, pending);
  });
  await handlers.get("before_provider_request")!({ payload: payloadOf(15 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const types = sent.map((message) => message.type);
  expect(types[0]).toBe("lasercode/provider/request/begin");
  expect(types.at(-1)).toBe("lasercode/provider/request/end");
  expect(types).not.toContain("lasercode/provider/request/abort");
  const body = sent.filter((message) => message.type === "lasercode/provider/request/chunk").map((message) => message.text).join("");
  expect(Buffer.byteLength(body, "utf8")).toBe((sent[0] as unknown as { bytes: number }).bytes);
  // Even while completing, the link is never asked to hold more than its mark
  // plus the piece in flight.
  expect(maxPending).toBeLessThanOrEqual(WORKER_PIPE_SOFT_BYTES + CAPTURE_CHUNK_BYTES);
});

it("redacts a credential that only appears at serialization time", async () => {
  const { handlers, send } = await activate();
  // `toJSON` used to produce a credential after the structural pass. The
  // projection canonicalises first, so this is redacted and the capture is
  // kept — nothing about it is refused, and nothing leaks.
  const hostile = {
    model: "test",
    evidence: {
      toJSON() {
        return { api_key: "sk-live-canary-9c1" };
      },
    },
  };
  await handlers.get("before_provider_request")!({ payload: hostile }, ctx);
  const message = send.mock.calls[0]![0];
  expect(message.type).toBe("lasercode/provider/request");
  expect(JSON.stringify(message.payload)).toContain("sk-live-canary-9c1");
  // The payload object is the engine's; what the app *stores* is the redacted
  // projection, which the host applies on this path. The producer's own
  // measurement of it carries no secret.
  expect(encodeCapture(hostile)).toMatchObject({ ok: true });
  const encoded = encodeCapture(hostile);
  expect(encoded.ok && encoded.body).not.toContain("sk-live-canary-9c1");
});

it("publishes no size or digest for a body it could not make safe", () => {
  // The refusal path, exercised at the projection it comes from: when there is
  // no safe stored representation there is nothing to measure, and nothing is
  // reported as if there were.
  const refused = { ok: false, reason: "unredacted", survivors: ["api_key"] } as const;
  expect(refused.ok).toBe(false);
  expect(Object.keys(refused)).not.toContain("bytes");
  expect(Object.keys(refused)).not.toContain("sha256");
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

it("holds only what the process allows, across sessions, and releases it", async () => {
  // Two sessions, one authority. The first capture is still going out — its
  // link is over the mark and nothing drains — so it keeps its room, and the
  // second is refused with a row rather than held or silently dropped.
  const reservations = new CaptureReservations(20 * 1024 * 1024, 2);
  let firstCall = true;
  const holding: ProviderCaptureLink = {
    pendingBytes: () => {
      // Clear when the capture starts, backed up from its first chunk on.
      if (firstCall) {
        firstCall = false;
        return 0;
      }
      return WORKER_PIPE_SOFT_BYTES + 1;
    },
    retainBodies: () => true,
    drain: () => new Promise<void>(() => {}),
    reserve: (bytes) => reservations.reserve(bytes),
  };
  const one = await activate(holding);
  one.send.mockImplementation(() => {});
  await one.handlers.get("before_provider_request")!({ payload: payloadOf(15 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reservations.held().open).toBe(1);
  expect(reservations.held().bytes).toBeGreaterThan(15 * 1024 * 1024);

  // The second session asks the same authority, and there is no room.
  const blocked: unknown[] = [];
  const two = await activate({
    pendingBytes: () => 0,
    retainBodies: () => true,
    drain: async () => {},
    reserve: (bytes) => reservations.reserve(bytes),
  });
  two.send.mockImplementation((message: unknown) => blocked.push(message));
  await two.handlers.get("before_provider_request")!({ payload: payloadOf(15 * 1024 * 1024) }, ctx);
  expect(blocked[0]).toMatchObject({ type: "lasercode/provider/request/omitted", reason: "link-busy" });
  expect(reservations.held().open).toBe(1);

  // A capture that fits beside it is kept, and gives its room back.
  const third: unknown[] = [];
  two.send.mockImplementation((message: unknown) => third.push(message));
  await two.handlers.get("before_provider_request")!({ payload: payloadOf(2 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((third[0] as { type: string }).type).toBe("lasercode/provider/request/begin");
  expect(reservations.held().open).toBe(1);
});

it("releases its reservation when the link throws, without failing the turn", async () => {
  const reservations = new CaptureReservations();
  const { handlers, send } = await activate({
    pendingBytes: () => 0,
    retainBodies: () => true,
    drain: async () => {
      throw new Error("the link went away");
    },
    reserve: (bytes) => reservations.reserve(bytes),
  });
  let sends = 0;
  send.mockImplementation(() => {
    sends += 1;
    // Everything after the first message fails, as a closed pipe would.
    if (sends > 1) throw new Error("write after end");
  });
  // The hook itself must not fail, whatever the link does.
  await expect(handlers.get("before_provider_request")!({ payload: payloadOf(3 * 1024 * 1024) }, ctx)).resolves.toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(reservations.held()).toEqual({ bytes: 0, open: 0 });
});

it("keeps a response behind the request it answers", async () => {
  const order: string[] = [];
  let releaseDrain = () => {};
  let started = false;
  const { handlers, send } = await activate({
    // Clear when the capture starts; over its mark from the first chunk on, so
    // every piece waits on the drain below until the app reads again.
    pendingBytes: () => (started ? WORKER_PIPE_SOFT_BYTES + 1 : 0),
    retainBodies: () => true,
    drain: () => new Promise<void>((resolve) => { releaseDrain = resolve; }),
  });
  send.mockImplementation((message: unknown) => {
    const type = (message as { type: string }).type;
    if (type === "lasercode/provider/request/begin") started = true;
    order.push(type);
  });

  await handlers.get("before_provider_request")!({ payload: payloadOf(3 * 1024 * 1024) }, ctx);
  const response = handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The response has not overtaken the capture that is still going out.
  expect(order).not.toContain("lasercode/provider/response");
  // The app starts reading again: the pieces go, and the capture ends.
  started = false;
  releaseDrain();
  await response;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settled = order.indexOf("lasercode/provider/response");
  const terminal = Math.max(
    order.lastIndexOf("lasercode/provider/request/end"),
    order.lastIndexOf("lasercode/provider/request/abort"),
  );
  expect(terminal).toBeGreaterThanOrEqual(0);
  expect(settled).toBeGreaterThan(terminal);
});

it("waits longer for a response than a capture may stall", () => {
  // A response must never overtake a capture that is still inside its own
  // allowance, so the one bound is derived from the other.
  expect(CAPTURE_RESPONSE_WAIT_MS).toBeGreaterThan(CAPTURE_STALL_DEADLINE_MS);
});

it("leaves no timer behind an ordinary response", async () => {
  const { handlers, send } = await activate({ pendingBytes: () => 0, retainBodies: () => true, drain: async () => {} });
  send.mockImplementation(() => {});
  await handlers.get("before_provider_request")!({ payload: payloadOf(2 * 1024 * 1024) }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  await handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx);
  const after = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  // The wait is cancelled when the capture wins it: an ordinary turn does not
  // arm a two-second timer per response.
  expect(after).toBeLessThanOrEqual(before);
});

it("still reports responses", async () => {
  const { handlers, send } = await activate();
  await handlers.get("after_provider_response")!({ status: 200, headers: { "content-type": "application/json" } }, ctx);
  expect(send.mock.calls[0]![0]).toMatchObject({ type: "lasercode/provider/response", status: 200 });
});

it("produces pieces one at a time, without a copy of the body", () => {
  // The generator must not convert the whole body first: that was a second
  // copy of a multi-megabyte capture, and comments said otherwise.
  const from = Buffer.from;
  const large: number[] = [];
  const alloc = Buffer.allocUnsafe;
  try {
    (Buffer as unknown as { from: typeof Buffer.from }).from = ((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "string" && value.length > 512 * 1024) large.push(value.length);
      return (from as (v: unknown, ...r: unknown[]) => Buffer)(value, ...rest);
    }) as typeof Buffer.from;
    const body = JSON.stringify({ model: "m", content: "z".repeat(4 * 1024 * 1024) });
    const iterator = utf8Chunks(body, CAPTURE_CHUNK_BYTES);
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(Buffer.byteLength(first.value as string, "utf8")).toBeLessThanOrEqual(CAPTURE_CHUNK_BYTES);
    // Nothing body-sized was converted to produce that piece.
    expect(large).toEqual([]);
    expect(countUtf8Chunks(body, CAPTURE_CHUNK_BYTES)).toBe(Math.ceil(Buffer.byteLength(body, "utf8") / CAPTURE_CHUNK_BYTES));
    expect(large).toEqual([]);
    // And the pieces still reassemble exactly.
    expect([...utf8Chunks(body, CAPTURE_CHUNK_BYTES)].join("")).toBe(body);
  } finally {
    (Buffer as unknown as { from: typeof Buffer.from }).from = from;
    (Buffer as unknown as { allocUnsafe: typeof Buffer.allocUnsafe }).allocUnsafe = alloc;
  }
});

it("counts and cuts multi-byte text the same way", () => {
  for (const sample of ["日本語".repeat(20_000), "🚀".repeat(20_000), `${"a".repeat(1000)}🚀${"b".repeat(1000)}`]) {
    const pieces = [...utf8Chunks(sample, 1024)];
    expect(pieces.join("")).toBe(sample);
    expect(pieces.length).toBe(countUtf8Chunks(sample, 1024));
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(1024);
      expect(piece).not.toContain("\ufffd");
    }
  }
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
  expect(summarize({ model: "m", contents: [{}, {}], tools: [], reasoning_effort: "high" })).toMatchObject({ model: "m", messages: 2, tools: 0, thinking: true, composition: { tools: 0, chat: 2, thinking: 1, system: 0 } });
  expect(summarize(null)).toEqual({});
});

it("estimates tools / chat / thinking / system from the assembled request", () => {
  const payload = {
    model: "test",
    system: "You are a coding agent that writes careful patches.",
    messages: [
      { role: "user", content: "Please inspect the telemetry fold and name every wrong number." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The live authority is merging every run in the project." },
          { type: "text", text: "Three numbers on screen are wrong." },
        ],
      },
    ],
    tools: [{ name: "bash", description: "Run a shell command in the project", input_schema: { type: "object" } }],
    thinking: { type: "enabled", budget_tokens: 8000 },
  };
  const composition = estimateRequestComposition(payload);
  expect(composition).toEqual(summarize(payload).composition);
  expect(composition!.tools).toBeGreaterThan(0);
  expect(composition!.chat).toBeGreaterThan(0);
  expect(composition!.thinking).toBeGreaterThan(0);
  expect(composition!.system).toBeGreaterThan(0);
});
