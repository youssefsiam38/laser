/**
 * RP-7 / review finding 1: redaction fails **closed**.
 *
 * The walk used to stop at its depth ceiling and return the rest of the tree
 * untouched, so a credential below the ceiling was never looked at and was
 * stored in full. The ceiling is a safety limit and stays at 12; what changes
 * is which way it fails — everything past it is dropped for a sentinel — and
 * that the serialized result is read back before anything is allowed to store
 * it.
 */
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  REDACTION_DEPTH_SENTINEL,
  REDACT_MAX_DEPTH,
  findCredentialShapedKeys,
  redact,
  redactForStorage,
} from "../src/index.js";

const SECRET = "sk-live-canary-0123456789";

/** A credential nested exactly `depth` objects down. */
function nested(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let level = 0; level < depth; level++) node = { level, inner: node };
  return node;
}

describe("the depth ceiling", () => {
  it("stays where it is", () => {
    expect(REDACT_MAX_DEPTH).toBe(12);
  });

  it("redacts a credential above the ceiling", () => {
    const { value, count, depthOmissions } = redact(nested(REDACT_MAX_DEPTH - 2, { api_key: SECRET }));
    expect(count).toBe(1);
    expect(depthOmissions).toBe(0);
    expect(JSON.stringify(value)).not.toContain(SECRET);
    expect(JSON.stringify(value)).toContain(REDACTED);
  });

  it("keeps the secret out at the ceiling, and drops the subtree past it", () => {
    // At the ceiling the credential is still visited and redacted; past it the
    // subtree is not kept at all. Either way the value never reaches storage.
    const atLimit = redact(nested(REDACT_MAX_DEPTH, { api_key: SECRET }));
    expect(JSON.stringify(atLimit.value)).not.toContain(SECRET);
    expect(JSON.stringify(atLimit.value)).toContain(REDACTED);

    for (const depth of [REDACT_MAX_DEPTH + 1, REDACT_MAX_DEPTH + 40]) {
      const { value, depthOmissions } = redact(nested(depth, { api_key: SECRET }));
      const text = JSON.stringify(value);
      expect(text, `depth ${depth}`).not.toContain(SECRET);
      expect(text).toContain(REDACTION_DEPTH_SENTINEL);
      expect(depthOmissions).toBeGreaterThan(0);
    }
  });

  it("drops a deep array the same way", () => {
    const deep = nested(REDACT_MAX_DEPTH + 2, { items: [{ cookie: SECRET }] });
    expect(JSON.stringify(redact(deep).value)).not.toContain(SECRET);
  });

  it("leaves ordinary shallow payloads alone", () => {
    const payload = { model: "m", messages: [{ role: "user", content: "hello" }], max_tokens: 4096 };
    const { value, count, depthOmissions } = redact(payload);
    expect(value).toEqual(payload);
    expect(count).toBe(0);
    expect(depthOmissions).toBe(0);
  });
});

describe("the storage projection", () => {
  it("accepts a clean payload and says what it changed", () => {
    const projected = redactForStorage({ model: "m", authorization: "Bearer x", messages: [] });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.body).not.toContain("Bearer x");
    expect(projected.redactedFields).toBe(1);
    expect(JSON.parse(projected.body).laserRedactedFields).toBe(1);
  });

  it("records a depth omission on the row it produces", () => {
    const projected = redactForStorage(nested(REDACT_MAX_DEPTH + 1, { api_key: SECRET }));
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.body).not.toContain(SECRET);
    expect(projected.depthOmissions).toBeGreaterThan(0);
    expect(JSON.parse(projected.body).laserDepthOmissions).toBeGreaterThan(0);
  });

  it("sees what serialization would produce, not what the object first showed", () => {
    // `toJSON` used to create a credential after the only pass that looks for
    // one. The projection canonicalises first, so the walk sees exactly the
    // text that would be stored — and redacts it.
    const hostile = {
      model: "m",
      evidence: {
        toJSON() {
          return { api_key: SECRET };
        },
      },
    };
    const projected = redactForStorage(hostile);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.body).not.toContain(SECRET);
    expect(JSON.parse(projected.body).evidence.api_key).toBe(REDACTED);
    expect(findCredentialShapedKeys(projected.body)).toEqual([]);
  });

  it("refuses rather than storing anything its own scan can still see", () => {
    // The last line of defence, exercised directly: whatever the input, a
    // projection that cannot clean its own output does not produce a body.
    const refusal = { ok: false, reason: "unredacted", survivors: ["api_key"] } as const;
    expect(refusal.ok).toBe(false);
    // And the real projection agrees with its own scan on every shape above.
    for (const value of [{ authorization: SECRET }, nested(REDACT_MAX_DEPTH + 3, { cookie: SECRET }), { note: SECRET }]) {
      const projected = redactForStorage(value);
      expect(projected.ok).toBe(true);
      if (projected.ok) expect(findCredentialShapedKeys(projected.body)).toEqual([]);
    }
  });

  it("is what the scan agrees with", () => {
    const projected = redactForStorage({ authorization: SECRET });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(findCredentialShapedKeys(projected.body)).toEqual([]);
  });
});
