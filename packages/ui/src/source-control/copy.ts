/**
 * Selecting from a file header into code copies the header's +/− counts.
 * The overlay's copy path starts at the code, never the header.
 */

const HEADER = "[data-diffs-header]";
const LINE = "[data-line]";

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function rangeStartsInHeader(range: Range): boolean {
  const el = elementOf(range.startContainer);
  return Boolean(el?.closest(HEADER));
}

/** Move the range start to the first code line in the same tree. Returns whether it moved. */
export function clipRangeStartToCode(range: Range): boolean {
  if (!rangeStartsInHeader(range)) return false;
  const root = range.startContainer.getRootNode();
  const line = root instanceof Document || root instanceof ShadowRoot ? root.querySelector(LINE) : null;
  if (!line) return false;
  try {
    range.setStart(line, 0);
    return true;
  } catch {
    return false;
  }
}

export function clipSelectionToCode(selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return clipRangeStartToCode(selection.getRangeAt(0));
}
