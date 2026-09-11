import { describe, expect, it } from "vitest";

import {
  classifyProviderFailure,
  statedResetAt,
  FALLBACK_ELIGIBLE_FAILURES,
  isFallbackEligible,
  MAX_PROVIDER_RESET_MS,
  NON_TRANSIENT_FAILURES,
  parseProviderResetAt,
  PROVIDER_FAILURE_CLASSES,
  type ProviderFailureClass,
  type ProviderFailureSignal,
} from "../src/provider-failure.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

const failed = (signal: Omit<ProviderFailureSignal, "stopReason">): ProviderFailureSignal => ({
  stopReason: "error",
  ...signal,
});

describe("provider failure classification", () => {
  // The table in docs/model-fallback-chains.md §2.4, one case per row, in both
  // of its forms: the structured status a response carried, and the flattened
  // text that is all the engine leaves behind when there was no response.
  const cases: Array<{ why: string; signal: ProviderFailureSignal; expected: ProviderFailureClass }> = [
    {
      why: "401 from the response",
      signal: failed({ response: { status: 401 }, errorMessage: "401 {\"type\":\"error\"}" }),
      expected: "credential",
    },
    {
      why: "the status the SDK put at the front of its own message",
      signal: failed({ errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}' }),
      expected: "credential",
    },
    {
      why: "the status the engine formatted into the message",
      signal: failed({ errorMessage: "Anthropic API error (401): authentication_error" }),
      expected: "credential",
    },
    {
      why: "the same wording with no status at all is not evidence of anything",
      signal: failed({ errorMessage: "authentication_error: API key is invalid." }),
      expected: "unknown",
    },
    {
      why: "403 without usage wording is a permission problem",
      signal: failed({ response: { status: 403 }, errorMessage: "permission_error" }),
      expected: "permission",
    },
    {
      why: "402 is money, whatever it says",
      signal: failed({ response: { status: 402 }, errorMessage: "Payment Required" }),
      expected: "credits",
    },
    {
      why: "insufficient_quota through a 429 is still money",
      signal: failed({ response: { status: 429 }, errorMessage: '{"error":{"code":"insufficient_quota"}}' }),
      expected: "credits",
    },
    {
      why: "a spent subscription window is not an ordinary throttle",
      signal: failed({ response: { status: 429 }, errorMessage: "GoUsageLimitError: Monthly usage limit reached" }),
      expected: "allowance",
    },
    {
      why: "429 without plan wording is a throttle",
      signal: failed({ response: { status: 429 }, errorMessage: "rate limit exceeded" }),
      expected: "rate_limit",
    },
    {
      why: "5xx is the provider, not us",
      signal: failed({ response: { status: 503 }, errorMessage: "Service Unavailable" }),
      expected: "provider_down",
    },
    {
      why: "an overloaded provider, by the status it sent",
      signal: failed({ errorMessage: '529 {"type":"error","error":{"type":"overloaded_error"}}' }),
      expected: "provider_down",
    },
    {
      why: "the word overloaded on its own says nothing about model access",
      signal: failed({ errorMessage: "Provider is overloaded, please try again" }),
      expected: "unknown",
    },
    {
      why: "the SDK's own connection error, which is what a dropped socket looks like",
      signal: failed({ errorMessage: "Connection error." }),
      expected: "connection",
    },
    {
      why: "a refused connection never produces a status",
      signal: failed({ errorMessage: "fetch failed: connect ECONNREFUSED 127.0.0.1:8080" }),
      expected: "connection",
    },
    {
      why: "a dropped stream is a transport failure",
      signal: failed({ errorMessage: "terminated: socket hang up" }),
      expected: "connection",
    },
    {
      why: "404 means this provider does not serve it",
      signal: failed({ response: { status: 404 }, errorMessage: "model_not_found" }),
      expected: "model_missing",
    },
    // The excluded conditions. Each of these must never move a model.
    {
      why: "context overflow belongs to compaction",
      signal: failed({ errorMessage: "This model's maximum context length is 128000 tokens" }),
      expected: "context_overflow",
    },
    {
      why: "a safety refusal is an answer",
      signal: failed({ errorMessage: "Provider finish_reason: content_filter" }),
      expected: "safety",
    },
    {
      why: "a cancelled turn is the person's doing",
      signal: { stopReason: "aborted", errorMessage: "Retry cancelled" },
      expected: "aborted",
    },
    {
      why: "an error we cannot name stays unnamed",
      signal: failed({ errorMessage: "The assistant produced an unusable answer" }),
      expected: "unknown",
    },
    {
      why: "no error text at all is not evidence of anything",
      signal: failed({}),
      expected: "unknown",
    },
  ];

  for (const { why, signal, expected } of cases) {
    it(why, () => {
      expect(classifyProviderFailure(signal).class).toBe(expected);
    });
  }

  // The failures a person meets every day while building a tool schema or
  // sending an unusual field. Each one used to switch the model behind their
  // back and mark the model they chose unusable for the rest of the session.
  const misfires: Array<{ why: string; errorMessage: string }> = [
    { why: "a tool name the provider does not know", errorMessage: "Invalid value: 'assistant'. Tool 'lookup' does not exist" },
    { why: "a role the endpoint does not take", errorMessage: "400 Bad Request: messages[3].role is not allowed for this endpoint" },
    { why: "a schema the provider rejects", errorMessage: "Invalid schema for function: property 'x' is not allowed" },
    { why: "a number that happens to look like a status", errorMessage: "Requested 500 tokens exceeds the per-request cap of 400" },
    { why: "throttle wording with no status", errorMessage: "Rate limit reached. Please check your plan and billing details." },
  ];
  for (const { why, errorMessage } of misfires) {
    it(`does not read model access into ${why}`, () => {
      const failure = classifyProviderFailure(failed({ errorMessage }));
      expect(failure.class, errorMessage).toBe("unknown");
      expect(isFallbackEligible(failure.class)).toBe(false);
    });
  }

  it("reads a request the provider refused as the bad request it is, never as model access", () => {
    for (const status of [400, 409, 413, 422]) {
      expect(classifyProviderFailure(failed({ errorMessage: `${status} Bad Request: something about the payload` })).class, String(status)).toBe("unknown");
    }
  });

  it("only names the classes a chain may act on, and excludes the rest", () => {
    // The specification's exclusions, asserted as a set rather than case by
    // case, so adding a class forces a decision here.
    expect([...FALLBACK_ELIGIBLE_FAILURES].sort()).toEqual(
      ["allowance", "connection", "credential", "credits", "model_missing", "permission", "provider_down", "rate_limit"],
    );
    for (const excluded of ["context_overflow", "safety", "aborted", "unknown"] as const) {
      expect(isFallbackEligible(excluded)).toBe(false);
    }
    for (const mark of NON_TRANSIENT_FAILURES) expect(isFallbackEligible(mark)).toBe(true);
    expect(PROVIDER_FAILURE_CLASSES).toHaveLength(12);
  });

  it("a 200 observed for this attempt does not turn a dropped stream into model access", () => {
    // The response arrived; whatever failed afterwards is not the provider
    // refusing us. The text still decides, and here it says the stream died.
    expect(classifyProviderFailure(failed({ response: { status: 200 }, errorMessage: "stream ended before message_stop" })).class)
      .toBe("connection");
    expect(classifyProviderFailure(failed({ response: { status: 200 }, errorMessage: "something odd" })).class).toBe("unknown");
  });

  it("takes a provider's stated reset time, and never invents one", () => {
    const throttled = classifyProviderFailure(
      failed({ response: { status: 429, headers: { "Retry-After": "120" } }, errorMessage: "rate limit" }),
    );
    expect(throttled.class).toBe("rate_limit");
    expect(Date.parse(throttled.resetAt!) - Date.now()).toBeGreaterThan(110_000);
    // No header: a cooldown is Laser's business, not a fabricated instant.
    expect(classifyProviderFailure(failed({ response: { status: 429 }, errorMessage: "rate limit" })).resetAt).toBeUndefined();
    // A non-transient class carries no reset even when a header is present.
    expect(classifyProviderFailure(failed({ response: { status: 402, headers: { "retry-after": "60" } } })).resetAt)
      .toBeUndefined();
  });
});

describe("provider reset headers", () => {
  const at = (value: Record<string, string>) => parseProviderResetAt(value, NOW);

  it("reads every form providers actually send", () => {
    expect(at({ "retry-after": "30" })).toBe(new Date(NOW + 30_000).toISOString());
    expect(at({ "retry-after-ms": "1500" })).toBe(new Date(NOW + 1_500).toISOString());
    expect(at({ "retry-after": new Date(NOW + 90_000).toUTCString() })).toBe(new Date(NOW + 90_000).toISOString());
    expect(at({ "x-ratelimit-reset-requests": "6m0s" })).toBe(new Date(NOW + 360_000).toISOString());
    expect(at({ "x-ratelimit-reset-tokens": "1.5s" })).toBe(new Date(NOW + 1_500).toISOString());
    expect(at({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 45) })).toBe(new Date(NOW + 45_000).toISOString());
    expect(at({ "anthropic-ratelimit-unified-reset": String(Math.floor(NOW / 1000) + 300) }))
      .toBe(new Date(NOW + 300_000).toISOString());
    // Header names are matched without regard to case, as HTTP requires.
    expect(at({ "ReTrY-AfTeR": "10" })).toBe(new Date(NOW + 10_000).toISOString());
  });

  it("reads a recovery time the provider stated in words, since a failed attempt rarely has headers", () => {
    // The provider SDKs throw on an error status before the engine's response
    // hook runs, so for most failures the sentence is the only evidence there
    // is. An explicit delay counts; "try again later" is not a time.
    expect(statedResetAt("Rate limit reached. Please try again in 20s.", NOW)).toBe(new Date(NOW + 20_000).toISOString());
    expect(statedResetAt("retry after 2 minutes", NOW)).toBe(new Date(NOW + 120_000).toISOString());
    expect(statedResetAt("Please try again in 500ms", NOW)).toBe(new Date(NOW + 500).toISOString());
    expect(statedResetAt("Please try again later", NOW)).toBeUndefined();
    expect(statedResetAt("try again in 48 hours", NOW)).toBeUndefined();
    expect(statedResetAt(undefined, NOW)).toBeUndefined();
    const throttled = classifyProviderFailure(failed({ errorMessage: "429 rate limit reached. Please try again in 30s." }));
    expect(throttled.class).toBe("rate_limit");
    expect(Date.parse(throttled.resetAt!) - Date.now()).toBeGreaterThan(25_000);
  });

  it("ignores what it cannot trust rather than rounding it into a number", () => {
    expect(at({ "retry-after": "soon" })).toBeUndefined();
    expect(at({ "retry-after": "0" })).toBeUndefined();
    expect(at({ "retry-after": "-5" })).toBeUndefined();
    expect(at({ "retry-after": String(MAX_PROVIDER_RESET_MS / 1000 + 60) })).toBeUndefined();
    expect(at({})).toBeUndefined();
    expect(parseProviderResetAt(undefined, NOW)).toBeUndefined();
  });
});
