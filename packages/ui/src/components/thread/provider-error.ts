/**
 * A provider's failure, written for a person (R3, AGENTS.md "Errors are
 * written for a person").
 *
 * What Pi hands us is what the provider said, and providers answer machines:
 *
 *     401 {"type":"error","error":{"type":"authentication_error",
 *          "message":"API key is invalid."},"request_id":null}
 *
 * Putting that in the transcript tells someone their key is wrong only if they
 * already know how to read it, and the row's one button — "Continue" — resends
 * the prompt to a provider that just refused it, which fails again in exactly
 * the same way. So this reads the payload and answers the two questions a
 * person actually has: what happened, and what to do about it.
 *
 * Three rules:
 *
 *  - **Nothing is thrown away.** The raw payload stays available behind a
 *    disclosure, because the person debugging a local model server needs it.
 *  - **An unrecognised failure is still a sentence.** When nothing matches, the
 *    provider's own `message` field is used if there is one, and the raw text
 *    only if there is not.
 *  - **"Continue" is offered only where continuing can work.** Retrying is
 *    right for a rate limit, an overload or a dropped connection. It is wrong,
 *    and slightly insulting, for a rejected key or an exhausted context.
 */

/** Where the fix lives, when the fix is inside this app. */
export type ProviderErrorDestination = "models";

export interface ProviderFailure {
  /** What happened, in one sentence. */
  headline: string;
  /** What to do next, in one sentence. Absent when there is nothing useful to say. */
  next?: string;
  /** The settings tab that fixes it, when one does. */
  destination?: ProviderErrorDestination;
  /** Whether sending the same prompt again could plausibly succeed. */
  retryable: boolean;
  /** The provider's own words, for the disclosure. Absent when it adds nothing. */
  raw?: string;
}

/**
 * Pull the provider's human sentence out of a payload.
 *
 * Providers wrap it differently (`{error:{message}}`, `{message}`,
 * `{error:"…"}`) and prefix it with a status code, so the JSON is found by its
 * first brace rather than by parsing the whole string.
 */
function messageIn(detail: string): string | undefined {
  const start = detail.indexOf("{");
  if (start === -1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail.slice(start));
  } catch {
    return undefined;
  }
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > 4 || typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record["message"] === "string" && record["message"].trim() !== "") return record["message"].trim();
    if (typeof record["error"] === "string" && record["error"].trim() !== "") return record["error"].trim();
    for (const nested of Object.values(record)) {
      const found = walk(nested, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(parsed, 0);
}

/** One line: the whole payload matters, not just its JSON body. */
const has = (haystack: string, ...needles: string[]) => needles.some((needle) => haystack.includes(needle));

/**
 * Read a provider's error into something a person can act on.
 *
 * `detail` is whatever Pi recorded — a status line, a JSON payload, a socket
 * error, or nothing at all.
 */
export function readProviderFailure(detail: string | undefined): ProviderFailure | undefined {
  const text = (detail ?? "").trim();
  if (text === "") return undefined;
  const lower = text.toLowerCase();
  const raw = text;

  if (has(lower, "authentication_error", "invalid_api_key", "invalid api key", "api key is invalid", "incorrect api key", "unauthorized") || /\b401\b/.test(lower)) {
    return {
      headline: "The provider rejected the credential for this model.",
      next: "Sign in again, or paste a new key, under Providers and models.",
      destination: "models",
      retryable: false,
      raw,
    };
  }

  if (has(lower, "insufficient_quota", "credit balance", "billing", "payment required", "quota exceeded") || /\b402\b/.test(lower)) {
    return {
      headline: "This account has no credit left with the provider.",
      next: "Add credit with the provider, then send the message again.",
      retryable: false,
      raw,
    };
  }

  if (has(lower, "permission_error", "permission denied", "not allowed", "forbidden") || /\b403\b/.test(lower)) {
    return {
      headline: "The provider refused this request for this key.",
      next: "The key may not have access to this model. Pick another model, or use a key that does.",
      destination: "models",
      retryable: false,
      raw,
    };
  }

  if (has(lower, "context length", "context_length_exceeded", "context size", "maximum context", "too many tokens", "exceeds the available context")) {
    return {
      headline: "This conversation is longer than the model can hold.",
      next: "Start a new session, or switch to a model with a larger context.",
      retryable: false,
      raw,
    };
  }

  if (has(lower, "model_not_found", "does not exist", "unknown model", "no such model")) {
    return {
      headline: "The provider does not have that model.",
      next: "Choose another model from the picker beside the composer.",
      destination: "models",
      retryable: false,
      raw,
    };
  }

  if (has(lower, "rate_limit", "rate limit", "too many requests") || /\b429\b/.test(lower)) {
    return {
      headline: "The provider is rate-limiting this key.",
      next: "Wait a moment, then continue.",
      retryable: true,
      raw,
    };
  }

  if (has(lower, "overloaded") || /\b529\b/.test(lower)) {
    return {
      headline: "The provider is overloaded right now.",
      next: "Continue in a moment; nothing is lost.",
      retryable: true,
      raw,
    };
  }

  if (has(lower, "econnrefused", "enotfound", "eai_again", "fetch failed", "network error", "socket hang up", "econnreset")) {
    return {
      headline: "The provider could not be reached.",
      next: "Check the connection — or, for a local model server, that it is running — then continue.",
      retryable: true,
      raw,
    };
  }

  if (has(lower, "etimedout", "timed out", "timeout")) {
    return {
      headline: "The provider took too long to answer.",
      next: "Continue to try again.",
      retryable: true,
      raw,
    };
  }

  if (/\b5(00|02|03|04)\b/.test(lower) || has(lower, "internal server error", "bad gateway", "service unavailable")) {
    return {
      headline: "The provider had a server error.",
      next: "This is on their side. Continue to try again.",
      retryable: true,
      raw,
    };
  }

  // Nothing recognised. The provider's own sentence is still better than its
  // envelope, and the envelope is still there behind the disclosure.
  const sentence = messageIn(text);
  return {
    headline: sentence ?? text,
    retryable: true,
    ...(sentence && sentence !== text ? { raw } : {}),
  };
}
