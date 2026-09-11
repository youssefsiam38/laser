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

/**
 * Plan and allowance wording. The one thing a status genuinely cannot tell
 * apart: a spent subscription window and an ordinary throttle are both 429.
 */
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

/** Quota exhaustion, read only alongside a 429/403 — never from prose alone. */
const QUOTA_PATTERNS = ["insufficient_quota", "insufficient quota", "credit balance", "out of budget", "quota exceeded"];

/** Credential wording, read only alongside a 403 to split it from a permission refusal. */
const CREDENTIAL_PATTERNS = [
  "authentication_error",
  "invalid_api_key",
  "invalid api key",
  "api key is invalid",
  "incorrect api key",
];

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
  "blocked by the provider",
];

/**
 * Transport failures, which are the one class that never carries a status:
 * the request did not complete, so there is nothing to read but the errno or
 * the fetch wording. Every entry here names a socket, a DNS lookup or a fetch
 * — nothing that could appear in a provider's description of a bad request.
 */
const CONNECTION_PATTERNS = [
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "eai_again",
  "etimedout",
  "epipe",
  "getaddrinfo",
  "connection refused",
  // The OpenAI SDK's own `APIConnectionError` message, which is what a
  // provider closing the socket looks like from inside the engine.
  "connection error",
  "connection lost",
  "socket hang up",
  "socket connection was closed",
  "other side closed",
  "client network socket disconnected",
  // A stream that died between its start and its terminal event: the request
  // reached the provider and the connection did not survive it.
  "stream ended before",
  "stream ended without",
  "ended without",
  // undici's wording when a socket dies mid-stream, which is what a provider
  // dropping the connection looks like from inside the engine.
  "terminated",
];

/**
 * The HTTP status the engine flattened into the message.
 *
 * `formatProviderError` composes `"<status>: <body>"` or `"<prefix> (<status>): <message>"`
 * (`pi-ai/dist/utils/error-body.js`), and the provider SDKs prefix their own
 * messages the same way, so the status is there to be read even though the
 * structured response never reaches us for a failed request. Only those two
 * shapes are accepted: a bare number anywhere in the text is a number, not a
 * status — "Requested 500 tokens" is not a server error.
 */
export function statusInMessage(text: string | undefined): number | undefined {
  // Two shapes only, both anchored: the status at the very start of the
  // message (the SDKs' own `"429 You exceeded…"`, and the engine's
  // `"<status>: <body>"`), or parenthesised before a colon (the engine's
  // `"<prefix> (<status>): <message>"`). A bare number anywhere else is a
  // number, not a status — "Requested 500 tokens exceeds the cap" is a bad
  // request, not a server error.
  const anchored = /^\s*\(?(\d{3})\)?[\s:\-]/.exec(text ?? "");
  const parenthesised = /\((\d{3})\)\s*:/.exec(text ?? "");
  const match = anchored ?? parenthesised;
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

export function classifyProviderFailure(signal: ProviderFailureSignal): ProviderFailure {
  if (signal.stopReason === "aborted") return { class: "aborted" };
  const text = (signal.errorMessage ?? "").toLowerCase();
  const headers = normalizeHeaders(signal.response?.headers);
  // Headers first, then the provider's own sentence. In practice the sentence
  // is what there is: the provider SDKs throw on an error status before the
  // engine's `after_provider_response` hook runs, so a failed attempt usually
  // reaches us with no status object at all — only the text the engine
  // flattened into `errorMessage`, which carries the status inside it.
  const resetAt = parseProviderResetAt(headers) ?? statedResetAt(signal.errorMessage, Date.now());
  const withReset = (failure: ProviderFailureClass): ProviderFailure =>
    resetAt ? { class: failure, resetAt } : { class: failure };

  // Conditions the engine answers itself, whatever status carried them.
  if (has(text, ...CONTEXT_PATTERNS)) return { class: "context_overflow" };
  if (has(text, ...SAFETY_PATTERNS)) return { class: "safety" };

  const status = signal.response?.status ?? statusInMessage(signal.errorMessage);
  if (status !== undefined) {
    if (status === 401) return { class: "credential" };
    if (status === 402) return { class: "credits" };
    if (status === 403) {
      if (has(text, ...ALLOWANCE_PATTERNS)) return withReset("allowance");
      if (has(text, ...QUOTA_PATTERNS)) return { class: "credits" };
      return has(text, ...CREDENTIAL_PATTERNS) ? { class: "credential" } : { class: "permission" };
    }
    if (status === 404) return { class: "model_missing" };
    if (status === 408 || status === 504) return { class: "connection" };
    if (status === 429) {
      if (has(text, ...ALLOWANCE_PATTERNS)) return withReset("allowance");
      if (has(text, ...QUOTA_PATTERNS)) return { class: "credits" };
      return withReset("rate_limit");
    }
    if (status >= 500) return withReset("provider_down");
    // Every other 4xx is a request the provider would not accept — a tool
    // schema it dislikes, a field it does not know, a value out of range.
    // Nothing about model access, and switching model would hide the bug
    // and mark a working model unusable, so it stays `unknown` (which never
    // switches). 2xx/3xx fall through: a response arrived, and whatever went
    // wrong afterwards can still be a dropped stream.
    if (status >= 400) return { class: "unknown" };
  }

  // No status at all. Only two things may be read out of prose: a spent plan,
  // which no status distinguishes, and a transport failure, which never has
  // one.
  if (has(text, ...ALLOWANCE_PATTERNS)) return withReset("allowance");
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

/**
 * What happened, for a person: one clause that completes "<model> …". Shared by
 * the worker (which composes the live update) and the transcript (which
 * composes the same sentence from a durable record), so a switch reads the
 * same way whether it just happened or is being read back a week later. Never
 * a provider payload, never a credential.
 */
export function failureWording(failure: ProviderFailureClass): string {
  switch (failure) {
    case "credential":
      return "did not accept its credential";
    case "permission":
      return "refused this request";
    case "credits":
      return "has no credit left";
    case "allowance":
      return "has used up its allowance";
    case "rate_limit":
      return "is being rate-limited";
    case "provider_down":
      return "is not answering";
    case "connection":
      return "could not be reached";
    case "model_missing":
      return "is no longer offered by its provider";
    case "context_overflow":
      return "cannot hold this conversation";
    case "safety":
      return "declined to answer";
    case "aborted":
      return "was stopped";
    default:
      return "failed";
  }
}
