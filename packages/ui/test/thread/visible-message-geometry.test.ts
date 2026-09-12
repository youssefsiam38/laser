// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { visibleMessageGeometry } from "../../src/components/thread/visible-message-geometry.js";

function fixture(heights: number[]) {
  let top = 0;
  const owners = new Map<string, string>();
  const elements = heights.map((height, index) => {
    const element = document.createElement("article");
    element.dataset["messageId"] = String(index);
    owners.set(String(index), String(index - index % 2));
    const box = new DOMRect(0, top, 600, height);
    top += height + 20;
    element.getBoundingClientRect = vi.fn(() => box);
    return element;
  });
  return { elements, owners, height: top };
}
const reference = (elements: HTMLElement[], owners: Map<string, string>, top: number, bottom: number, line: number) => {
  let active: string | undefined;
  const visible: string[] = [];
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    if (box.top >= bottom) break;
    const head = owners.get(element.dataset["messageId"]!)!;
    if (box.top <= line) active = head;
    if (box.bottom > top && !visible.includes(head)) visible.push(head);
  }
  return { active: active ?? owners.values().next().value, visible };
};

describe("conversation-map geometry", () => {
  it("measures a logarithmic neighborhood instead of the preceding 2,000 roots", () => {
    const { elements, owners, height } = fixture(Array(2000).fill(80));
    const expected = reference(elements, owners, height - 600, height, height - 1);
    expect(elements.reduce((n, el) => n + vi.mocked(el.getBoundingClientRect).mock.calls.length, 0)).toBe(2000);
    for (const element of elements) vi.mocked(element.getBoundingClientRect).mockClear();
    expect(visibleMessageGeometry(elements, owners, height - 600, height, height - 1)).toEqual(expected);
    const reads = elements.reduce((n, el) => n + vi.mocked(el.getBoundingClientRect).mock.calls.length, 0);
    expect(reads).toBeLessThanOrEqual(20);
    console.info(`F14: 2000 -> ${reads} rectangle reads`);
  });

  it("matches the original reading identity across gaps, tall bodies, resizing and empty branches", () => {
    for (const heights of [[80, 5000, 20, 800, 40], [80, 40, 20, 800, 40], []]) {
      const { elements, owners, height } = fixture(heights);
      for (let top = -10; top <= height; top += 17) for (const descent of [1, 150, 600]) {
        expect(visibleMessageGeometry(elements, owners, top, top + 600, top + descent))
          .toEqual(reference(elements, owners, top, top + 600, top + descent));
      }
    }
  });
});
