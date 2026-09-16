/**
 * RP-7: what may be released when a connection is behind, and what a capture
 * message is. Both are contracts other packages depend on being exhaustive.
 */
import { describe, expect, it } from "vitest";
import {
  CAPTURE_CHUNKED_ABOVE_BYTES,
  CAPTURE_MAX_BYTES,
  NOTIFICATION_PRESSURE,
  PROVIDER_CAPTURE_MESSAGE_TYPES,
  NOTIFICATION_SCOPE,
  findCredentialShapedKeys,
  isProviderCaptureId,
  isProviderCaptureMessage,
  isSheddable,
  redact,
} from "../src/index.js";

describe("what may be shed", () => {
  it("classifies every host notification", () => {
    // The two tables are compiler-complete over the same union; if one gains a
    // key the other must decide about it too.
    expect(Object.keys(NOTIFICATION_PRESSURE).sort()).toEqual(Object.keys(NOTIFICATION_SCOPE).sort());
  });

  it("sheds exactly the notifications a client can read back", () => {
    const sheddable = Object.entries(NOTIFICATION_PRESSURE)
      .filter(([, value]) => value === "diagnostic")
      .map(([method]) => method)
      .sort();
    // RP-8's `resource/pressure` joined the list: `resource/snapshot` carries
    // the same pressure summary, so losing the push costs a client nothing it
    // cannot ask for again.
    expect(sheddable).toEqual(["pi/logs/append", "pi/packages/progress", "resource/pressure", "resource/refresh_request"]);
  });

  it("never sheds state, questions, tasks, runs or a login step", () => {
    for (const method of [
      "session/update",
      "pi/ui/request",
      "pi/ui/event",
      "tasks/update",
      "agents/run",
      "agents/event",
      "pi/session/attention",
      "pi/providers/login/event",
      "pi/project/trust_request",
    ]) {
      expect(isSheddable(method), method).toBe(false);
    }
    expect(isSheddable("pi/logs/append")).toBe(true);
    // An unknown method is never sheddable: silence is not a default.
    expect(isSheddable("something/new")).toBe(false);
  });
});

describe("capture messages", () => {
  it("names every message that carries or stands in for a request body", () => {
    // begin, chunk, end, abort, omitted, and the small-path request/response.
    expect(PROVIDER_CAPTURE_MESSAGE_TYPES).toHaveLength(7);
    for (const type of PROVIDER_CAPTURE_MESSAGE_TYPES) {
      expect(isProviderCaptureMessage({ type })).toBe(true);
    }
    expect(isProviderCaptureMessage({ type: "lasercode/task/update" })).toBe(false);
    expect(isProviderCaptureMessage(null)).toBe(false);
    expect(isProviderCaptureMessage({})).toBe(false);
  });

  it("accepts only opaque bounded capture ids", () => {
    expect(isProviderCaptureId("c-0123456789abcdef", 64)).toBe(true);
    expect(isProviderCaptureId("", 64)).toBe(false);
    expect(isProviderCaptureId("c-".padEnd(80, "a"), 64)).toBe(false);
    expect(isProviderCaptureId("../etc/passwd", 64)).toBe(false);
    expect(isProviderCaptureId(42, 64)).toBe(false);
  });

  it("keeps the chunking threshold below the ceiling it protects", () => {
    expect(CAPTURE_CHUNKED_ABOVE_BYTES).toBeLessThan(CAPTURE_MAX_BYTES);
  });
});

describe("the shared credential projection", () => {
  it("redacts credential-shaped keys and counts them", () => {
    const { value, count } = redact({
      authorization: "Bearer secret",
      "x-api-key": "k",
      max_tokens: 4096,
      nested: { cookie: "a=b", thinkingBudgets: 1 },
    });
    expect(count).toBe(3);
    expect(value).toEqual({
      authorization: "[redacted]",
      "x-api-key": "[redacted]",
      max_tokens: 4096,
      nested: { cookie: "[redacted]", thinkingBudgets: 1 },
    });
  });

  it("finds a credential-shaped survivor in serialized text, by key only", () => {
    const found = findCredentialShapedKeys(JSON.stringify({ messages: [], api_key: "sk-live-1234" }));
    expect(found).toEqual(["api_key"]);
    // The value is never part of what a defence reports.
    expect(found.join("")).not.toContain("sk-live");
  });

  it("accepts text that is already redacted", () => {
    const { value } = redact({ authorization: "Bearer x", messages: [{ role: "user" }] });
    expect(findCredentialShapedKeys(JSON.stringify(value))).toEqual([]);
  });

  it("does not mistake ordinary payload fields for credentials", () => {
    expect(findCredentialShapedKeys(JSON.stringify({ max_tokens: 1, reserveTokens: 2, thinkingBudgets: 3 }))).toEqual([]);
  });
});
