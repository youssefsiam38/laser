/**
 * How a provider request reaches the log store (RP-7).
 *
 * A provider request body is the whole conversation of that turn. It used to
 * cross worker → host as one extension message carrying the live payload
 * object, which the host then parsed, redacted (a second copy), re-serialized
 * (a third) and hashed. On a long session that is megabytes per model call,
 * through a decoder that was quadratic, for a body most people never open.
 *
 * Now the worker serializes it **once**, already redacted, and says how large
 * it is and what its digest is. Small captures travel exactly as they always
 * did. A large one is chunked, so no single frame is large. One that is over
 * the ceiling, or that arrives while the link is backed up, or that the store
 * would discard anyway, is recorded **without** its body — with its exact
 * size, digest and reason, so the row never pretends the request was smaller
 * or that nothing was captured.
 *
 * `bytes` and `sha256` always describe the **redacted stored representation**,
 * which is the only thing anybody can ever read back. Every surface that shows
 * them says so.
 */
import { WIRE_NAMESPACE } from "./identity.js";
import type { ProviderRequestContext } from "./pi-extension.js";

/**
 * Every extension message type that carries, or stands in for, a provider
 * request body. One predicate, so the host's broadcast filter cannot fall
 * behind a new capture message: nothing here reaches a client, a relay
 * listener or an audit line.
 */
export const PROVIDER_CAPTURE_MESSAGE_TYPES: readonly string[] = [
  `${WIRE_NAMESPACE}/provider/request`,
  `${WIRE_NAMESPACE}/provider/response`,
  `${WIRE_NAMESPACE}/provider/request/begin`,
  `${WIRE_NAMESPACE}/provider/request/chunk`,
  `${WIRE_NAMESPACE}/provider/request/end`,
  `${WIRE_NAMESPACE}/provider/request/abort`,
  `${WIRE_NAMESPACE}/provider/request/omitted`,
];

export function isProviderCaptureMessage(message: unknown): boolean {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && PROVIDER_CAPTURE_MESSAGE_TYPES.includes(type);
}

/** The row's own line, computed by the producer so the host parses nothing. */
export interface ProviderCaptureSummary {
  model?: string;
  messages?: number;
  tools?: number;
  stream?: boolean;
  thinking?: boolean;
  /** Token estimates for the assembled request; absent when it cannot be measured. */
  composition?: { tools: number; chat: number; thinking: number; system: number };
}

export interface ProviderCaptureMeta {
  /** Opaque, fixed-width, unique within one worker generation. */
  captureId: string;
  at: string;
  /**
   * Size of the redacted, stored representation in UTF-8 bytes.
   *
   * Absent — not zero — when there is no such representation to measure,
   * which is the case for a body that could not be made safe to keep. A
   * measurement nobody took is never published as one.
   */
  bytes?: number;
  /** SHA-256 of exactly those bytes; absent for the same reason. */
  sha256?: string;
  /** Leading characters of the redacted body; absent when there is no safe body. */
  preview?: string;
  /** How many credential-shaped fields the producer replaced. */
  redactedFields: number;
  /** Chunks the body was split into; absent when there is no body to send. */
  chunks?: number;
  summary: ProviderCaptureSummary;
  context?: ProviderRequestContext;
}

/**
 * Why a capture carries no body.
 *
 * `over-ceiling` — larger than {@link CAPTURE_MAX_BYTES}.
 * `link-busy` — the link to the host was backed up; a diagnostic waits, work does not.
 * `summary-mode` — this installation stores summaries only.
 * `interrupted` — the stream stopped before it ended, or a bound evicted it.
 * `corrupt` — what arrived did not match the size, order or digest declared.
 * `unredacted` — a credential-shaped field survived redaction, so nothing was kept.
 */
export type ProviderCaptureOmission =
  | "over-ceiling"
  | "link-busy"
  | "summary-mode"
  | "interrupted"
  | "corrupt"
  | "unredacted";

/** One sentence per reason, shared by the store and the inspector. */
export const PROVIDER_CAPTURE_OMISSION_REASONS: Readonly<Record<ProviderCaptureOmission, string>> = {
  "over-ceiling": "larger than the size this app keeps in full",
  "link-busy": "the link to the app was busy when it was captured",
  "summary-mode": "this installation keeps request summaries only",
  interrupted: "the capture stopped before it finished",
  corrupt: "what arrived did not match what was announced",
  unredacted: "a credential-shaped field could not be removed from it",
};

export function isProviderCaptureId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}
