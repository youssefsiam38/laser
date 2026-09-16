/**
 * The registry behind step 1 (RP-8 milestone F).
 *
 * A cache registers while it is alive and is forgotten when it goes, one that
 * throws never stops another, and a release reports exactly what it dropped —
 * `0` only when there really was nothing.
 */
import { describe, expect, it } from "vitest";

import { ephemeralCacheCount, registerEphemeralCache, releaseEphemeralCaches } from "../../../src/runtime/pressure/ephemeral.js";

describe("the ephemeral cache registry", () => {
  it("releases every registered cache once and sums what they gave back", () => {
    const stop = [
      registerEphemeralCache({ clear: () => ({ count: 2, bytes: 100 }) }),
      registerEphemeralCache({ clear: () => ({ count: 1, bytes: 40 }) }),
    ];
    expect(ephemeralCacheCount()).toBe(2);
    expect(releaseEphemeralCaches()).toEqual({ count: 3, bytes: 140, failures: 0 });
    for (const forget of stop) forget();
    expect(ephemeralCacheCount()).toBe(0);
    expect(releaseEphemeralCaches()).toEqual({ count: 0, bytes: 0, failures: 0 });
  });

  it("counts a cache that throws without letting it stop the others", () => {
    const stop = [
      registerEphemeralCache({ clear: () => { throw new Error("gone"); } }),
      registerEphemeralCache({ clear: () => ({ count: 1, bytes: 8 }) }),
    ];
    expect(releaseEphemeralCaches()).toEqual({ count: 1, bytes: 8, failures: 1 });
    for (const forget of stop) forget();
  });

  it("counts a cache that reports something that is not evidence", () => {
    const stop = registerEphemeralCache({ clear: () => ({ count: -1, bytes: Number.NaN }) });
    expect(releaseEphemeralCaches()).toEqual({ count: 0, bytes: 0, failures: 1 });
    stop();
  });
});
