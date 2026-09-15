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
  CAPTURE_DRAIN_ATTEMPTS,
  CAPTURE_CHUNK_BYTES,
  CAPTURE_MAX_BYTES,
  WORKER_PIPE_SOFT_BYTES,
  redactForStorage,
  type InstructionSourceMap,
  type ProviderCaptureLink,
  type ProviderCaptureMeta,
  type ProviderCaptureOmission,
  type ProviderCaptureSummary,
  type ProviderRequestContext,
} from "@lasercode/protocol";
import type { OutboundMessage as OutboundCapture } from "./index.js";

/** Leading characters kept on the row, matching the store's own preview. */
const PREVIEW_CHARS = 240;

/** The row's line, without the app parsing a body it was handed whole. */
export function summarize(payload: unknown): ProviderCaptureSummary {
  const body = payload as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return {};
  const messages = body["messages"] ?? body["input"] ?? body["contents"];
  const tools = body["tools"];
  const thinking = body["thinking"] ?? body["reasoning"] ?? body["reasoning_effort"];
  return {
    ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
    ...(Array.isArray(messages) ? { messages: messages.length } : {}),
    ...(Array.isArray(tools) ? { tools: tools.length } : {}),
    ...(body["stream"] === true ? { stream: true } : {}),
    ...(thinking !== undefined && thinking !== null ? { thinking: true } : {}),
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

/** Split on UTF-8 byte boundaries, so a chunk is never half a character. */
export function chunkBody(body: string, chunkBytes = CAPTURE_CHUNK_BYTES): string[] {
  const buffer = Buffer.from(body, "utf8");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(offset + chunkBytes, buffer.length);
    // Never cut inside a multi-byte sequence: walk back over continuation
    // bytes (0b10xxxxxx) so each chunk decodes on its own.
    while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(buffer.toString("utf8", offset, end));
    offset = end;
  }
  return chunks.length > 0 ? chunks : [""];
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
  chunks: string[];
  bytes: number;
}): Promise<void> {
  const { send, link, meta, chunks, bytes } = input;
  send({ type: "lasercode/provider/request/begin", ...meta, chunks: chunks.length });
  for (const [index, text] of chunks.entries()) {
    let pending = link?.pendingBytes() ?? 0;
    for (let attempt = 0; attempt < CAPTURE_DRAIN_ATTEMPTS && pending > WORKER_PIPE_SOFT_BYTES; attempt++) {
      // Only when it matters: an idle link never waits.
      await (link?.drain?.() ?? Promise.resolve());
      pending = link?.pendingBytes() ?? 0;
    }
    if (pending > WORKER_PIPE_SOFT_BYTES) {
      send({ type: "lasercode/provider/request/abort", captureId: meta.captureId, reason: "link-busy" });
      return;
    }
    send({ type: "lasercode/provider/request/chunk", captureId: meta.captureId, index, text });
  }
  send({ type: "lasercode/provider/request/end", captureId: meta.captureId, chunks: chunks.length, bytes });
}

export const providerLogModule: LaserModule = {
  name: "provider-log",
  detect: () => true,
  activate({ pi, send, requestProvenance, captureLink }) {
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
        send({ type: "lasercode/provider/request", at, payload: event.payload, ...(Object.keys(context).length > 0 ? { context } : {}) });
        return undefined;
      }

      const chunks = chunkBody(encoded.body);
      // Sent cooperatively, and not on the turn's way: the hook returns now,
      // and the pieces go as the link takes them. Nothing about a turn, a tool
      // or a command waits for this — a capture is a diagnostic, and the one
      // thing it may cost is itself.
      void streamCapture({ send, link: captureLink, meta, chunks, bytes: encoded.bytes });
      return undefined;
    };
    if (requestProvenance) requestProvenance.onRequest(capture);
    else pi.on("before_provider_request", async (event, ctx) => capture(event, ctx));
    pi.on("after_provider_response", async (event: { status: number; headers: Record<string, string> }) => {
      send({ type: "lasercode/provider/response", at: new Date().toISOString(), status: event.status, headers: event.headers });
      return undefined;
    });
  },
};

export type { ProviderCaptureLink };
