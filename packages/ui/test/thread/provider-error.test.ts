/**
 * A provider's payload becomes a sentence and a next step (R3).
 *
 * Worth a test because two judgements live here and neither is visible from
 * the call site: which failures a person can do something about, and which
 * ones "Continue" would only repeat. Getting the second wrong is what put a
 * "Continue →" button under a rejected API key.
 */
import { describe, expect, it } from "vitest";

import { readProviderFailure } from "../../src/components/thread/provider-error.js";

const ANTHROPIC_401 =
  '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}';

describe("readProviderFailure", () => {
  it("says nothing when there is nothing to read", () => {
    expect(readProviderFailure(undefined)).toBeUndefined();
    expect(readProviderFailure("   ")).toBeUndefined();
  });

  it("turns a rejected key into a sentence, a place to fix it, and no Continue", () => {
    const failure = readProviderFailure(ANTHROPIC_401);
    expect(failure?.headline).toBe("The provider rejected the credential for this model.");
    expect(failure?.destination).toBe("models");
    expect(failure?.retryable).toBe(false);
    // Never thrown away: whoever is debugging a local model server needs it.
    expect(failure?.raw).toBe(ANTHROPIC_401);
  });

  it("offers Continue exactly where sending the same prompt again could work", () => {
    const retryable = ["429 rate_limit_error", "529 overloaded_error", "fetch failed", "ETIMEDOUT", "502 Bad Gateway"];
    for (const detail of retryable) expect(readProviderFailure(detail)?.retryable, detail).toBe(true);

    const pointless = [
      ANTHROPIC_401,
      '{"error":{"message":"Your credit balance is too low"}}',
      "403 permission_error",
      "request (12653 tokens) exceeds the available context size (8192 tokens)",
      "model_not_found",
    ];
    for (const detail of pointless) expect(readProviderFailure(detail)?.retryable, detail).toBe(false);
  });

  it("falls back to the provider's own words rather than its envelope", () => {
    const failure = readProviderFailure('{"error":{"code":"weird","message":"The moon is in the wrong phase."}}');
    expect(failure?.headline).toBe("The moon is in the wrong phase.");
    expect(failure?.retryable).toBe(true);
  });

  it("keeps an unparseable detail intact rather than inventing one", () => {
    const failure = readProviderFailure("something went wrong");
    expect(failure?.headline).toBe("something went wrong");
    expect(failure?.raw).toBeUndefined();
  });
});
