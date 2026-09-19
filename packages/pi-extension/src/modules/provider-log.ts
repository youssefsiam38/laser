/**
 * provider-log — feeds the logs page (M4-T5) and owns how a provider request
 * reaches it (RP-7).
 *
 * `before_provider_request` carries the **complete** serialized provider
 * payload: the whole conversation of that turn, every tool result included.
 * `after_provider_response` carries status and headers only (Pi exposes no raw
 * response body; the assembled assistant message comes from session events).
 *
 * The capture is a diagnostic, so it is the one thing on this link that may be
 * shaped by pressure. It is redacted and serialized **here**, once, so the
 * bytes that cross are the bytes that get stored and the app never rebuilds
 * them; a large one is split into bounded chunks so no single frame is large;
 * and one that is over the ceiling, or that arrives while the link is backed
 * up, or that this installation would not keep anyway, is recorded with its
 * exact size, digest and reason instead of its body. Nothing here ever waits
 * for the link, and no command, turn or question is delayed, paused or
 * cancelled by any of it.
 */
import { createHash, randomBytes } from "node:crypto";
import type { LaserModule } from "./index.js";
import type { BeforeProviderRequestEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CAPTURE_CHUNKED_ABOVE_BYTES,
  CAPTURE_RESPONSE_WAIT_MS,
  CAPTURE_STALL_DEADLINE_MS,
  CAPTURE_CHUNK_BYTES,
  CAPTURE_MAX_BYTES,
  WORKER_PIPE_SOFT_BYTES,
  redactForStorage,
  type InstructionSourceMap,
  type CaptureReservation,
  type ProviderCaptureLink,
  type ProviderCaptureMeta,
  type ProviderCaptureOmission,
  type ProviderCaptureSummary,
  type ProviderRequestContext,
} from "@lasercode/protocol";
import type { OutboundMessage as OutboundCapture } from "./index.js";

/** Leading characters kept on the row, matching the store's own preview. */
const PREVIEW_CHARS = 240;



/**
 * Pi's `estimateTokens` heuristic: ceil(chars / 4). Applied to sections of the
 * assembled provider payload — that payload is not an `AgentMessage`, so the
 * function itself cannot be called on it.
 */
const CHARS_PER_TOKEN = 4;

function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateValue(value: unknown): number {
  if (value == null) return 0;
  if (Array.isArray(value) && value.length === 0) return 0;
  if (typeof value === "string") return estimateText(value);
  try {
    const json = JSON.stringify(value);
    return json ? estimateText(json) : 0;
  } catch {
    return 0;
  }
}

function estimateMessages(messages: unknown[]): { chat: number; thinking: number } {
  let chat = 0;
  let thinking = 0;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      chat += estimateValue(raw);
      continue;
    }
    const msg = raw as Record<string, unknown>;
    const content = msg.content ?? msg.parts;
    if (!Array.isArray(content)) {
      chat += estimateValue(msg);
      continue;
    }
    const rest: unknown[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "thinking") {
        const block = part as { thinking?: unknown; text?: unknown };
        thinking += estimateValue(block.thinking ?? block.text ?? "");
      } else {
        rest.push(part);
      }
    }
    chat += estimateValue({ ...msg, content: rest });
  }
  return { chat, thinking };
}

/** Per-section token estimates for the live assembled request (spec C.4). */
export function estimateRequestComposition(payload: unknown): { tools: number; chat: number; thinking: number; system: number } | undefined {
  const body = payload as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return undefined;
  const messages = body.messages ?? body.input ?? body.contents;
  const tools = body.tools ?? body.tool_config ?? body.toolConfig;
  const system = body.system ?? body.instructions ?? body.systemPrompt ?? body.systemInstruction ?? body.system_instruction;
  const thinking = body.thinking ?? body.reasoning ?? body.reasoning_effort;
  const fromMessages = Array.isArray(messages) ? estimateMessages(messages) : { chat: estimateValue(messages), thinking: 0 };
  return {
    tools: estimateValue(tools),
    chat: fromMessages.chat,
    thinking: fromMessages.thinking + estimateValue(thinking),
    system: estimateValue(system),
  };
}

/** The row's line, without the app parsing a body it was handed whole. */
export function summarize(payload: unknown): ProviderCaptureSummary {
  const body = payload as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return {};
  const messages = body["messages"] ?? body["input"] ?? body["contents"];
  const tools = body["tools"];
  const thinking = body["thinking"] ?? body["reasoning"] ?? body["reasoning_effort"];
  const composition = estimateRequestComposition(payload);
  return {
    ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
    ...(Array.isArray(messages) ? { messages: messages.length } : {}),
    ...(Array.isArray(tools) ? { tools: tools.length } : {}),
    ...(body["stream"] === true ? { stream: true } : {}),
    ...(thinking !== undefined && thinking !== null ? { thinking: true } : {}),
    ...(composition ? { composition } : {}),
  };
}

export type EncodedCapture =
  | { ok: true; body: string; bytes: number; sha256: string; preview: string; redactedFields: number; depthOmissions: number }
  | { ok: false; reason: "unredacted"; survivors: string[] };

