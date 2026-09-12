import { PRODUCT_NAME } from "@lasercode/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ViewCache } from "../src/views.js";

it("bounds reconstructible views by bytes with LRU recency and releases stale accounting", () => {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-views-`));
  try {
    const paths = ["a", "b", "c"].map(name => join(dir, name));
    for (const path of paths) writeFileSync(path, "session");
    const view = { entries: [{ text: "é".repeat(100) }], leafId: "leaf" };
    const bytes = Buffer.byteLength(JSON.stringify(view));
    const cache = new ViewCache(8, Date.now, bytes * 2);
    cache.set(paths[0]!, view); cache.set(paths[1]!, view);
    expect(cache.bytes).toBe(bytes * 2);
    expect(cache.get(paths[0]!)).toEqual(view);
    cache.set(paths[2]!, view);
    expect(cache.paths()).toEqual([paths[0], paths[2]]);
    expect(cache.get(paths[1]!)).toBeUndefined();
    cache.set(paths[0]!, { entries: ["x".repeat(bytes * 3)] });
    expect(cache.get(paths[0]!)).toBeUndefined();
    expect(cache.bytes).toBe(bytes);
    rmSync(paths[2]!);
    expect(cache.get(paths[2]!)).toBeUndefined();
    expect(cache.bytes).toBe(0);
    cache.set(paths[1]!, view); cache.clear();
    expect(cache.bytes).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
