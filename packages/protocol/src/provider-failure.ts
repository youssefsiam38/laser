/**
 * Why a model request failed, in one word (M15-T3, `docs/model-fallback-chains.md` §2.4).
 *
 * The engine flattens a provider's HTTP status into the assistant message's
 * `errorMessage` string before anything above it can see it
 * (`pi-ai/dist/utils/error-body.js`), and `retry-after` is consumed inside the
 * provider SDK layer. The one structured signal that survives is the status and
 * headers of the response itself, which Pi's `after_provider_response` hook
 * hands the companion extension and the companion forwards to the worker.
 *
 * So classification reads the status when a response was actually observed for
 * this attempt, and falls back to matching the provider's own wording when
 * there was no response at all (a refused connection produces no status). The
 * patterns are the ones the engine itself matches on.
 *
 * The rule that keeps this honest: **an error we cannot name is `unknown`, and
 * `unknown` never causes a model to be switched.** Broad matching that guessed
 * would trade a visible provider error for a silent, wrong model change.
 *
 * Nothing here imports the engine, reads a file, or keeps a provider's body.
 */

export const PROVIDER_FAILURE_CLASSES = [
  /** The credential was not accepted (401, invalid key, expired session). */
  "credential",
  /** The credential is valid but not for this model or endpoint (403). */
  "permission",
  /** The account has no money left (402, insufficient quota, billing). */
  "credits",
  /** A subscription or usage window is spent (plan limits, allowance reset). */
  "allowance",
  /** Throttled right now (429 without plan wording). */
  "rate_limit",
  /** The provider is failing or overloaded (5xx, 529). */
  "provider_down",
  /** No response at all: DNS, refused, reset, hang-up, timeout. */
  "connection",
  /** This provider does not serve this model (404, unknown model). */
  "model_missing",
  /** The conversation no longer fits the model's context window. */
  "context_overflow",
  /** The provider refused the content. An answer, not an outage. */
  "safety",
  /** The person or the harness stopped the turn. */
  "aborted",
  /** Not recognised. Never a reason to switch models. */
  "unknown",
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/** The classes a fallback chain may act on. Everything else is excluded by design. */
export const FALLBACK_ELIGIBLE_FAILURES: readonly ProviderFailureClass[] = [
  "credential",
  "permission",
  "credits",
  "allowance",
  "rate_limit",
  "provider_down",
  "connection",
  "model_missing",
];

/**
 * The classes that will not fix themselves while this chain activation lasts.
 * They are cleared by a person selecting a model, never by a timer.
 */
export const NON_TRANSIENT_FAILURES: readonly ProviderFailureClass[] = [
  "credential",
  "permission",
  "credits",
  "model_missing",
];

export function isFallbackEligible(failure: ProviderFailureClass): boolean {
  return FALLBACK_ELIGIBLE_FAILURES.includes(failure);
}

export interface ProviderFailureSignal {
  /** The engine's flattened provider error, as it reached the assistant message. */
  errorMessage?: string | undefined;
  /** Pi's `StopReason`; only `"error"` can be a provider failure. */
  stopReason?: string | undefined;
  /**
   * The last `after_provider_response` observed **for this attempt**. A caller
   * that cannot prove the response belongs to this attempt must omit it: a
   * stale 200 would mask a connection failure.
   */
  response?: { status: number; headers?: Record<string, string> } | undefined;
}

export interface ProviderFailure {
  class: ProviderFailureClass;
  /**
   * When the provider stated a recovery instant, as an ISO string. Only ever
   * set from a header the provider actually sent; never invented, never guessed
   * from the class.
   */
  resetAt?: string;
}

const has = (haystack: string, ...needles: string[]) => needles.some((needle) => haystack.includes(needle));

/** Plan and allowance wording, taken from the engine's own non-retryable list. */
const ALLOWANCE_PATTERNS = [
  "gousagelimiterror",
  "freeusagelimiterror",
  "monthly usage limit reached",
  "weekly usage limit",
  "usage limit reached",
  "available balance",
  "plan limit",
  "subscription limit",
];

const CREDIT_PATTERNS = [
  "insufficient_quota",
  "insufficient quota",
  "credit balance",
  "out of budget",
  "quota exceeded",
  "billing",
  "payment required",
];

const CREDENTIAL_PATTERNS = [
  "authentication_error",
  "invalid_api_key",
  "invalid api key",
  "api key is invalid",
  "incorrect api key",
  "unauthorized",
  "no api key",
  "credentials may have expired",
];

const PERMISSION_PATTERNS = ["permission_error", "permission denied", "not allowed", "forbidden"];

const MODEL_MISSING_PATTERNS = ["model_not_found", "unknown model", "no such model", "does not exist"];

const CONTEXT_PATTERNS = [
  "context length",
  "context_length_exceeded",
  "context size",
  "maximum context",
  "too many tokens",
  "exceeds the available context",
  "prompt is too long",
];

const SAFETY_PATTERNS = [
  "content_filter",
  "content filter",
  "refused to complete",
  "stopped with: sensitive",
  "safety",
  "blocked by the provider",
];

const CONNECTION_PATTERNS = [
  "fetch failed",
  "network error",
  "connection error",
  "connection refused",
  "connection lost",
  "econnrefused",
  "econnreset",
  "enotfound",
  "eai_again",
  "epipe",
  "getaddrinfo",
  "socket hang up",
  "socket connection was closed",
  "other side closed",
  "upstream connect",
  "reset before headers",
  "websocket closed",
  "websocket error",
  "etimedout",
  "timed out",
  "timeout",
  "terminated",
  "stream ended",
  "did not get a response",
];

const PROVIDER_DOWN_PATTERNS = [
  "overloaded",
  "service unavailable",
  "service_unavailable",
  "internal server error",
  "internal error",
  "server error",
  "bad gateway",
  "provider returned error",
  "resourceexhausted",
];

const RATE_LIMIT_PATTERNS = ["rate limit", "rate_limit", "too many requests"];

/** A bare status code in the text, as providers prefix their payloads with one. */
const statusInText = (text: string, ...codes: number[]) =>
  codes.some((code) => new RegExp(`\\b${code}\\b`).test(text));

/**
 * Read one failed model request.
 *
 * Order matters: the most specific account condition wins over the status that
 * carried it, because a spent subscription allowance and an ordinary throttle
 * are both 429 and only one of them will clear on its own.
 */
export function classifyProviderFailure(signal: ProviderFailureSignal): ProviderFailure {
  if (signal.stopReason === "aborted") return { class: "aborted" };
  const text = (signal.errorMessage ?? "").toLowerCase();
  const status = signal.response?.status;
  const headers = normalizeHeaders(signal.response?.headers);
  // Headers first, then the provider's own sentence. In practice the sentence
  // is what there is: the provider SDKs throw on an error status before the
  // engine's `after_provider_response` hook runs, so a failed attempt usually
  // reaches us with no status and no headers at all — only the text the
  // engine flattened into `errorMessage`.
  const resetAt = parseProviderResetAt(headers) ?? statedResetAt(signal.errorMessage, Date.now());
  const withReset = (failure: ProviderFailureClass): ProviderFailure =>
    resetAt ? { class: failure, resetAt } : { class: failure };

  // Conditions the engine answers itself, before anything status-shaped.
  if (has(text, ...CONTEXT_PATTERNS)) return { class: "context_overflow" };
  if (has(text, ...SAFETY_PATTERNS)) return { class: "safety" };

  // A spent plan is stated in words, whatever status carried it.
  if (has(text, ...ALLOWANCE_PATTERNS)) return withReset("allowance");
  if (has(text, ...CREDIT_PATTERNS) || status === 402) return { class: "credits" };

  if (status !== undefined) {
    if (status === 401) return { class: "credential" };
    if (status === 403) return has(text, ...CREDENTIAL_PATTERNS) ? { class: "credential" } : { class: "permission" };
    if (status === 404) return { class: "model_missing" };
    if (status === 408) return { class: "connection" };
    if (status === 429) return withReset("rate_limit");
    if (status >= 500) return withReset("provider_down");
    // A 2xx/3xx observed for this attempt says the request reached the
    // provider, so whatever went wrong afterwards is not model access. Fall
    // through to the text: a stream can still drop mid-response.
  }

  if (has(text, ...CREDENTIAL_PATTERNS) || statusInText(text, 401)) return { class: "credential" };
  if (has(text, ...PERMISSION_PATTERNS) || statusInText(text, 403)) return { class: "permission" };
  if (statusInText(text, 402)) return { class: "credits" };
  if (has(text, ...MODEL_MISSING_PATTERNS) || statusInText(text, 404)) return { class: "model_missing" };
  if (has(text, ...RATE_LIMIT_PATTERNS) || statusInText(text, 429)) return withReset("rate_limit");
  if (has(text, ...PROVIDER_DOWN_PATTERNS) || statusInText(text, 500, 502, 503, 504, 524, 529)) {
    return withReset("provider_down");
  }
  // Transport failures are last: their words ("timeout", "terminated") appear
  // inside richer provider messages that the checks above name better.
  if (has(text, ...CONNECTION_PATTERNS)) return { class: "connection" };
  return { class: "unknown" };
}

/**
 * A recovery time the provider stated in words — "Please try again in 20s",
 * "retry after 2 minutes" — as an instant. Only an explicit statement counts;
 * a vague "try again later" is not a time and is left alone.
 */
export function statedResetAt(text: string | undefined, now: number): string | undefined {
  if (!text) return undefined;
  const match = /(?:try again in|retry after|retry in|available again in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2]!.toLowerCase();
  const factor = unit.startsWith("ms") || unit.startsWith("milli") ? 1
    : unit.startsWith("h") ? 3_600_000
    : unit.startsWith("m") && !unit.startsWith("ms") && (unit.startsWith("min") || unit === "m") ? 60_000
    : 1_000;
  const delay = amount * factor;
  if (delay <= 0 || delay > MAX_PROVIDER_RESET_MS) return undefined;
  return new Date(now + delay).toISOString();
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

/** Never accept a reset further away than this; a wrong day-long cooldown is worse than none. */
export const MAX_PROVIDER_RESET_MS = 6 * 60 * 60 * 1000;

/**
 * The instant a provider said it would be available again, or undefined.
 *
 * Headers, in the order providers set them. Anything unparseable, in the past,
 * or beyond {@link MAX_PROVIDER_RESET_MS} is ignored rather than rounded into a
 * number that would look authoritative.
 */
export function parseProviderResetAt(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): string | undefined {
  const h = normalizeHeaders(headers);
  const candidates: Array<number | undefined> = [
    millisIn(h["retry-after-ms"]),
    secondsOrDateIn(h["retry-after"], now),
    durationIn(h["x-ratelimit-reset-requests"]),
    durationIn(h["x-ratelimit-reset-tokens"]),
    epochOrDurationIn(h["x-ratelimit-reset"], now),
    epochOrDurationIn(h["anthropic-ratelimit-unified-reset"], now),
    epochOrDurationIn(h["x-ratelimit-reset-after"], now),
  ];
  for (const delay of candidates) {
    if (delay === undefined || !Number.isFinite(delay)) continue;
    if (delay <= 0 || delay > MAX_PROVIDER_RESET_MS) continue;
    return new Date(now + delay).toISOString();
  }
  return undefined;
}

function millisIn(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const millis = Number(value.trim());
  return Number.isFinite(millis) ? millis : undefined;
}

function secondsOrDateIn(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : at - now;
}

/** OpenAI's `6m0s` / `1.5s` / `300ms` form, as a delay in milliseconds. */
function durationIn(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  const parts = trimmed.match(/(\d+(?:\.\d+)?)(ms|s|m|h)/g);
  if (!parts || parts.length === 0) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  let total = 0;
  for (const part of parts) {
    const match = /(\d+(?:\.\d+)?)(ms|s|m|h)/.exec(part);
    if (!match) continue;
    const amount = Number(match[1]);
    switch (match[2]) {
      case "ms": total += amount; break;
      case "s": total += amount * 1000; break;
      case "m": total += amount * 60_000; break;
      case "h": total += amount * 3_600_000; break;
    }
  }
  return total;
}

/**
 * Either an epoch instant (seconds or milliseconds) or a delay. A value that
 * looks like a plausible absolute time is read as one; everything else is a
 * duration.
 */
function epochOrDurationIn(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    // Epoch seconds for any time after 2001; epoch millis for anything larger.
    if (numeric > 1_000_000_000_000) return numeric - now;
    if (numeric > 1_000_000_000) return numeric * 1000 - now;
    return numeric * 1000;
  }
  return durationIn(trimmed);
}