/**
 * Redact, serialize once, verify, and measure exactly what would be stored.
 *
 * The verification is the point: a credential-shaped field that survives the
 * projection means this text must not be kept at all, and the caller records
 * the request without a body instead. Nothing about a refused body — not even
 * its preview — is ever produced.
 */
export function encodeCapture(payload: unknown): EncodedCapture {
  const projected = redactForStorage(payload);
  if (!projected.ok) return { ok: false, reason: projected.reason, survivors: projected.survivors };
  const { body, redactedFields, depthOmissions } = projected;
  return {
    ok: true,
    body,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, PREVIEW_CHARS),
    redactedFields,
    depthOmissions,
  };
}

/**
 * Walk a body as bounded UTF-8 pieces, one at a time.
 *
 * Over the string's own code units, never over a Buffer of the whole body:
 * converting it first would hold a second copy of a multi-megabyte capture,
 * which is the thing this slice exists to not do. Each piece is measured in
 * the bytes it will really occupy — one, two, three or four per code point,
 * three for an unpaired surrogate, which is what a UTF-8 encoder writes for
 * one — and no piece ever splits a surrogate pair.
 */
export function* utf8Chunks(body: string, chunkBytes = CAPTURE_CHUNK_BYTES): Generator<string> {
  if (body.length === 0) {
    yield "";
    return;
  }
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < body.length) {
    const code = body.charCodeAt(index);
    let width: number;
    let step: number;
    if (code < 0x80) {
      width = 1;
      step = 1;
    } else if (code < 0x800) {
      width = 2;
      step = 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < body.length) {
      const low = body.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        width = 4;
        step = 2;
      } else {
        // An unpaired high surrogate: an encoder writes the replacement
        // character, which is three bytes.
        width = 3;
        step = 1;
      }
    } else {
      width = 3;
      step = 1;
    }
    if (bytes > 0 && bytes + width > chunkBytes) {
      yield body.slice(start, index);
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += step;
  }
  if (start < body.length) yield body.slice(start, body.length);
}

/** How many pieces {@link utf8Chunks} will produce, without building any. */
export function countUtf8Chunks(body: string, chunkBytes = CAPTURE_CHUNK_BYTES): number {
  let count = 0;
  let bytes = 0;
  let index = 0;
  if (body.length === 0) return 1;
  let started = false;
  while (index < body.length) {
    const code = body.charCodeAt(index);
    let width: number;
    let step: number;
    if (code < 0x80) {
      width = 1;
      step = 1;
    } else if (code < 0x800) {
      width = 2;
      step = 1;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < body.length) {
      const low = body.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        width = 4;
        step = 2;
      } else {
        width = 3;
        step = 1;
      }
    } else {
      width = 3;
      step = 1;
    }
    if (bytes > 0 && bytes + width > chunkBytes) {
      count += 1;
      bytes = 0;
    }
    bytes += width;
    index += step;
    started = true;
  }
  return started ? count + 1 : count;
}

/** The same pieces, collected. For callers that really want the list. */
export function chunkBody(body: string, chunkBytes = CAPTURE_CHUNK_BYTES): string[] {
  return [...utf8Chunks(body, chunkBytes)];
}

function newCaptureId(): string {
  return `c-${randomBytes(8).toString("hex")}`;
}

/**
 * Hand a large capture to the link, a bounded piece at a time.
 *
 * Before every piece the **raw** backlog is read — not net of what this
 * capture has written, which would exempt a capture from the mark it is
 * supposed to respect. Over the mark, the loop gives the link turns to write
 * what it holds; a link that takes them finishes the capture, and one that
 * does not gets an abort. What a stalled link is left holding is therefore the
 * mark, plus the chunk in flight, plus the small terminal frame.
 */
async function streamCapture(input: {
  send: (message: OutboundCapture) => void;
  link: ProviderCaptureLink | undefined;
  meta: ProviderCaptureMeta;
  body: string;
  bytes: number;
  reservation: CaptureReservation | undefined;
}): Promise<void> {
  const { send, link, meta, body, bytes, reservation } = input;
  try {
    // Counted without building anything, so `begin` can declare it and the
    // pieces are still produced one at a time.
    const total = countUtf8Chunks(body, CAPTURE_CHUNK_BYTES);
    send({ type: "lasercode/provider/request/begin", ...meta, chunks: total });
    let index = -1;
    for (const text of utf8Chunks(body, CAPTURE_CHUNK_BYTES)) {
      index += 1;
      const now = link?.now ?? Date.now;
      let pending = link?.pendingBytes() ?? 0;
      // Only when it matters: an idle link never waits. While the link is over
      // its mark the capture waits for it to actually move, and gives up only
      // if it is still over the mark when the deadline passes — a link doing
      // bounded work for the pieces it already has is not a stalled one.
      const deadline = now() + CAPTURE_STALL_DEADLINE_MS;
      while (pending > WORKER_PIPE_SOFT_BYTES && now() < deadline) {
        await (link?.drain?.() ?? Promise.resolve());
        pending = link?.pendingBytes() ?? 0;
      }
      if (pending > WORKER_PIPE_SOFT_BYTES) {
        send({ type: "lasercode/provider/request/abort", captureId: meta.captureId, reason: "link-busy" });
        return;
      }
      send({ type: "lasercode/provider/request/chunk", captureId: meta.captureId, index, text });
    }
    send({ type: "lasercode/provider/request/end", captureId: meta.captureId, chunks: total, bytes });
  } catch {
    // A send or a drain that threw. The capture stops here and says so; the
    // turn that produced it never learns about any of this.
    try {
      send({ type: "lasercode/provider/request/abort", captureId: meta.captureId, reason: "link-busy" });
    } catch {
      /* the link is gone; the host ends the capture when the process does */
    }
  } finally {
    // Every outcome: sent, aborted, thrown, or the process closing under it.
    reservation?.release();
  }
}

