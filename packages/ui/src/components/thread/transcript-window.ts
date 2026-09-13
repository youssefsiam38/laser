/** Variable-height prefix index. Token/scroll updates never rebuild the tree. */
export class HeightIndex {
  private tree: Float64Array;
  private values: Float64Array;
  constructor(heights: readonly number[]) {
    this.values = Float64Array.from(heights);
    this.tree = new Float64Array(heights.length + 1);
    for (let i = 1; i < this.tree.length; i++) {
      this.tree[i]! += heights[i - 1]!;
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent]! += this.tree[i]!;
    }
  }
  get length() { return this.values.length; }
  height(index: number) { return this.values[index] ?? 0; }
  update(index: number, height: number) {
    if (index < 0 || index >= this.length || !Number.isFinite(height) || height < 0) return;
    const delta = height - this.values[index]!;
    this.values[index] = height;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta;
  }
  offset(end: number): number {
    let value = 0;
    for (let i = Math.min(this.length, Math.max(0, end)); i > 0; i -= i & -i) value += this.tree[i]!;
    return value;
  }
  get total() { return this.offset(this.length); }
  /** Row containing the offset; clamped to the last row at/past the end. */
  at(offset: number): number {
    if (!this.length) return 0;
    let index = 0, sum = 0, step = 1;
    while (step * 2 <= this.length) step *= 2;
    for (; step; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next <= this.length && sum + this.tree[next]! <= offset) { index = next; sum += this.tree[next]!; }
    }
    return Math.min(index, this.length - 1);
  }
}

export interface WindowRange { start: number; end: number }
/** Overscan is a viewport distance, never a row-count cap that can leave holes. */
export function windowRanges(index: HeightIndex, top: number, height: number, pins: readonly number[] = []): WindowRange[] {
  if (!index.length) return [];
  const start = index.at(Math.max(0, top - height));
  const end = Math.min(index.length, index.at(top + height * 2) + 1);
  const ranges = [{ start, end }, ...pins.filter(i => i >= 0 && i < index.length).map(i => ({ start: i, end: i + 1 }))].sort((a, b) => a.start - b.start);
  const merged: WindowRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
