/**
 * The chunked half of the provider-capture path, as a mapping (RP-7).
 *
 * The messages arrive on the host's own pipe to a worker it started, and the
 * only thing this does is give each one to the accumulator that owns it,
 * named by the worker process it came from. A client socket cannot reach this
 * code, and `broadcast` drops every capture message before serialization, so
 * no chunk ever leaves the host.
 *
 * It lives beside the accumulator rather than inside the server because the
 * server is a coordinator, and this is a translation.
 */
import { WIRE_NAMESPACE, type HostNotifications, type ProviderCaptureMeta, type ProviderCaptureOmission } from "@lasercode/protocol";
import type { CaptureAccumulator, CaptureActor } from "./provider-capture.js";

type ExtensionMessage = HostNotifications["pi/extension/message"]["message"];

/** Record a capture whose body never travelled, exactly as the accumulator would. */
export type RecordAbsent = (
  actor: CaptureActor,
  sessionPath: string,
  meta: ProviderCaptureMeta,
  reason: ProviderCaptureOmission,
) => void;

/** True when the message belonged here, so nothing else treats it as a row. */
export function observeCapture(
  captures: CaptureAccumulator,
  actor: CaptureActor,
  sessionPath: string,
  message: ExtensionMessage,
  recordAbsent: RecordAbsent,
): boolean {
  switch (message.type) {
    case `${WIRE_NAMESPACE}/provider/request/begin`: {
      const { type: _type, ...meta } = message as { type: string } & ProviderCaptureMeta;
      captures.begin(actor, sessionPath, meta);
      return true;
    }
    case `${WIRE_NAMESPACE}/provider/request/chunk`: {
      const chunk = message as { captureId: string; index: number; text: string };
      captures.chunk(actor, chunk.captureId, chunk.index, chunk.text);
      return true;
    }
    case `${WIRE_NAMESPACE}/provider/request/end`: {
      const end = message as { captureId: string; chunks: number; bytes: number };
      captures.finish(actor, end.captureId, end.chunks, end.bytes);
      return true;
    }
    case `${WIRE_NAMESPACE}/provider/request/abort`: {
      const abort = message as { captureId: string; reason: ProviderCaptureOmission };
      captures.abort(actor, abort.captureId, abort.reason);
      return true;
    }
    case `${WIRE_NAMESPACE}/provider/request/omitted`: {
      const { type: _type, reason, ...meta } = message as { type: string; reason: ProviderCaptureOmission } & ProviderCaptureMeta;
      recordAbsent(actor, sessionPath, meta, reason);
      return true;
    }
    default:
      return false;
  }
}
