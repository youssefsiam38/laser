/** Read only the viewport neighborhood of an ordered, non-overlapping message
 * list. Message roots remain in normal vertical flow (including tall tools).
 * The caller owns scrolling and mounting; this is not another scroll controller.
 */
export function visibleMessageGeometry(
  elements: readonly HTMLElement[],
  owners: ReadonlyMap<string, string>,
  top: number,
  bottom: number,
  readingLine: number,
): { active: string | undefined; visible: string[] } {
  const boxes = new Map<number, DOMRect>();
  const boxAt = (index: number) => {
    let box = boxes.get(index);
    if (!box) { box = elements[index]!.getBoundingClientRect(); boxes.set(index, box); }
    return box;
  };
  let low = 0, high = elements.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (boxAt(mid).top < top) low = mid + 1;
    else high = mid;
  }
  let active: string | undefined;
  const visible: string[] = [];
  // The preceding root may be taller than the viewport, or own the reading
  // line in a gap. No earlier root can intersect this one in normal flow.
  for (let index = Math.max(0, low - 1); index < elements.length; index++) {
    const box = boxAt(index);
    if (box.top >= bottom) break;
    const id = elements[index]!.dataset["messageId"];
    const head = id === undefined ? undefined : owners.get(id);
    if (head === undefined) continue;
    if (box.top <= readingLine) active = head;
    if (box.bottom > top && !visible.includes(head)) visible.push(head);
  }
  return { active: active ?? owners.values().next().value, visible };
}
