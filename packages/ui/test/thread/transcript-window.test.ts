import { describe, expect, it } from "vitest";
import { HeightIndex, windowRanges } from "../../src/components/thread/transcript-window.js";

describe("measured transcript geometry", () => {
  it("matches a variable-height reference after independent point updates", () => {
    const values = Array.from({ length: 10_000 }, (_, i) => 20 + i % 93);
    const index = new HeightIndex(values);
    for (let i = 0; i < values.length; i += 7) { values[i] = i % 301 + 1; index.update(i, values[i]!); }
    let offset = 0;
    for (let i = 0; i < values.length; i++) {
      expect(index.offset(i)).toBe(offset);
      expect(index.at(offset)).toBe(i);
      expect(index.at(offset + values[i]! - 0.1)).toBe(i);
      offset += values[i]!;
    }
    expect(index.total).toBe(offset);
    expect(index.at(offset)).toBe(values.length - 1);
  });
  it.each([40, 240, 2000, 10000])("bounds mounted rows by viewport distance at %i loaded", count => {
    const index = new HeightIndex(Array.from({ length: count }, () => 100));
    const ranges = windowRanges(index, index.total / 2, 700);
    expect(ranges.reduce((n, range) => n + range.end - range.start, 0)).toBeLessThanOrEqual(22);
    expect(index.offset(ranges[0]!.start)).toBeLessThanOrEqual(index.total / 2 - 700);
    expect(index.offset(ranges.at(-1)!.end)).toBeGreaterThanOrEqual(index.total / 2 + 1400);
  });
  it("has no count cap across very short rows and preserves isolated interaction pins", () => {
    const index = new HeightIndex(Array.from({ length: 10000 }, () => 1));
    const ranges = windowRanges(index, 5000, 700, [2, 3, 9000]);
    expect(ranges).toEqual([{ start: 2, end: 4 }, { start: 4300, end: 6401 }, { start: 9000, end: 9001 }]);
    expect(windowRanges(new HeightIndex([]), 0, 700)).toEqual([]);
  });
});