export const providerLogModule: LaserModule = {
  name: "provider-log",
  detect: () => true,
  activate({ pi, send, requestProvenance, captureLink }) {
    /**
     * This module instance's current capture, settled.
     *
     * A chunked request is sent behind its hook, so without this its response
     * row could be written before the request it answers. The response waits
     * for the capture it belongs to — briefly, and for the diagnostic only:
     * the provider call itself is long since done, and nothing about the turn
     * is delayed, queued or cancelled by this.
     */
    let settling: Promise<void> = Promise.resolve();
    const capture = (event: BeforeProviderRequestEvent, ctx: ExtensionContext, sources?: InstructionSourceMap[]) => {
      const prompt = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
      const context: ProviderRequestContext = {
        ...(prompt ? { promptEntryId: prompt.id } : {}),
        ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api } : {}),
        ...(sources ? { instructionSources: sources } : {}),
      };
      const at = new Date().toISOString();
      const keepsBodies = captureLink?.retainBodies() ?? true;
      const encoded = encodeCapture(event.payload);
      const base = {
        captureId: newCaptureId(),
        at,
        summary: summarize(event.payload),
        ...(Object.keys(context).length > 0 ? { context } : {}),
      };
      const meta: ProviderCaptureMeta = encoded.ok
        ? { ...base, bytes: encoded.bytes, sha256: encoded.sha256, preview: encoded.preview, redactedFields: encoded.redactedFields }
        : // A body that could not be made safe has no stored representation, so
          // it has no size, digest or preview either. They are left out rather
          // than reported as zero: nothing here was measured.
          { ...base, redactedFields: 0 };
      const omit = (reason: ProviderCaptureOmission): undefined => {
        send({ type: "lasercode/provider/request/omitted", ...meta, reason });
        return undefined;
      };
      if (!encoded.ok) return omit("unredacted");
      if (!keepsBodies) return omit("summary-mode");
      if (encoded.bytes > CAPTURE_MAX_BYTES) return omit("over-ceiling");
      if ((captureLink?.pendingBytes() ?? 0) > WORKER_PIPE_SOFT_BYTES) return omit("link-busy");

      if (encoded.bytes <= CAPTURE_CHUNKED_ABOVE_BYTES) {
        // The ordinary path, unchanged in shape: one message carrying the
        // payload the app redacts and stores exactly as it always has.
        send({ type: "lasercode/provider/request", at, payload: event.payload, summary: summarize(event.payload), ...(Object.keys(context).length > 0 ? { context } : {}) });
        return undefined;
      }

      // One authority for the whole worker: what every session's captures may
      // hold in this process while they are sent (RP-7). Taken **before** the
      // pieces are cut, so a capture that cannot be held never materialises
      // them, and released on every outcome.
      const reservation = captureLink?.reserve?.(encoded.bytes);
      if (captureLink?.reserve && !reservation) return omit("link-busy");
      // Behind the hook, never on the turn's way: the pieces go as the link
      // takes them, and nothing about a turn, a tool or a command waits.
      const streaming = streamCapture({
        send,
        link: captureLink,
        meta,
        body: encoded.body,
        bytes: encoded.bytes,
        reservation,
      }).catch(() => {
        // `streamCapture` handles its own failures; this is the last guard
        // against an unhandled rejection in a detached promise.
        reservation?.release();
      });
      settling = settling.then(() => streaming).catch(() => {});
      return undefined;
    };
    if (requestProvenance) requestProvenance.onRequest(capture);
    else pi.on("before_provider_request", async (event, ctx) => capture(event, ctx));
    pi.on("after_provider_response", async (event: { status: number; headers: Record<string, string> }) => {
      const at = new Date().toISOString();
      // Bounded, and the bound is cancelled the moment the capture settles: a
      // response that waits for nothing must not leave a timer behind it. A
      // capture that cannot finish still lets the response through — a late
      // row is better than a lost one.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CAPTURE_RESPONSE_WAIT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([settling, deadline]);
      } catch {
        /* a capture's own failure is not the response's business */
      } finally {
        if (timer) clearTimeout(timer);
      }
      send({ type: "lasercode/provider/response", at, status: event.status, headers: event.headers });
      return undefined;
    });
  },
};

export type { ProviderCaptureLink };
